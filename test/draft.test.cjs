const test=require('node:test');
const assert=require('node:assert/strict');
const { DraftSync, requireNoExternalAnswer }=require('../dist/openDraft');
const source='language "3.0"\nprogram Demo {\n  goal answer() -> Int {\n    intent "Return a number"\n    implementation open\n  }\n}\n';
const goal={name:'answer',stage:'build',intent:'Return a number',span:{path:'main.nx',line:3,column:3,end_line:6,end_column:4}};
const before={digest:'before',program_id:'demo',parent:null,program:{name:'Demo',language_version:'3.0',goals:[goal],handlers:[]}};
const after={...before,digest:'after',parent:'before',program:{...before.program,goals:[{...goal,intent:goal.intent+'\nAuthor clarification: 42'}]}};

function fixture() {
 const values=new Map(); const store={get:key=>values.get(key),update:async(key,value)=>{if(value===undefined)values.delete(key);else values.set(key,JSON.parse(JSON.stringify(value)));}};
 return {values,store,sync:new DraftSync(store)};
}
test('clarification persists source CAS before mutating author and survives restart',async()=>{
 const f=fixture();
 const pending=await f.sync.answer('key', {file:'main.nx',source,version:1,draft:before,activity:{revision:'before',request_id:'request',goal:'answer'},answer:'42'}, async()=>{
   assert.equal(f.values.get('key').expectedRevision,'before'); return {revision:'after'};
 });
 const restarted=new DraftSync(f.store);
 assert.equal(restarted.pending('key').revision,'after');
 const proposed=restarted.sourceFor(pending,before,after);
 assert.match(proposed,/Author clarification: 42/);
 assert.equal(proposed.replace(JSON.stringify(after.program.goals[0].intent),JSON.stringify(goal.intent)),source);
});
test('concurrent revision, unrelated semantic mutation and stale source reject synchronization',async()=>{
 const f=fixture();
 const pending=await f.sync.answer('key',{file:'main.nx',source,version:1,draft:before,activity:{revision:'before',request_id:'r',goal:'answer'},answer:'42'},async()=>({revision:'after'}));
 assert.throws(()=>f.sync.assertSource(pending,source+'// edited',1),/Source changed/);
 assert.throws(()=>f.sync.assertSource(pending,source,2),/document changed/);
 assert.throws(()=>f.sync.sourceFor(pending,before,{...after,parent:'other'}),/revision/);
 assert.throws(()=>f.sync.sourceFor(pending,before,{...after,program:{...after.program,name:'Changed'}}),/unrelated/);
 assert.equal(f.sync.pending('key').revision,'after');
});
test('lost answer response keeps pending intent and prevents stale source execution',async()=>{
 const f=fixture();
 await assert.rejects(f.sync.answer('key',{file:'main.nx',source,version:1,draft:before,activity:{revision:'before',request_id:'r',goal:'answer'},answer:'42'},async()=>{throw Error('connection lost');}),/connection lost/);
 assert.throws(()=>f.sync.requireSynchronized('key'),/pending/);
 assert.equal(new DraftSync(f.store).pending('key').revision,undefined);
});
test('another Author answer blocks stale source without any local pending journal',()=>{
 const snapshot={draft:after,events:[{event:{kind:'author_answered',object_id:'after',detail:'external'}}]};
 assert.throws(()=>requireNoExternalAnswer(snapshot,before.program),/another author/);
 assert.doesNotThrow(()=>requireNoExternalAnswer(snapshot,after.program));
});
test('source synchronization uses fresh native source spans when the stored semantic revision has older formatting',async()=>{
 const f=fixture();const shifted='\n'.repeat(8)+source;
 const sourceGoal={...goal,span:{...goal.span,line:11,end_line:14}};
 assert.throws(()=>require('../dist/openProtocol').replaceIntent(shifted,goal,after.program.goals[0].intent),/intent token|Source span/);
 const pending=await f.sync.answer('key',{file:'main.nx',source:shifted,version:1,draft:before,sourceProgram:{...before.program,goals:[sourceGoal]},activity:{revision:'before',request_id:'r',goal:'answer'},answer:'42'},async()=>({revision:'after'}));
 assert.equal(f.sync.sourceFor(pending,before,after),shifted.replace(JSON.stringify(goal.intent),JSON.stringify(after.program.goals[0].intent)));
});
