const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createServices}=require('./open-services-fixture.cjs');
const {AuthorEnvironment}=require('../dist/openEnvironment');

async function fixture(t,args=[]){
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'nexa-environment-test-'));
 const environment=path.join(folder,'environment.json'),log=path.join(folder,'requests.jsonl');
 await fs.writeFile(environment,JSON.stringify({allow_model:true}));
 const {services,uri}=createServices(folder,{executablePath:process.execPath,executableArgs:[path.join(__dirname,'environment-author.cjs'),'--log',log,...args],checkTimeoutMs:1000,'open.environment':environment});
 t.after(()=>services.shutdown());
 return {services,uri,environment,log};
}

test('an already acquired Author rejects externally revoked environment before sending an RPC',async t=>{
 const f=await fixture(t);const client=await f.services.client(f.uri,'author');
 const before=await client.request('goal/resolve',{});assert.equal(before.allow_model,true);
 await fs.writeFile(f.environment,JSON.stringify({allow_model:false}));
 await assert.rejects(client.request('goal/resolve',{}),/environment.*changed/i);
 assert.equal(client.closed,true);
 const requests=(await fs.readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(requests.filter(row=>row.method==='goal/resolve').length,1,'revoked request never reaches the old process');
 const next=await f.services.client(f.uri,'author');assert.notEqual(next,client);
 assert.equal((await next.request('goal/resolve',{})).allow_model,false);
 await client.shutdown();assert.throws(()=>process.kill(before.pid,0),{code:'ESRCH'});
});

test('queued Author work rechecks environment after waiting for its inflight slot',async t=>{
 const f=await fixture(t);const client=await f.services.client(f.uri,'author');
 const first=client.request('program/check',{delay:150});
 const queued=assert.rejects(client.request('goal/resolve',{}),/environment.*changed/i);
 await new Promise(resolve=>setTimeout(resolve,50));
 await fs.writeFile(f.environment,JSON.stringify({allow_model:false}));
 await first;await queued;
 const requests=(await fs.readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(requests.filter(row=>row.method==='goal/resolve').length,0);
});

test('replacement and deletion invalidate Author; check never binds provider configuration',async t=>{
 const f=await fixture(t);const first=await f.services.client(f.uri,'author');
 const replacement=f.environment+'.replacement';await fs.writeFile(replacement,JSON.stringify({allow_model:false}));await fs.rename(replacement,f.environment);
 const second=await f.services.client(f.uri,'author');assert.notEqual(second,first);assert.equal(first.closed,true);
 const result=await second.request('goal/resolve',{});assert.equal(result.allow_model,false);
 assert.notEqual(result.environment,f.environment,'native Author reads the captured content snapshot');
 assert.equal(JSON.parse(await fs.readFile(result.environment,'utf8')).allow_model,false);
 assert.equal((await fs.stat(result.environment)).mode&0o777,0o600);assert.equal((await fs.stat(path.dirname(result.environment))).mode&0o777,0o700);
 await fs.unlink(f.environment);
 await assert.rejects(second.request('goal/resolve',{}),/environment.*(unavailable|changed)/i);
 await assert.rejects(f.services.client(f.uri,'author'),/environment.*unavailable/i);
 const check=await f.services.client(f.uri,'check');assert.equal((await check.request('program/check',{})).environment,undefined);
 await f.services.shutdown();await assert.rejects(fs.stat(result.environment),{code:'ENOENT'});
});

for(const failure of ['initialize','timeout','abort'])test(`Author ${failure} cleans the private environment snapshot and process`,async t=>{
 const f=await fixture(t,[failure==='initialize'?'--initialize-fail':'--hang']);
 if(failure==='initialize')await assert.rejects(f.services.client(f.uri,'author'),/JSON/);
 else{
  const client=await f.services.client(f.uri,'author');const abort=new AbortController();
  const pending=assert.rejects(client.request('goal/resolve',{},abort.signal),failure==='timeout'?/deadline/:/cancel/);
  if(failure==='abort')abort.abort();await pending;
 }
 await f.services.shutdown();
 const first=JSON.parse((await fs.readFile(f.log,'utf8')).split('\n')[0]);
 assert.notEqual(first.environment,f.environment);await assert.rejects(fs.stat(first.environment),{code:'ENOENT'});
 assert.throws(()=>process.kill(first.pid,0),{code:'ESRCH'});
});

test('reset then shutdown drains a capture that has written its private snapshot but not returned',async t=>{
 const f=await fixture(t);const capture=AuthorEnvironment.capture;
 let captured,release,snapshot;
 const capturedPromise=new Promise(resolve=>{captured=resolve;});const barrier=new Promise(resolve=>{release=resolve;});
 AuthorEnvironment.capture=async function(file){const environment=await capture.call(this,file);snapshot=environment.snapshot;captured();await barrier;return environment;};
 const opening=assert.rejects(f.services.client(f.uri,'author'),/configuration or trust changed/);
 let shutdown;
 try{
  await capturedPromise;f.services.reset();
  let closed=false;shutdown=f.services.shutdown().then(()=>{closed=true;});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal((await fs.stat(snapshot)).isFile(),true,'barrier holds a real private snapshot');
  assert.equal(closed,false,'shutdown must wait for capture and its stale-generation cleanup after reset clears the cache');
 }finally{
  release();await opening;await shutdown;AuthorEnvironment.capture=capture;
 }
 await assert.rejects(fs.stat(snapshot),{code:'ENOENT'});
 await assert.rejects(fs.stat(f.log),{code:'ENOENT'},'stale creation never launches Author');
});
