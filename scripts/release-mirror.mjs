import {mkdir,readFile,rename,rm,realpath,lstat,open,symlink} from "node:fs/promises";
import {createWriteStream,createReadStream} from "node:fs";
import {createHash,randomUUID} from "node:crypto";
import {Readable,Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {verifyManifest} from "../updates/security.mjs";
import {releaseAssetUrl,releaseComponents} from "../updates/release.mjs";

async function hashFile(file){const hash=createHash("sha256");for await(const b of createReadStream(file))hash.update(b);return hash.digest("hex");}
async function syncDir(dir){if(process.platform==="win32")return;const handle=await open(dir,"r");try{await handle.sync();}finally{await handle.close();}}
async function smallJson(response){
  if(!response.ok)throw new Error(`Mirror HTTP ${response.status}`);
  const chunks=[];let size=0;for await(const bytes of response.body){size+=bytes.length;if(size>262144)throw new Error("Oversized release metadata");chunks.push(bytes);}return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function mirrorRelease({root,key,repository="lezebomb/stopwatch",origin="https://fym.lezebomb.top",request=fetch}) {
  if(!path.isAbsolute(root)||!/^[-\w.]+\/[-\w.]+$/.test(repository))throw new Error("Invalid mirror identity");
  const cfg={productionOrigin:origin,artifactBaseUrl:origin+"/updates"};
  await mkdir(root,{recursive:true,mode:0o700});root=await realpath(root);
  const stage=path.join(root,".staging-"+randomUUID());
  try {
    const release=await smallJson(await request(`https://api.github.com/repos/${repository}/releases/latest`,{headers:{Accept:"application/vnd.github+json"},signal:AbortSignal.timeout(20000)}));
    const tag=release.tag_name;
    if(release.draft||release.prerelease||!/^v\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(tag))throw new Error("Stable release required");
    const previous=await readFile(path.join(root,"current.json"),"utf8").then(JSON.parse).catch(e=>{if(e.code==="ENOENT")return null;throw e;});
    const stable=await readFile(path.join(root,"stable","firmware-manifest.json"),"utf8").then(JSON.parse).catch(e=>{if(e.code==="ENOENT")return null;throw e;});
    const durableSequence=stable?verifyManifest(stable,key,{kind:"firmware"}).sequence:0;
    // Never trust the pointer alone when deciding a release is already mirrored.
    const manifests={};let sequence,identity;
    for(const [kind,[asset,manifest]] of Object.entries(releaseComponents)){
      const metadata=release.assets.filter(a=>a.name===manifest);
      if(metadata.length!==1||metadata[0].size>16384)throw new Error("Missing or oversized signed manifest");
      const signed=await smallJson(await request(`https://github.com/${repository}/releases/download/${tag}/${manifest}`,{signal:AbortSignal.timeout(20000)}));
      const payload=verifyManifest(signed,key,{kind,portalOrigin:origin});
      if(payload.version!==tag.slice(1)||payload.url!==releaseAssetUrl(cfg,repository,tag,asset))throw new Error("Mirror release URL/version mismatch");
      const id=`${payload.sequence}/${payload.buildId}/${payload.publishedAt}`;
      if(identity&&id!==identity)throw new Error("Mixed release identity");identity=id;sequence=payload.sequence;
      const uploaded=release.assets.filter(a=>a.name===asset);
      if(uploaded.length!==1||uploaded[0].size!==payload.size||uploaded[0].digest!==`sha256:${payload.sha256}`)throw new Error("GitHub asset identity mismatch");
      manifests[kind]={signed,payload,asset,manifest};
    }
    if(sequence<Math.max(previous?.sequence||0,durableSequence))throw new Error("Mirror rollback rejected");
    if(previous&&sequence===previous.sequence&&previous.tag!==tag)throw new Error("Mirror sequence collision");
    await mkdir(path.join(root,"releases"),{recursive:true,mode:0o700});
    const final=path.join(root,"releases",tag);
    const exists=await lstat(final).catch(e=>{if(e.code==="ENOENT")return null;throw e;});
    if(exists){
      if(!exists.isDirectory()||exists.isSymbolicLink())throw new Error("Unsafe existing release");
      for(const item of Object.values(manifests)){
        if(await hashFile(path.join(final,item.asset))!==item.payload.sha256||
           JSON.stringify(JSON.parse(await readFile(path.join(final,item.manifest),"utf8")))!==JSON.stringify(item.signed))throw new Error("Immutable mirror differs");
      }
      if(previous?.identity===identity && await realpath(path.join(root,"stable"))===final)
        return {tag,sequence,verifiedComponents:4,unchanged:true};
    }else{
      await mkdir(stage,{mode:0o700});
      for(const item of Object.values(manifests)){
        const response=await request(`https://github.com/${repository}/releases/download/${tag}/${item.asset}`,{signal:AbortSignal.timeout(180000)});
        if(!response.ok)throw new Error(`Asset HTTP ${response.status}`);
        const hash=createHash("sha256");let size=0;
        const count=new Transform({transform(bytes,_enc,done){size+=bytes.length;if(size>item.payload.size)return done(new Error("Asset exceeds signed size"));hash.update(bytes);done(null,bytes);}});
        const output=path.join(stage,item.asset);
        await pipeline(Readable.fromWeb(response.body),count,createWriteStream(output,{flags:"wx",mode:0o600}));
        if(size!==item.payload.size||hash.digest("hex")!==item.payload.sha256)throw new Error("Asset SHA-256/size mismatch");
        for(const [file,content] of [[output,null],[path.join(stage,item.manifest),JSON.stringify(item.signed)]]){
          const handle=await open(file,content===null?"r+":"wx",0o600);try{if(content!==null)await handle.writeFile(content);await handle.sync();}finally{await handle.close();}
        }
      }
      await syncDir(stage);await rename(stage,final);await syncDir(path.join(root,"releases"));
    }
    const pointer=path.join(root,".stable-"+randomUUID());
    await symlink(process.platform==="win32"?final:path.join("releases",tag),pointer,process.platform==="win32"?"junction":"dir");await rename(pointer,path.join(root,"stable"));await syncDir(root);
    const pending=path.join(root,".current-"+randomUUID());const handle=await open(pending,"wx",0o600);
    try{await handle.writeFile(JSON.stringify({tag,sequence,identity}));await handle.sync();}finally{await handle.close();}
    await rename(pending,path.join(root,"current.json"));await syncDir(root);
    return {tag,sequence,verifiedComponents:4};
  }finally{if(path.dirname(stage)!==root)throw new Error("Unsafe staging cleanup");await rm(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,all)=>i%2?a:[...a,[v.slice(2),all[i+1]]],[]));
  if(!args.root||!args.key)throw new Error("--root and pinned --key required");
  if(process.platform!=="linux")throw new Error("The production mirror CLI requires Linux flock/fsync");
  if(!path.isAbsolute(args.root))throw new Error("Absolute mirror root required");
  if(args["lock-held"]!=="1"){
    await mkdir(args.root,{recursive:true,mode:0o700});
    const child=spawnSync("flock",["--nonblock",path.join(args.root,".mirror.lock"),process.execPath,process.argv[1],...process.argv.slice(2),"--lock-held","1"],{stdio:"inherit"});
    if(child.error)throw child.error;process.exit(child.status??1);
  }
  console.log(JSON.stringify(await mirrorRelease({root:args.root,key:await readFile(args.key),origin:args.origin||"https://fym.lezebomb.top"})));
}
