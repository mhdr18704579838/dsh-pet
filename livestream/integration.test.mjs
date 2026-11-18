import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('live pipeline uses model, TTS, lock, broadcast, playback ack, then next comment',async()=>{
  const calls=[];
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw||'{}');calls.push({url:req.url,body});
    if(req.url.startsWith('/pet/voice/speak')){res.writeHead(200,{'Content-Type':'audio/wav'});return res.end('fake audio');}
    res.setHeader('Content-Type','application/json');
    if(req.url==='/chat/completions')return res.end(JSON.stringify({choices:[{message:{content:'你好，欢迎来到直播间！'}}]}));
    res.end(JSON.stringify(req.url.startsWith('/pet/lock?')?{ok:true,lockId:'test-lock'}:{ok:true}));
  });
  mock.listen(0,'127.0.0.1');await once(mock,'listening');const mp=mock.address().port;
  const spare=http.createServer().listen(0,'127.0.0.1');await once(spare,'listening');const port=spare.address().port;await new Promise(r=>spare.close(r));
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),env:{...process.env,PORT:String(port),LIVE_TOKEN:'test',LIVE_MODE:'live',LLM_API_KEY:'fake',LLM_BASE_URL:`http://127.0.0.1:${mp}`,PET_BASE_URL:`http://127.0.0.1:${mp}/pet`},stdio:['ignore','pipe','pipe']});
  const base=`http://127.0.0.1:${port}`;
  async function request(path,data,auth=true){return fetch(base+path,{method:data?'POST':'GET',headers:{...(auth?{Authorization:'Bearer test'}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});}
  async function until(fn){for(let i=0;i<100;i++){try{const v=await fn();if(v)return v;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('timed out');}
  try{
    await until(async()=> (await request('/state')).ok);
    assert.equal((await request('/state',null,false)).status,401);
    assert.equal((await fetch(base+'/state',{headers:{Authorization:'Bearer test',Origin:'https://untrusted.example'}})).status,403);
    assert.equal((await request('/')).status,200);
    for(const name of ['idle','react']) {const r=await request('/assets/'+name+'.gif',null,false);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/gif');assert.ok((await r.arrayBuffer()).byteLength>1000);}
    await request('/events',{id:'1',user:'a',text:'你好'});await request('/events',{id:'2',user:'b',text:'吃饭了吗'});
    await request('/control',{action:'start'});
    const first=await until(async()=> (await(await request('/state')).json()).active);
    const model=calls.find(x=>x.url==='/chat/completions');assert.equal(model.body.tools,undefined);
    assert.equal((await request('/audio?id='+first.id)).headers.get('content-type'),'audio/wav');
    const broadcast=calls.find(x=>x.url.startsWith('/pet/broadcast'));assert.equal(broadcast.body.speak,false);assert.match(broadcast.url,/lock=test-lock/);
    await new Promise(r=>setTimeout(r,600));assert.equal(calls.filter(x=>x.url==='/chat/completions').length,1);
    assert.equal((await request('/ack',{id:'wrong'})).status,409);
    await request('/ack',{id:first.id});
    await until(async()=>{const s=await(await request('/state')).json();return s.active && s.active.id!==first.id;});
    await request('/control',{action:'stop'});
    const state=await(await request('/state')).json();assert.equal(state.running,false);assert.equal(state.active,null);assert.equal(state.queued,0);
    assert.equal(calls.filter(x=>x.url.startsWith('/pet/lock/release')).length,2);
  }finally{child.kill('SIGTERM');await once(child,'exit');await new Promise(r=>mock.close(r));}
});
