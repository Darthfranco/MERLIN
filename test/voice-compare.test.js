import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { VoiceComparison, wavInfo } from '../src/voice-compare.js';
import { createVoiceCompareServer } from '../src/voice-compare-server.js';

function wav(seconds = 4) {
  const bytes = Buffer.alloc(44 + 24000 * 2 * seconds);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length-8,4); bytes.write('WAVEfmt ',8); bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22); bytes.writeUInt32LE(24000,24); bytes.writeUInt32LE(48000,28); bytes.writeUInt16LE(2,32); bytes.writeUInt16LE(16,34); bytes.write('data',36); bytes.writeUInt32LE(bytes.length-44,40); return bytes;
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(),'merlin-voice-comparison-'));
  const events = [], requests = [];
  const lab = new VoiceComparison({ directory, probe: async()=>({available:true,runtime:'synthetic test'}), createWorker: model=>{
    events.push(`create:${model}`); let count = 0;
    return { async request(input,signal) {
      requests.push({model,...input}); events.push(`request:${model}:${count}`);
      if (options.request) return options.request({model,input,signal,count:count++});
      await writeFile(input.outputPath,wav());
      return {ok:true,loadMs:count++ ? 0 : 100,preparationMs:10,synthesisMs:500,runtime:'synthetic test',voiceMode:'fixture'};
    }, stop() { events.push(`stop:${model}`); } };
  } });
  await lab.init(); await lab.refresh();
  t.after(async()=>{ await lab.stop(); await rm(directory,{recursive:true,force:true}); });
  return {lab,directory,events,requests};
}
test('same text and reference reach each selected model; warm pass precedes worker release',async t=>{
  const {lab,events,requests}=await fixture(t);
  await lab.setReference({audio:wav().toString('base64'),transcript:'Synthetic reference only.',label:'Test voice'});
  await lab.start({text:'A synthetic timer is ready.',models:['kokoro','pocket','qwen']}); await lab.job;
  assert.equal(lab.run.status,'complete'); assert.equal(lab.run.results.length,6);
  assert.deepEqual(events,['create:kokoro','request:kokoro:0','request:kokoro:1','stop:kokoro','create:pocket','request:pocket:0','request:pocket:1','stop:pocket','create:qwen','request:qwen:0','request:qwen:1','stop:qwen']);
  assert.equal(requests[0].referencePath,undefined); assert.match(requests[2].referencePath,/reference\.wav$/); assert.equal(requests[4].referenceText,'Synthetic reference only.');
  assert(requests.every(item=>item.text==='A synthetic timer is ready.'));
  assert.equal(lab.run.results[0].durationSeconds,4); assert.equal(lab.run.results[0].realtimeFactor,.125); assert.equal(lab.run.results[1].loadMs,0);
  assert.equal(JSON.parse(await readFile(join(lab.directory,'state.json'),'utf8')).run.id,lab.run.id);
});
test('failed model cannot be mislabeled as a warm success and other models still run',async t=>{
  const {lab}=await fixture(t,{request:async({model,input})=>{ if(model==='pocket')throw new Error('Reference unavailable.'); await writeFile(input.outputPath,wav()); return {loadMs:1,preparationMs:2,synthesisMs:3}; }});
  await lab.start({text:'Synthetic text.',models:['pocket','kokoro']}); await lab.job;
  assert.deepEqual(lab.run.results.map(item=>item.status),['failed','skipped','complete','complete']); assert.equal(lab.run.status,'partial');
});
test('clear cancels active synthesis, rejects competing work, and removes references and generated files',async t=>{
  let release; const waiting = new Promise(resolve=>{release=resolve;});
  const {lab,directory}=await fixture(t,{request:async({signal})=>{ release(); await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Stopped.')),{once:true})); }});
  await lab.setReference({audio:wav().toString('base64'),transcript:'Synthetic.'});
  await lab.start({text:'Synthetic.',models:['qwen']}); await waiting;
  await assert.rejects(lab.start({text:'Other.',models:['kokoro']}),/already/);
  await assert.rejects(lab.setReference({audio:wav().toString('base64')}),/Stop/);
  const clearing = lab.clear(); await assert.rejects(lab.start({text:'Other.',models:['kokoro']}),/already/); await clearing;
  assert.equal(lab.run,null); assert.equal(lab.reference,null); assert.deepEqual(await readdir(directory),['state.json']);
});
test('invalid WAVs, oversized references, nonfinite timings and malformed selections are rejected',async t=>{
  assert.throws(()=>wavInfo(Buffer.from('not a wave')));
  const corrupt=wav(); corrupt.writeUInt32LE(1,28); assert.throws(()=>wavInfo(corrupt));
  assert.throws(()=>wavInfo(wav(31),{reference:true})); assert.throws(()=>wavInfo(wav(1),{reference:true}));
  const {lab}=await fixture(t,{request:async({input})=>{await writeFile(input.outputPath,wav());return{loadMs:NaN,preparationMs:0,synthesisMs:1};}});
  for(const models of [[],['unknown'],['kokoro','kokoro'],null])await assert.rejects(lab.start({text:'Synthetic',models}));
  await assert.rejects(lab.start({text:'x'.repeat(601),models:['kokoro']}));
  await lab.start({text:'Synthetic',models:['kokoro']}); await lab.job; assert.equal(lab.run.results[0].status,'failed'); assert.match(lab.run.results[0].error,/timing/);
});
test('server rejects cross-origin work, private paths, symlink audio and oversized bodies',async t=>{
  const {lab,directory}=await fixture(t); const {server}=createVoiceCompareServer({lab});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const port=server.address().port;
  t.after(()=>{server.close();server.closeAllConnections();});
  const call=(path,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,method,headers:{'Content-Type':'application/json',...headers}},res=>{const data=[];res.on('data',c=>data.push(c));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(data).toString(),headers:res.headers}));}); req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  assert.equal((await call('/')).status,200); assert.equal((await call('/api/status')).status,200);
  assert.equal((await call('/api/run',{method:'POST',body:{text:'Synthetic',models:['kokoro']},headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await call('/api/status',{headers:{Host:'evil.example'}})).status,403);
  assert.equal((await call('/api/status',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  for(const path of ['/.env','/api/chat','/audio/../../../.env','/audio/%2e%2e%2f.env']) assert.notEqual((await call(path)).status,200);
  await symlink(join(directory,'state.json'),join(directory,'reference.wav')); assert.equal((await call('/audio/reference.wav')).status,404);
  assert.equal((await call('/api/run',{method:'POST',body:{text:'x'.repeat(12000),models:['kokoro']}})).status,400);
  assert.match((await call('/')).headers['permissions-policy'],/microphone=\(\)/);
});
test('a restarted server labels unfinished results interrupted and retains completed audio',async t=>{
  const {lab,directory}=await fixture(t); await lab.start({text:'Synthetic',models:['kokoro'],passes:1}); await lab.job;
  lab.run.status='running';lab.run.results.push({model:'qwen',pass:0,status:'queued'});await lab.persist();
  const fresh=await new VoiceComparison({directory}).init(); assert.equal(fresh.run.status,'interrupted');assert.equal(fresh.run.results[0].status,'complete');assert.equal(fresh.run.results[1].status,'interrupted');
});
