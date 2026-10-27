import { createServer } from 'node:http';
import { readFile,stat } from 'node:fs/promises';
import { dirname,resolve,extname,sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.MERLIN_STUDIO_PORT||3310);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.glb':'model/gltf-binary','.png':'image/png','.mp4':'video/mp4','.md':'text/plain; charset=utf-8','.blend':'application/octet-stream'};
const server=createServer(async(req,res)=>{
  try{
    if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host))throw new Error('Local access only');
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
    const url=new URL(req.url,'http://127.0.0.1:'+port);
    let path=decodeURIComponent(url.pathname);
    if(path==='/'){res.writeHead(302,{Location:'/viewer/'});res.end();return;}
    if(path==='/viewer/')path='/viewer/index.html';
    const allowed=path.startsWith('/viewer/')||['/merlin-states.blend','/merlin-states.glb','/states.json','/merlin-interactions.glb','/interactions.json'].includes(path);
    const file=resolve(ROOT,'.'+path);
    if(!allowed||!file.startsWith(ROOT+sep)||(path.startsWith('/viewer/')&&!file.startsWith(resolve(ROOT,'viewer')+sep)))throw new Error('Not found');
    const info=await stat(file);if(!info.isFile())throw new Error('Not found');
    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' blob:; img-src 'self' blob: data:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'self'; base-uri 'none'"});
    res.end(req.method==='HEAD'?undefined:await readFile(file));
  }catch{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found.');}
});
server.listen(port,'127.0.0.1',()=>console.log('MERLIN character studio: http://127.0.0.1:'+port+'/viewer/'));
