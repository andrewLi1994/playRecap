const encoder = new TextEncoder();
const MIME = {mp3:'audio/mpeg',m4a:'audio/mp4',mp4:'audio/mp4',aac:'audio/aac',wav:'audio/wav',ogg:'audio/ogg',opus:'audio/ogg',flac:'audio/flac'};
const STATIC = new Set(['/','/index.html','/script.js','/styles.css','/icon.svg','/manifest.webmanifest','/apple-touch-icon.png','/icon-192.png','/icon-512.png']);
const MAX_FILE = 80 * 1024 * 1024;
const MAX_LIBRARY = 8 * 1000 ** 3; // Application guardrail, not an account billing cap.
const security = {
 'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
function json(value,status=200,extra={}) {
 return new Response(JSON.stringify(value),{status,headers:{...security,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}});
}
async function digest(value) {
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function key(secret) {return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
async function signed(secret,expiry) {
 const signature = await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(expiry));
 return [...new Uint8Array(signature)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function authenticated(request,secret) {
 const match = (request.headers.get('Cookie')||'').match(/(?:^|;\s*)recap_session=(\d+)\.([a-f0-9]{64})(?:;|$)/);
 if(!match || Number(match[1])*1000<=Date.now())return false;
 return crypto.subtle.verify('HMAC',await key(secret),new Uint8Array(match[2].match(/../g).map(x=>parseInt(x,16))),encoder.encode(match[1]));
}
function cleanName(value) {
 const name=decodeURIComponent(value||'').trim();
 if(!name || name.startsWith('.') || encoder.encode(name).length>220 || /[\/\\\x00-\x1f]/.test(name))throw Error('书名或文件名无效。');
 return name;
}
async function objects(bucket) {
 let result=[],cursor;
 do {
  const page=await bucket.list({prefix:'audio/',limit:1000,include:['customMetadata'],...(cursor?{cursor}:{})});
  result.push(...page.objects);cursor=page.truncated?page.cursor:null;
 }while(cursor);
 return result;
}
async function catalog(bucket) {
 const groups=new Map();
 for(const object of await objects(bucket)) {
  const meta=object.customMetadata;
  if(!meta?.book || !meta?.filename)continue;
  const bid=(await digest(meta.book)).slice(0,24);
  if(!groups.has(bid))groups.set(bid,{id:bid,title:meta.book,chapters:[]});
  const title=meta.filename.replace(/\.[^.]+$/,'').replace(/^\d{5} - /,'').replace(/ \[[A-Za-z0-9_-]{11}\]$/,'');
  const id=object.key.slice(6);
  groups.get(bid).chapters.push({id,title,url:'/media/'+id,bytes:object.size,filename:meta.filename});
 }
 const books=[...groups.values()].sort((a,b)=>a.title.localeCompare(b.title,'zh-CN',{numeric:true}));
 for(const book of books) {
  book.chapters.sort((a,b)=>a.filename.localeCompare(b.filename,'zh-CN',{numeric:true}));
  for(const chapter of book.chapters)delete chapter.filename;
 }
 return {books};
}
async function route(request,env) {
 const url=new URL(request.url),pathname=url.pathname;
 if(STATIC.has(pathname)&&['GET','HEAD'].includes(request.method)) {
  const asset=await env.ASSETS.fetch(request);
  const response=new Response(asset.body,asset);
  for(const [k,v]of Object.entries(security))response.headers.set(k,v);
  return response;
 }
 if(!env.ACCESS_CODE || env.ACCESS_CODE.length<20)return json({error:'书库尚未完成口令配置。'},503);
 if(pathname==='/api/session' && request.method==='GET')return json({authenticated:await authenticated(request,env.ACCESS_CODE)});
 if(request.method==='POST') {
  if(request.headers.get('X-Recap-Request')!=='1')return json({error:'请求来源无效。'},403);
  const origin=request.headers.get('Origin');
  if(origin && origin!==url.origin)return json({error:'请求来源无效。'},403);
  if(pathname==='/api/login') {
   const allowed=await env.LOGIN_LIMITER.limit({key:request.headers.get('CF-Connecting-IP')||'unknown'});
   if(!allowed.success)return json({error:'尝试太频繁，请一分钟后重试。'},429);
   const length=Number(request.headers.get('Content-Length'));
   if(!length || length>8192)return json({error:'请求过大。'},400);
   const data=await request.json();
   if(typeof data.code!=='string'||data.code.length>128)return json({error:'口令不正确。'},401);
   const actual=await digest(data.code),expected=await digest(env.ACCESS_CODE);
   let difference=0;for(let i=0;i<actual.length;i++)difference|=actual.charCodeAt(i)^expected.charCodeAt(i);
   if(difference)return json({error:'口令不正确。'},401);
   const expiry=String(Math.floor(Date.now()/1000)+30*86400);
   return json({ok:true},200,{'Set-Cookie':`recap_session=${expiry}.${await signed(env.ACCESS_CODE,expiry)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`});
  }
 }
 if(!await authenticated(request,env.ACCESS_CODE))return json({error:'请先输入私人访问口令。'},401);
 if(pathname==='/api/logout' && request.method==='POST')return json({ok:true},200,{'Set-Cookie':'recap_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});
 if(pathname==='/api/library' && request.method==='GET')return json(await catalog(env.AUDIO));
 if(pathname==='/api/upload' && request.method==='POST') {
  const book=cleanName(request.headers.get('X-Book-Name')),filename=cleanName(request.headers.get('X-File-Name'));
  const extension=filename.split('.').pop().toLowerCase();
  if(!MIME[extension])return json({error:'请选择音频文件。'},400);
  const size=Number(request.headers.get('Content-Length'));
  if(!Number.isSafeInteger(size)||size<=0||size>MAX_FILE)return json({error:'在线版每个音频文件需小于 80 MB。'},413);
  const used=(await objects(env.AUDIO)).reduce((sum,o)=>sum+o.size,0);
  if(used+size>MAX_LIBRARY)return json({error:'书库已达到 8 GB 保护上限，请先整理音频。'},413);
  const id=(await digest(`${book}/${filename}`)).slice(0,24);
  const created=await env.AUDIO.put('audio/'+id,request.body,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:MIME[extension]},customMetadata:{book,filename}});
  return created?json({ok:true},201):json({error:'同名章节已存在，未覆盖原文件。'},409);
 }
 if(/^\/media\/[a-f0-9]{24}$/.test(pathname)&&['GET','HEAD'].includes(request.method)) {
  const key='audio/'+pathname.slice(7),metadata=await env.AUDIO.head(key);
  if(!metadata)return json({error:'文件不存在。'},404);
  const size=metadata.size,range=request.headers.get('Range');let start=0,end=size-1,status=200;
  const invalid=()=>json({},416,{'Content-Range':`bytes */${size}`});
  if(range) {
   const match=range.match(/^bytes=(\d*)-(\d*)$/);
   if(!match||(!match[1]&&!match[2]))return invalid();
   if(!match[1]){const count=Number(match[2]);if(count<=0)return invalid();start=Math.max(0,size-count);}
   else {start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),size-1);}
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return invalid();
   status=206;
  }
  const headers={...security,'Content-Type':metadata.httpMetadata?.contentType||'application/octet-stream','Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'private, no-store'};
  if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  if(request.method==='HEAD')return new Response(null,{status,headers});
  const object=await env.AUDIO.get(key,{range:{offset:start,length:end-start+1}});
  if(!object)return json({error:'文件不存在。'},404);
  return new Response(object.body,{status,headers});
 }
 return json({error:'接口不存在。'},404);
}
export default {
 async fetch(request,env) {
  try{return await route(request,env);}
  catch(error){return json({error:error instanceof URIError?'书名或文件名无效。':'请求未完成，请稍后重试。'},400);}
 }
};
