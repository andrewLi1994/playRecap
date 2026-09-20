import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.mjs';
class Bucket {
 objects=new Map();
 async list(){return {objects:[...this.objects.values()],truncated:false};}
 async head(key){return this.objects.get(key)||null;}
 async put(key,body,options){
  if(options.onlyIf.get('If-None-Match')==='*'&&this.objects.has(key))return null;
  const bytes=new Uint8Array(await new Response(body).arrayBuffer());
  const value={key,size:bytes.length,bytes,...options};this.objects.set(key,value);return value;
 }
 async get(key,{range}){const value=this.objects.get(key);return value?{...value,body:value.bytes.slice(range.offset,range.offset+range.length)}:null;}
}
function environment(){return {ACCESS_CODE:'a-very-long-test-code-for-local-tests',AUDIO:new Bucket(),LOGIN_LIMITER:{limit:async()=>({success:true})},ASSETS:{fetch:async()=>new Response('<html>Login</html>')}};}
async function call(env,path,options={}){return worker.fetch(new Request('https://test.example'+path,options),env);}
async function login(env){const body=JSON.stringify({code:env.ACCESS_CODE});const response=await call(env,'/api/login',{method:'POST',headers:{'X-Recap-Request':'1','Content-Length':String(body.length)},body});assert.equal(response.status,200);assert.match(response.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Strict/);return response.headers.get('Set-Cookie').split(';')[0];}
async function upload(env,cookie,name='01.m4a',book='Book',body='abcdefghij'){
 return call(env,'/api/upload',{method:'POST',headers:{Cookie:cookie,'X-Recap-Request':'1','X-Book-Name':encodeURIComponent(book),'X-File-Name':encodeURIComponent(name),'Content-Length':String(body.length)},body});
}
test('Cloud worker refuses unauthenticated media and cross-origin writes',async()=>{
 const env=environment();assert.equal((await call(env,'/media/'+'a'.repeat(24))).status,401);
 assert.equal((await call(env,'/api/login',{method:'POST',headers:{'X-Recap-Request':'1',Origin:'https://other.example'},body:'{}'})).status,403);
 env.LOGIN_LIMITER.limit=async()=>({success:false});assert.equal((await call(env,'/api/login',{method:'POST',headers:{'X-Recap-Request':'1'},body:'{}'})).status,429);
});
test('Cloud uploads preserve originals, sort chapters and stream Range/HEAD',async()=>{
 const env=environment(),cookie=await login(env);
 for(const name of ['10.m4a','02.m4a','01.m4a'])assert.equal((await upload(env,cookie,name)).status,201);
 assert.equal((await upload(env,cookie)).status,409);
 assert.equal((await upload(env,cookie,'../bad.m4a')).status,400);
 const library=await (await call(env,'/api/library',{headers:{Cookie:cookie}})).json();
 assert.deepEqual(library.books[0].chapters.map(c=>c.title),['01','02','10']);const url=library.books[0].chapters[0].url;
 for(const [range,content]of [['bytes=0-1','ab'],['bytes=7-','hij'],['bytes=-3','hij']]){
  const response=await call(env,url,{headers:{Cookie:cookie,Range:range}});assert.equal(response.status,206);assert.equal(await response.text(),content);
 }
 assert.equal((await call(env,url,{headers:{Cookie:cookie,Range:'bytes=100-'}})).status,416);
 const head=await call(env,url,{method:'HEAD',headers:{Cookie:cookie}});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('Content-Length'),'10');
});
test('Cloud configuration fails closed and does not expose arbitrary assets',async()=>{
 const env=environment();env.ACCESS_CODE='';assert.equal((await call(env,'/api/library')).status,503);
 env.ACCESS_CODE='a-very-long-test-code-for-local-tests';const cookie=await login(env);
 for(const url of ['/server.py','/data/access-code.txt','/cloudflare/worker.mjs'])assert.equal((await call(env,url,{headers:{Cookie:cookie}})).status,404);
});
