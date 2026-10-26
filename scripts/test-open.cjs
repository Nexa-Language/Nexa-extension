const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {tmpdir} = require('node:os');
const {createHash} = require('node:crypto');
const {CliRunner}=require('../dist/cli');
const {AuthorClient}=require('../dist/author');
const {DraftSync,requireNoExternalAnswer}=require('../dist/openDraft');
const {parseCheckReport,openInspection,openProblems,sameProgram}=require('../dist/openProtocol');
const {toUtf16Position}=require('../dist/protocol');
const {createServices}=require('../test/open-services-fixture.cjs');
const root=path.resolve(__dirname,'..');
const image='python@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704';

async function main(){
 const executable=process.env.NEXA_CLI, python=process.env.NEXA_PYTHON;
 assert.ok(executable&&python,'Set NEXA_CLI and NEXA_PYTHON to the pinned runtime executables.');
 const directory=await fs.mkdtemp(path.join(tmpdir(),'nexa-extension-open-'));
 const home=path.join(directory,'home');await fs.mkdir(home);
 const env={HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config'),NO_COLOR:'1',PYTHONUNBUFFERED:'1'};
 for(const key of ['PATH','LANG','TMPDIR','DOCKER_HOST','SystemRoot']) if(process.env[key])env[key]=process.env[key];
 const runner=new CliRunner(),clients=[],evidence=[];
 const invoke=async(exe,args,success=true)=>{
   const result=await runner.run({executable:exe,args,cwd:directory,env,timeoutMs:120000,maxOutputBytes:4194304});
   assert.equal(result.kind,'exited',JSON.stringify(result));
   if(success)assert.equal(result.code,0,result.stdout+result.stderr);else assert.notEqual(result.code,0);
   const data=JSON.parse(result.stdout||result.stderr);evidence.push({args,result:data,code:result.code});return data;
 };
 const client=async(exe,args,methods)=>{const c=new AuthorClient({executable:exe,args,cwd:directory,env,timeoutMs:30000,maxOutputBytes:4194304},methods);clients.push(c);await c.initialize();return c;};
 const bridge=state=>client(python,[path.join(root,'bridge/query.py'),'--state',state],['snapshot','revision','proposal']);
 try{
  const state=path.join(directory,'author.db');
  const author=await client(executable,['author','--state',state]);
  const source='language "3.0"\nprogram Demo {\n  goal answer() -> Int {\n    intent "Return a number 😀"\n    implementation open\n  }\n}\n';
  const file=path.join(directory,'main.nx');await fs.writeFile(file,source);
  const report=parseCheckReport(await author.request('program/check',{source,path:file}));
  assert.equal(openInspection(report,{file}).entries[0].span.start.line,2);
  const syntaxCases=[
   {name:'missing-value',source:'language "3.0"\nprogram Demo {\n  goal answer() -> Int {\n    intent "Return 42"\n    implementation value\n  }\n}\n',position:{line:5,character:2}},
   {name:'eof',source:'language "3.0"\nprogram Demo {\n  goal answer() -> Int {\n    intent "Return 42"\n    implementation value',position:{line:4,character:19}},
   {name:'unicode',source:'language "3.0"\nprogram Demo {\n  goal answer() -> Int {\n    intent "😀" implementation value }\n}\n',position:{line:3,character:37}},
  ];
  for(const item of syntaxCases){
   const native=parseCheckReport(await author.request('program/check',{source:item.source,path:file}));
   const [problem]=openProblems(native,{file});
   assert.equal(problem.code,'syntax_error');assert.equal(problem.message,'Invalid Open Program syntax');
   assert.deepEqual(problem.end,problem.position);assert.deepEqual(toUtf16Position(problem.position,item.source.split('\n')),item.position);
   evidence.push({syntax:item.name,native:native.diagnostics[0],utf16:item.position});
  }
  const invalid=parseCheckReport(await author.request('program/check',{source:source.replace('implementation open','implementation value "wrong"'),path:file}));
  assert.equal(invalid.diagnostics[0].severity,'error');
  const revision=(await author.request('revision/propose',{program_id:'demo',expected_revision:null,source,path:file})).revision;
  await assert.rejects(author.request('revision/propose',{program_id:'demo',expected_revision:null,source,path:file}),/revision_conflict/);
  const query=await bridge(state);
  const original=(await query.request('snapshot',{program_id:'demo'})).draft;
  assert.equal(original.digest,revision);
  await assert.rejects(query.request('revision/propose',{program_id:'demo'}),/method_not_found/);
  const fixture=await client(python,[path.join(root,'test/open-fixture.py'),'author',state]);
  const activityId=(await fixture.request('goal/resolve',{program_id:'demo',expected_revision:revision,goal:'answer'})).activity_id;
  let activity; const deadline=Date.now()+10000;
  do {activity=await fixture.request('activity/read',{object_id:activityId}); if(activity.state==='running')await new Promise(r=>setTimeout(r,20));}while(activity.state==='running'&&Date.now()<deadline);
  assert.equal(activity.state,'blocked');assert.ok(activity.request_id);
  const journal=path.join(directory,'pending.json');
  const values=JSON.parse(await fs.readFile(journal,'utf8').catch(()=> '{}'));
  const storage={get:key=>values[key],update:async(key,value)=>{if(value===undefined)delete values[key];else values[key]=value;await fs.writeFile(journal,JSON.stringify(values));}};
  const sync=new DraftSync(storage);
  await sync.answer('pending',{file,source,version:1,draft:original,activity,answer:'42'},()=>author.request('author/answer',{program_id:'demo',expected_revision:revision,request_id:activity.request_id,answer:'42'}));
  const pending=new DraftSync({get:key=>JSON.parse(require('node:fs').readFileSync(journal,'utf8'))[key],update:storage.update}).pending('pending');
  const answered=await query.request('revision',{program_id:'demo',object_id:pending.revision});
  const snapshot=await query.request('snapshot',{program_id:'demo'});
  assert.throws(()=>requireNoExternalAnswer(snapshot,original.program),/another author/);
  assert.throws(()=>sync.assertSource(pending,source+'// concurrent edit'),/Source changed/);
  assert.throws(()=>sync.requireSynchronized('pending'),/pending/);
  const proposed=sync.sourceFor(pending,original,answered);
  const checked=parseCheckReport(await author.request('program/check',{source:proposed,path:file}));
  assert.ok(sameProgram(checked.program,answered.program));
  await fs.writeFile(file,proposed);
  await author.request('revision/propose',{program_id:'demo',expected_revision:pending.revision,source:proposed,path:file});
  await sync.clear('pending');
  assert.doesNotThrow(()=>sync.requireSynchronized('pending'));
  console.log('OPEN PASS: real Author handshake/check/outline/CAS/clarification, durable pending restart/conflict and native IR equality');
  await environmentLifecycle({python,directory,source,evidence});

  const seeded=await invoke(python,[path.join(root,'test/open-fixture.py'),'seed',directory]);
  const seedState=path.join(directory,'seed.db');const seedBridge=await bridge(seedState);
  const hash=async()=>Object.fromEntries(await Promise.all((await fs.readdir(directory)).filter(name=>/^seed\.db(?:-wal|-shm)?$/.test(name)).map(async name=>[name,createHash('sha256').update(await fs.readFile(path.join(directory,name))).digest('hex')])));
  const before=await hash();
  const one=await seedBridge.request('snapshot',{program_id:'seed'});
  assert.deepEqual(one.runtime_activities.map(item=>item.activity_id).sort(),seeded.activities.sort());
  const afterRead=await hash();
  assert.equal(afterRead['seed.db'],before['seed.db'],'read-only bridge preserves the database');
  evidence.push({readOnly:{databaseUnchanged:true,sqliteReaderSidecars:Object.keys(afterRead).filter(name=>name!=='seed.db')}});
  const restored=await bridge(seedState);const two=await restored.request('snapshot',{program_id:'seed'});
  assert.deepEqual(two.runtime_activities,one.runtime_activities);
  await invoke(executable,['open','cancel',seeded.activities[0],'--environment',path.join(directory,'offline.environment.json'),'--state',seedState]);
  const cancelled=await restored.request('snapshot',{program_id:'seed'});
  assert.equal(cancelled.runtime_activities.find(item=>item.activity_id===seeded.activities[0]).state,'cancelled');
  assert.equal(cancelled.runtime_activities.find(item=>item.activity_id===seeded.activities[1]).state,'pending');
  await client(python,[path.join(root,'test/open-fixture.py'),'wal',seedState]);
  assert.ok((await fs.stat(seedState+'-wal')).size>0);
  const activeWal=await restored.request('snapshot',{program_id:'seed'});
  assert.equal(activeWal.runtime_activities.length,3,'bridge reads the new activity from an active WAL');
  const interrupted=await invoke(python,[path.join(root,'test/open-fixture.py'),'pending-effect',seedState]);
  assert.deepEqual(interrupted,{state:'started',blocked:'pending_effect'});
  await invoke(executable,['open','resume','seed','--environment',path.join(directory,'offline.environment.json'),'--state',seedState]);
  const recovered=await invoke(python,[path.join(root,'test/open-fixture.py'),'effect-status',seedState]);
  assert.deepEqual(recovered,{state:'unknown',blocked:'pending_effect'});
  const missing=await bridge(path.join(directory,'missing.db'));
  await assert.rejects(missing.request('snapshot',{program_id:'demo'}),/query_failed/);
  await assert.rejects(fs.stat(path.join(directory,'missing.db')),/ENOENT/);
  const wrong=path.join(directory,'wrong.db');await fs.writeFile(wrong,'not sqlite');
  const wrongBridge=await bridge(wrong);await assert.rejects(wrongBridge.request('snapshot',{program_id:'demo'}),/query_failed/);
  const schema=path.join(directory,'wrong-schema.db');await invoke(python,[path.join(root,'test/open-fixture.py'),'wrong-state',schema]);
  const schemaBridge=await bridge(schema);await assert.rejects(schemaBridge.request('snapshot',{program_id:'demo'}),/unsupported_schema/);
  console.log('OPEN PASS: packaged read-only bridge from external cwd, active WAL, query whitelist, missing/wrong state, unchanged database (SQLite WAL reader sidecars allowed), restored exact runtime IDs, durable cancellation and unknown-effect recovery block');

  if(process.argv.includes('--oci')) await oci({invoke,executable,python,directory,state,file,query,evidence});
  await fs.mkdir(path.join(root,'.test-artifacts'),{recursive:true});
  await fs.writeFile(path.join(root,'.test-artifacts',process.argv.includes('--oci')?'open-oci-evidence.json':'open-evidence.json'),JSON.stringify({directory,image,evidence},null,2)+'\n');
 }finally{for(const c of clients)await c.shutdown();await runner.shutdown();}
}

async function environmentLifecycle({python,directory,source,evidence}){
 const environment=path.join(directory,'permissions.environment.json');
 const permission=allow_model=>JSON.stringify({image,model:'fixture',allow_model});
 await fs.writeFile(environment,permission(true));
 const {services,uri}=createServices(directory,{executablePath:python,executableArgs:[path.join(root,'test/open-fixture.py'),'cli'],
  'open.environment':environment,'open.state':path.join(directory,'permissions.db')});
 try{
  const check=await services.client(uri,'check');
  const {revision}=await check.request('revision/propose',{program_id:'permissions',expected_revision:null,source,path:uri.fsPath});
  const params={program_id:'permissions',expected_revision:revision,goal:'answer'};
  const resolve=async client=>{
   const started=await client.request('goal/resolve',params);let activity;
   const deadline=Date.now()+10000;
   do{activity=await client.request('activity/read',{object_id:started.activity_id});if(activity.state==='running')await new Promise(r=>setTimeout(r,20));}while(activity.state==='running'&&Date.now()<deadline);
   return activity.result;
  };
  const old=await services.client(uri,'author');const before=await resolve(old);
  assert.equal(before.model_calls,1);assert.equal(before.reason,'clarification_required');
  await fs.writeFile(environment,permission(false));
  await assert.rejects(old.request('goal/resolve',params),/environment.*changed/i);
  const current=await services.client(uri,'author');assert.notEqual(current,old);
  const after=await resolve(current);assert.equal(after.model_calls,0);assert.equal(after.reason,'model_unavailable');
  await fs.unlink(environment);await assert.rejects(current.request('goal/resolve',params),/environment.*unavailable/i);
  assert.ok(parseCheckReport(await check.request('program/check',{source,path:uri.fsPath})).program);
  evidence.push({authorEnvironment:{before:{reason:before.reason,model_calls:before.model_calls},after:{reason:after.reason,model_calls:after.model_calls},oldClientRejected:true,deletedFileRejected:true,automaticCheckWithoutEnvironment:true}});
  console.log('OPEN PASS: real Author environment revocation blocks acquired client, rebuilt Author has zero model calls, deleted environment rejects, automatic check remains provider-free; native syntax/EOF/Unicode positions preserved');
 }finally{await services.shutdown();}
}

async function oci({invoke,executable,python,directory,state,file,query}){
 const environment=path.join(directory,'fixture.environment.json');await fs.writeFile(environment,JSON.stringify({image,model:'fixture',allow_model:true}));
 const args=['--environment',environment,'--state',state,'--json'];
 const built=await invoke(python,[path.join(root,'test/open-fixture.py'),'cli','build',file,...args]);
 assert.equal(built.results[0].output_json,'42');assert.equal(built.results[0].model_calls,1);
 const locked=await invoke(executable,['build',file,...args,'--locked']);assert.equal(locked.program_digest,built.program_digest);
 const current=await query.request('snapshot',{program_id:'demo'});
 const run=await invoke(python,[path.join(root,'test/open-fixture.py'),'cli','run',file,...args,'--program-id','demo','--expected-revision',current.draft.digest,'--goal','answer']);
 assert.equal(run.result.output_json,'42');
 const head=await invoke(executable,['open','status','demo','--state',state]);assert.equal(head.revision,run.revision);
 await invoke(executable,['open','resume','demo','--environment',environment,'--state',state]);
 const repo=path.join(directory,'repo');await fs.mkdir(repo);await fs.writeFile(path.join(repo,'calc.py'),'def add(a, b):\n return a - b\n');
 const prep=await invoke(python,[path.join(root,'test/open-fixture.py'),'patch',repo]);
 const maintain=path.join(directory,'maintain.nx');
 await fs.writeFile(maintain,'language "3.0" program Maintain(repo: Repository) { goal repair(change: ChangeRequest) -> Patch { stage runtime intent "Fix addition" capabilities [repo.read, sandbox.write] ensure checks.regression implementation value '+JSON.stringify(prep)+' } on change_request as request { let result = resolve repair(request) propose repo.apply(result) requires human.approval } }');
 const maintenanceEnv=path.join(directory,'maintenance.environment.json');await fs.writeFile(maintenanceEnv,JSON.stringify({image,checks:[{name:'checks.regression',cases:[{argv:['python','-c','from calc import add; print(add(2, 3))'],expected_output:'5\n'}]}]}));
 const patchState=path.join(directory,'patch.db');
 const proposal=await invoke(executable,['run',maintain,'--environment',maintenanceEnv,'--state',patchState,'--program-id','maintain','--repository',repo,'--include','calc.py','--request','Fix addition','--json']);
 assert.equal(proposal.status,'awaiting_approval');assert.match(await fs.readFile(path.join(repo,'calc.py'),'utf8'),/a - b/);
 const scope=['--environment',maintenanceEnv,'--state',patchState];const id=proposal.proposal_id;
 const evidence=await invoke(executable,['open','evidence',id,...scope]);assert.equal(evidence.admission.accepted,true);
 await invoke(executable,['open','apply',id,'--grant','unknown',...scope],false);
 const expired=await invoke(executable,['open','approve',id,'--actor','fixture-operator','--expires-in','-1','--state',patchState]);
 await invoke(executable,['open','apply',id,'--grant',expired.grant_id,...scope],false);
 const grant=await invoke(executable,['open','approve',id,'--actor','fixture-operator','--state',patchState]);
 await fs.writeFile(path.join(repo,'calc.py'),'# edited\ndef add(a, b):\n return a - b\n');
 await invoke(executable,['open','apply',id,'--grant',grant.grant_id,...scope],false);
 await fs.writeFile(path.join(repo,'calc.py'),'def add(a, b):\n return a - b\n');
 const applied=await invoke(executable,['open','apply',id,'--grant',grant.grant_id,...scope]);assert.equal(applied.state,'applied');
 await invoke(executable,['open','recover',id,'--state',patchState]);assert.match(await fs.readFile(path.join(repo,'calc.py'),'utf8'),/a \+ b/);
 const capsule=path.join(directory,'repair.capsule.json');await invoke(executable,['open','capsule','export',capsule,'--activity',proposal.activity_id,'--source','fixture-repository','--creator','fixture-operator','--license','MIT','--state',patchState]);
 await invoke(executable,['open','capsule','import',capsule,'--state',path.join(directory,'import.db')]);
 await invoke(python,[path.join(root,'test/open-fixture.py'),'invalidate-evidence',patchState,id]);
 const stale=await invoke(executable,['open','evidence',id,...scope]);assert.equal(stale.admission.accepted,false);
 await invoke(executable,['open','apply',id,'--grant',grant.grant_id,...scope],false);
 console.log('OPEN OCI PASS: clarification → native build/run, locked replay, status/resume, exact patch evidence/diff/approval/apply/recover, unknown/expired grant, edited baseline and stale evidence rejections, capsule export/import');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
