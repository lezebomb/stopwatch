import {createReadStream} from "node:fs";
import {realpath,stat} from "node:fs/promises";
import path from "node:path";

const assets = "(?:firmware-manifest\\.json|miao-manifest\\.json|bridge-manifest\\.json|portal-manifest\\.json|stopwatch-firmware\\.bin|miao\\.pack|stopwatch-bridge\\.mjs|stopwatch-portal\\.tar\\.gz)";
const allowed = new RegExp(`^/updates/(stable|releases/v\\d{1,5}\\.\\d{1,5}\\.\\d{1,5})/(${assets})$`);
/* Public signed program assets only. Private album/data APIs stay separate. */
export async function serveUpdate(req,res,directory) {
  const url=new URL(req.url,"http://localhost");
  if(!url.pathname.startsWith("/updates/"))return false;
  const fail=code=>{res.writeHead(code,{"Cache-Control":"no-store"});res.end();return true;};
  if(!directory)return fail(404);
  if(!["GET","HEAD"].includes(req.method))return fail(405);
  const match=allowed.exec(url.pathname);
  if(!match)return fail(404);
  let root,file,info;
  try {
    root=await realpath(directory);file=await realpath(path.join(root,match[1],match[2]));
    if(!file.startsWith(root+path.sep))return fail(403);
    info=await stat(file);if(!info.isFile())return fail(404);
  }catch(error){if(error.code==="ENOENT")return fail(404);throw error;}
  let start=0,end=info.size-1,code=200;
  const headers={"Content-Type":file.endsWith(".json")?"application/json":"application/octet-stream",
    "Cache-Control":match[1]==="stable"?"no-store":"public,max-age=31536000,immutable",
    "Accept-Ranges":"bytes","X-Content-Type-Options":"nosniff"};
  if(req.headers.range){
    const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    start=Number(range?.[1]);end=range?.[2]?Number(range[2]):end;
    if(!range||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=info.size){
      res.writeHead(416,{...headers,"Content-Range":`bytes */${info.size}`});res.end();return true;
    }
    code=206;headers["Content-Range"]=`bytes ${start}-${end}/${info.size}`;
  }
  headers["Content-Length"]=end-start+1;res.writeHead(code,headers);
  if(req.method==="HEAD")res.end();
  else {const stream=createReadStream(file,{start,end,highWaterMark:65536});stream.on("error",()=>res.destroy());res.once("close",()=>stream.destroy());stream.pipe(res);}
  return true;
}
