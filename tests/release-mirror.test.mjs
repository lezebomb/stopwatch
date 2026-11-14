import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,mkdir,rm,symlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {generateKeyPairSync} from "node:crypto";
import http from "node:http";
import config from "../release/config.json" with {type:"json"};
import {signedManifest,sha256,verifyManifest} from "../updates/security.mjs";
import {releaseAssetUrl,releaseComponents,annotatedReleaseTime} from "../updates/release.mjs";
import {mirrorRelease} from "../scripts/release-mirror.mjs";
import {serveUpdate} from "../server/update-files.mjs";
const key=generateKeyPairSync("rsa",{modulusLength:3072});
const origin=config.productionOrigin;
test("release preflight verifies remote annotation despite a peeled local checkout",()=>{
  const sha="c".repeat(40),build="d".repeat(40),ref={object:{type:"tag",sha}},annotation={sha,tag:"v0.2.3",tagger:{date:"2026-11-14T08:00:00Z"},object:{type:"commit",sha:build}};
  assert.equal(annotatedReleaseTime(ref,annotation,"v0.2.3",build),"2026-11-14T08:00:00.000Z");
  assert.throws(()=>annotatedReleaseTime({object:{type:"commit",sha:build}},annotation,"v0.2.3",build),/Annotated/);
  assert.throws(()=>annotatedReleaseTime(ref,annotation,"v0.2.3","e".repeat(40)),/Annotated/);
});
function fixture(version="0.2.1"){
  const data=new Map(),assets=[],tag="v"+version,publishedAt=new Date(Date.now()-60000).toISOString();
  for(const [kind,[name,manifest]] of Object.entries(releaseComponents)){
    const bytes=Buffer.from(kind+version);
    const compatibility=kind==="firmware"?{partitionLayout:config.partitionLayout,dataSchema:1,idf:"6.0.3"}:kind==="miao"?{dataSchema:1,encoding:"MIA1",layoutSha256:"b".repeat(64)}:kind==="bridge"?{protocol:1,nodeMajor:24}:{dataSchema:1,nodeMajor:24,origin};
    const payload={schema:1,kind,channel:"stable",version,sequence:100+Number(version.split(".")[2]),buildId:"a".repeat(40),size:bytes.length,sha256:sha256(bytes),publishedAt,hardware:kind==="bridge"?"windows-x64":kind==="portal"?"linux-x64":config.hardware,compatibility,url:releaseAssetUrl(config,"lezebomb/stopwatch",tag,name)};
    data.set(name,bytes);data.set(manifest,Buffer.from(JSON.stringify(signedManifest(payload,key.privateKey))));
    assets.push({name,size:bytes.length,digest:"sha256:"+sha256(bytes)},{name:manifest,size:data.get(manifest).length});
  }
  const release={tag_name:tag,assets,draft:false,prerelease:false};
  return {data,request:async url=>new Response(String(url).includes("api.github.com")?JSON.stringify(release):data.get(new URL(url).pathname.split("/").at(-1)),{status:200})};
}
async function temp(fn){const root=await mkdtemp(path.join(os.tmpdir(),"stopwatch-release-"));try{await fn(root);}finally{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}}
test("signed release mirror is complete, immutable and idempotent",()=>temp(async root=>{
  const f=fixture(),options={root,key:key.publicKey,request:f.request};
  assert.equal((await mirrorRelease(options)).verifiedComponents,4);
  assert.equal((await mirrorRelease(options)).unchanged,true);
  assert.equal(await readFile(path.join(root,"stable","stopwatch-firmware.bin"),"utf8"),"firmware0.2.1");
  await writeFile(path.join(root,"releases/v0.2.1/miao.pack"),"tampered");
  await assert.rejects(mirrorRelease(options),/Immutable mirror differs/);
}));
test("partial/corrupt next release never replaces the active signed mirror",()=>temp(async root=>{
  const first=fixture();await mirrorRelease({root,key:key.publicKey,request:first.request});
  const next=fixture("0.2.2");next.data.set("miao.pack",Buffer.from("wrong"));
  await assert.rejects(mirrorRelease({root,key:key.publicKey,request:next.request}),/SHA-256|signed size/);
  assert.equal(verifyManifest(JSON.parse(await readFile(path.join(root,"stable/firmware-manifest.json"),"utf8")),key.publicKey,{kind:"firmware"}).version,"0.2.1");
}));
test("durable signed pointer rejects rollback even after metadata loss",()=>temp(async root=>{
  const next=fixture("0.2.2");await mirrorRelease({root,key:key.publicKey,request:next.request});
  await rm(path.join(root,"current.json"));const old=fixture("0.2.1");
  await assert.rejects(mirrorRelease({root,key:key.publicKey,request:old.request}),/rollback/);
  assert.throws(()=>releaseAssetUrl({...config,artifactBaseUrl:"https://evil.invalid/updates"},"lezebomb/stopwatch","v0.2.1","miao.pack"),/reviewed/);
}));
test("Linux publication atomically promotes all components and retains the old release",{skip:process.platform!=="linux"},()=>temp(async root=>{
  const first=fixture();await mirrorRelease({root,key:key.publicKey,request:first.request});
  const next=fixture("0.2.2");await mirrorRelease({root,key:key.publicKey,request:next.request});
  for(const [kind,[name]] of Object.entries(releaseComponents))
    assert.equal(await readFile(path.join(root,"stable",name),"utf8"),kind+"0.2.2");
  assert.equal(await readFile(path.join(root,"releases/v0.2.1/stopwatch-firmware.bin"),"utf8"),"firmware0.2.1");
}));
test("public release serving supports bounded ranges and cannot expose private files",()=>temp(async root=>{
  await mkdir(path.join(root,"releases/v0.2.1"),{recursive:true});
  await writeFile(path.join(root,"releases/v0.2.1/stopwatch-firmware.bin"),"0123456789");
  const server=http.createServer((req,res)=>serveUpdate(req,res,root).then(handled=>{if(!handled){res.statusCode=404;res.end();}}));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const url=`http://127.0.0.1:${server.address().port}`;
  try{
    const response=await fetch(url+"/updates/releases/v0.2.1/stopwatch-firmware.bin",{headers:{Range:"bytes=2-4"}});assert.equal(response.status,206);assert.equal(await response.text(),"234");
    assert.equal((await fetch(url+"/updates/releases/v0.2.1/stopwatch-firmware.bin",{headers:{Range:"bytes=99-"}})).status,416);
    assert.equal((await fetch(url+"/updates/stable/production.env")).status,404);
    assert.equal((await fetch(url+"/updates/releases/v0.2.1/stopwatch-firmware.bin",{method:"POST"})).status,405);
  }finally{await new Promise(resolve=>server.close(resolve));}
}));
