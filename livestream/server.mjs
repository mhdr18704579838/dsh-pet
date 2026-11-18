import http from 'node:http';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Inbox, messages} from './core.mjs';

const port = Number(process.env.PORT || 39210), origin = `http://127.0.0.1:${port}`;
const token = process.env.LIVE_TOKEN || randomBytes(24).toString('hex');
const demo = process.env.LIVE_MODE !== 'live';
const petBase = process.env.PET_BASE_URL || 'http://127.0.0.1:3080/dsh-pet-7340';
if (!['127.0.0.1','localhost','[::1]'].includes(new URL(petBase).hostname)) throw new Error('PET_BASE_URL 必须指向本机');
if (!demo && !process.env.LLM_API_KEY) throw new Error('live 模式需要 LLM_API_KEY');
const inbox = new Inbox();
let running = false, active = null, audio = null, error = '', busy = false, releasing = false, generation = 0;
const history = [];
const json = (res, status, data) => {res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data));};
async function body(req) {let data=''; for await (const part of req) {data += part; if (Buffer.byteLength(data)>8192) throw new Error('请求过大');} return JSON.parse(data || '{}');}
async function pet(path, payload, lock) {
  const url = new URL(petBase + path);
  url.searchParams.set('pet', process.env.PET_ID || 'main'); url.searchParams.set('surface', process.env.PET_SURFACE || 'desktop');
  if (lock) url.searchParams.set('lock', lock);
  const r = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
  if (!r.ok) throw new Error(`桌宠 HTTP ${r.status}`);
  if (r.headers.get('content-type')?.includes('json')) {const d=await r.json(); if (d.ok === false) throw new Error(`桌宠：${d.reason}`); return d;}
  const type=r.headers.get('content-type') || '';
  if (!type.startsWith('audio/')) throw new Error('TTS 返回了非音频内容');
  return {type, bytes:Buffer.from(await r.arrayBuffer())};
}
async function finish() {
  if (releasing) return;
  releasing=true;
  const previous=active; active=null; audio=null;
  if (previous?.lockId) try {await pet('/lock/release',{lockId:previous.lockId});} catch {error='桌宠占用释放失败，将在租约过期后释放';}
  releasing=false;
}
async function pump() {
  if (!running || busy || releasing || active) return;
  const event=inbox.take(); if (!event) return;
  busy=true; error=''; const epoch=generation; let lockId;
  try {
    let text;
    if (demo) text=`${event.user}，你好呀！这是模拟回复，真实模型和桌宠还没有接入。`;
    else {
      const r=await fetch((process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/,'')+'/chat/completions',{
        method:'POST',headers:{'Authorization':`Bearer ${process.env.LLM_API_KEY}`,'Content-Type':'application/json'},
        body:JSON.stringify({model:process.env.LLM_MODEL || 'deepseek-chat',messages:messages(event),max_tokens:180}),signal:AbortSignal.timeout(30000)
      });
      if (!r.ok) throw new Error(`模型 HTTP ${r.status}`);
      const result=await r.json(); text=result.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('模型未返回文字');
      text=text.trim().slice(0,180);
    }
    if (epoch!==generation || !running) return;
    let synthesized=null;
    if (!demo) synthesized=await pet('/voice/speak',{text});
    if (epoch!==generation || !running) return;
    if (!demo) {
      lockId=(await pet('/lock',{ttl:120000})).lockId;
      if (!lockId) throw new Error('桌宠未返回占用锁');
      if (epoch!==generation || !running) {await pet('/lock/release',{lockId}); return;}
      await pet('/broadcast',{text,duration:90000,anim:true,speak:false},lockId);
    }
    if (epoch!==generation || !running) {if(lockId) await pet('/lock/release',{lockId}); return;}
    audio=synthesized; active={id:randomUUID(),user:event.user,comment:event.text,text,lockId,startedAt:Date.now()};
    history.unshift({user:event.user,text}); history.splice(10);
  } catch (e) {
    if (lockId) try {await pet('/lock/release',{lockId});} catch {}
    error=e.message; running=false;
  } finally {busy=false;}
}
const timer=setInterval(() => {
  if (active && Date.now()-active.startedAt>90000) {running=false; error='播放超时：请打开播放页并启用声音，确认后再开始'; void finish();}
  else void pump();
},250);

const server=http.createServer(async(req,res)=>{
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) return json(res,403,{error:'仅接受本机地址'});
    const url=new URL(req.url,origin);
    if(req.method==='GET' && url.pathname==='/') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(await readFile(new URL('./index.html',import.meta.url)));}
    if(req.headers.origin && req.headers.origin!==origin) return json(res,403,{error:'拒绝跨域请求'});
    if(req.headers.authorization!==`Bearer ${token}`) return json(res,401,{error:'需要本地访问口令'});
    if(req.method==='GET' && url.pathname==='/state') return json(res,200,{demo,running,busy,error,active:active && {id:active.id,user:active.user,comment:active.comment,text:active.text},queued:inbox.items.length,history});
    if(req.method==='GET' && url.pathname==='/audio' && audio && url.searchParams.get('id')===active?.id) {res.writeHead(200,{'Content-Type':audio.type,'Cache-Control':'no-store'});return res.end(audio.bytes);}
    if(req.method!=='POST') return json(res,404,{error:'未找到'});
    const data=await body(req);
    if(url.pathname==='/events') return json(res,202,inbox.add(data));
    if(url.pathname==='/control') {
      if(data.action==='start') {running=true;error='';}
      else if(data.action==='stop') {running=false;generation++;inbox.items=[];await finish();}
      else throw new Error('未知操作');
      return json(res,200,{ok:true});
    }
    if(url.pathname==='/ack') {
      if(data.id!==active?.id) return json(res,409,{error:'播放编号不匹配'});
      if(data.error) {running=false;error='音频播放失败，请启用声音后重试';}
      await finish(); return json(res,200,{ok:true});
    }
    json(res,404,{error:'未找到'});
  } catch(e) {json(res,400,{error:e.message});}
});
server.listen(port,'127.0.0.1',()=>console.log(`大肥鱼直播桥（${demo?'模拟模式':'真实模式'}）\n${origin}/#${token}\n请勿将带口令的地址放入直播画面。`));
async function shutdown(){clearInterval(timer);running=false;generation++;await finish();server.close();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
