const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { AuthorClient } = require('../dist/author');
const request = mode => ({executable:process.execPath,args:[path.join(__dirname,'fake-author.cjs'),mode],cwd:__dirname,timeoutMs:300,maxOutputBytes:4096});

test('author handshake negotiates concurrency and responses retain identity out of order', async t => {
  const client = new AuthorClient(request('normal'));
  t.after(()=>client.dispose());
  await client.initialize();
  assert.equal(client.maxInflight,2);
  const results = await Promise.all([client.request('program/check',{source:'first',delay:50}),client.request('program/check',{source:'second'}),client.request('program/check',{source:'queued'})]);
  assert.deepEqual(results.map(r=>r.source),['first','second','queued']);
});
for(const [mode,pattern] of [['version',/protocol/],['malformed',/JSON|frame/],['oversized',/limit/],['exit',/exit/],['identity',/identity/],['hang',/deadline/]]) {
  test(`author rejects ${mode} and disposes pending work`,async()=>{
    const client=new AuthorClient(request(mode));
    try {
      if(mode==='version') await assert.rejects(client.initialize(),pattern);
      else { await client.initialize(); await assert.rejects(client.request('program/check',{source:'x'}),pattern); }
      assert.equal(client.closed,true);
    } finally {client.dispose();}
  });
}
test('domain errors remain visible without destroying the initialized connection',async t=>{
  const client=new AuthorClient(request('error')); t.after(()=>client.dispose());
  await client.initialize();
  await assert.rejects(client.request('revision/propose',{}),/revision_conflict/);
  assert.equal(client.closed,false);
});
test('abort rejects queued/inflight work and no late response can publish',async()=>{
  const client=new AuthorClient(request('hang')); await client.initialize();
  const abort=new AbortController();
  const result=client.request('program/check',{source:'old'},abort.signal);
  abort.abort(); await assert.rejects(result,/cancel/);
  assert.equal(client.closed,true);
});
test('a malformed error envelope rejects its still-pending request', {timeout:1500},async()=>{
 const client=new AuthorClient(request('error-frame'));await client.initialize();
 try{await assert.rejects(client.request('program/check',{}),/error/);}finally{client.dispose();}
});
