const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vscode=require('vscode');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label){const end=Date.now()+30000;while(!(await predicate())){assert.ok(Date.now()<end,label);await sleep(60);}}

exports.run=async()=>{
 const extension=vscode.extensions.getExtension('Nexa-Language.nexa-lang');assert.ok(extension);await extension.activate();
 assert.equal(extension.packageJSON.version,'0.3.0');assert.ok(extension.extensionPath.startsWith(process.env.NEXA_HOST_INSTALLED));
 assert.ok((await fs.readFile(path.join(extension.extensionPath,'bridge/query.py'),'utf8')).includes('mode=ro'));
 assert.equal((await fs.readdir(path.join(extension.extensionPath,'schemas/3.0'))).length,16);
 const trusted=process.env.NEXA_HOST_TRUSTED==='true';assert.equal(vscode.workspace.isTrusted,trusted);
 const folders=JSON.parse(process.env.NEXA_HOST_ROOTS);const documents=[];
 for(const folder of folders){const document=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(folder,'main.nx')));documents.push(document);await vscode.window.showTextDocument(document);}
 const calls=async()=> (await fs.readFile(process.env.NEXA_HOST_PROCESS_LOG,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 if(!trusted){
  await vscode.commands.executeCommand('nexa.open.check',documents[0].uri);await vscode.commands.executeCommand('nexa.open.apply',documents[0].uri);
  await sleep(500);assert.deepEqual(await calls(),[]);assert.equal((await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',documents[0].uri)??[]).length,0);
  console.log('HOST OPEN PASS: installed VSIX 0.3.0 activation in Restricted Mode; no CLI/Author/bridge launch and no apply');return;
 }
 for(const document of documents){
  await vscode.commands.executeCommand('nexa.open.check',document.uri);
  const symbols=await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',document.uri);
  assert.equal(symbols[0].name,'answer');assert.equal(symbols[0].range.start.line,2);assert.equal(symbols[0].range.start.character,2);
  assert.ok(await vscode.commands.executeCommand('nexa.open.status',document.uri));
 }
 const launched=await calls();const realFolders=await Promise.all(folders.map(folder=>fs.realpath(folder)));assert.ok(realFolders.every(folder=>launched.some(call=>call.cwd===folder&&call.argv.includes('author'))));
 assert.ok(launched.filter(call=>call.argv.includes('author')).every(call=>!call.argv.includes('--environment')),'automatic checks do not bind providers');
 const first=documents[0];const old=first.getText();const edit=new vscode.WorkspaceEdit();edit.replace(first.uri,new vscode.Range(first.positionAt(0),first.positionAt(old.length)),old.replace('implementation value 42','implementation value "wrong"'));assert.equal(await vscode.workspace.applyEdit(edit),true);await first.save();
 await until(()=>vscode.languages.getDiagnostics(first.uri).some(problem=>problem.severity===vscode.DiagnosticSeverity.Error),'native 3.0 diagnostics');
 const diagnostic=vscode.languages.getDiagnostics(first.uri)[0];assert.ok(diagnostic.range.start.line>=2);assert.equal(diagnostic.source,'Nexa');
 const restore=new vscode.WorkspaceEdit();restore.replace(first.uri,new vscode.Range(first.positionAt(0),first.positionAt(first.getText().length)),old);await vscode.workspace.applyEdit(restore);await first.save();
 await until(()=>vscode.languages.getDiagnostics(first.uri).length===0,'saved source clears old diagnostics');
 await syntaxProblems(first,old);
 const finished=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{subscription.dispose();reject(Error('build task timeout'));},60000);const subscription=vscode.tasks.onDidEndTaskProcess(event=>{if(event.execution.task.definition.type==='nexa'&&event.execution.task.definition.command==='build'){clearTimeout(timer);subscription.dispose();resolve(event.exitCode);}});});
 await vscode.commands.executeCommand('nexa.build',first.uri);assert.equal(await finished,0);
 await until(async()=>{try{return JSON.parse(await fs.readFile(path.join(folders[0],'main.nx.lock'),'utf8')).schema_version===1;}catch{return false;}},'native build task creates lock');
 assert.equal(await vscode.commands.executeCommand('nexa.open.buildLocked',first.uri),0);
 await vscode.commands.executeCommand('nexa.open.status',first.uri);
 await environmentPermissions(documents[1],folders[1]);
 await clarification(first,folders[0]);
 await maintenance(first,folders[0]);
 const query=await vscode.workspace.openTextDocument({language:'json',content:'{"review":"native details"}'});await vscode.window.showTextDocument(query);
 await vscode.commands.executeCommand('workbench.action.closeAllEditors');
 console.log(`HOST OPEN PASS: installed VSIX ${extension.packageJSON.version}, real Author/bridge, dual-root state, native Problems/Outline, dirty/save lifecycle, OCI build + locked replay and native tree on VS Code ${vscode.version}`);
};

async function replace(document,source){const edit=new vscode.WorkspaceEdit();edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),source);assert.equal(await vscode.workspace.applyEdit(edit),true);assert.equal(await document.save(),true);}
async function syntaxProblems(document,original){
 const cases=[
  {source:'language "3.0"\nprogram Demo {\n  goal answer() -> Int {\n    intent "Return 42"\n    implementation value\n  }\n}\n',line:5,column:2},
  {source:'language "3.0"\nprogram Demo {\n  goal answer() -> Int {\n    intent "Return 42"\n    implementation value',line:4,column:19},
  {source:'language "3.0"\nprogram Demo {\n  goal answer() -> Int {\n    intent "😀" implementation value }\n}\n',line:3,column:37},
 ];
 for(const item of cases){
  await replace(document,item.source);await vscode.commands.executeCommand('nexa.open.check',document.uri);
  await until(()=>vscode.languages.getDiagnostics(document.uri).some(d=>d.code==='syntax_error'&&d.range.start.line===item.line&&d.range.start.character===item.column),'native syntax Problems location');
  const diagnostic=vscode.languages.getDiagnostics(document.uri).find(d=>d.code==='syntax_error');
  assert.equal(diagnostic.message,'Invalid Open Program syntax');assert.equal(diagnostic.range.isEmpty,true);
 }
 await replace(document,original);await vscode.commands.executeCommand('nexa.open.check',document.uri);
 assert.equal(vscode.languages.getDiagnostics(document.uri).length,0);
 console.log('HOST OPEN PASS: actual native syntax/EOF/Unicode point diagnostics retain code/message and exact UTF16 Problems positions');
}
async function environmentPermissions(document,folder){
 const environment=path.join(folder,'permissions.environment.json');
 const permissions=allow_model=>JSON.stringify({image:'python@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704',model:'fixture',allow_model});
 await fs.writeFile(environment,permissions(true));
 const config=vscode.workspace.getConfiguration('nexa',document.uri);
 await config.update('executableArgs',[process.env.NEXA_HOST_FIXTURE,'cli'],vscode.ConfigurationTarget.WorkspaceFolder);
 await config.update('open.state','.nexa/permissions.db',vscode.ConfigurationTarget.WorkspaceFolder);
 await config.update('open.environment','permissions.environment.json',vscode.ConfigurationTarget.WorkspaceFolder);
 await replace(document,document.getText().replace('implementation value 42','implementation open'));
 const installed=vscode.extensions.getExtension('Nexa-Language.nexa-lang');
 const window=require('node:module').createRequire(path.join(installed.extensionPath,'dist/openWorkbench.js'))('vscode').window;
 const original={pick:window.showQuickPick,input:window.showInputBox,error:window.showErrorMessage};const errors=[];
 window.showQuickPick=async items=>(await items)[0];window.showInputBox=async options=>options.value??'{}';window.showErrorMessage=async message=>{errors.push(message);return undefined;};
 try{
  await vscode.commands.executeCommand('nexa.open.resolve',document.uri);
  await until(async()=>{const state=await vscode.commands.executeCommand('nexa.open.status',document.uri);return state.author_activities.some(a=>a.result?.reason==='clarification_required'&&a.result.model_calls===1);},'first Author fixture call');
  await fs.writeFile(environment,permissions(false));
  await vscode.commands.executeCommand('nexa.open.resolve',document.uri);
  await until(async()=>{const state=await vscode.commands.executeCommand('nexa.open.status',document.uri);return state.author_activities.some(a=>a.result?.reason==='model_unavailable'&&a.result.model_calls===0);},'external environment revocation');
  await fs.unlink(environment);await vscode.commands.executeCommand('nexa.open.resolve',document.uri);
  assert.ok(errors.some(message=>/environment.*unavailable/i.test(message)),errors.join('\n'));
  const check=await vscode.commands.executeCommand('nexa.open.check',document.uri);assert.ok(check.program);
  console.log('HOST OPEN PASS: external environment permission revocation rebinds native Author with zero model calls; deletion blocks Resolve while Check remains provider-free');
 }finally{window.showQuickPick=original.pick;window.showInputBox=original.input;window.showErrorMessage=original.error;}
}
async function task(command,document){
 const finished=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{subscription.dispose();reject(Error('task timeout'));},60000);const subscription=vscode.tasks.onDidEndTaskProcess(event=>{if(event.execution.task.definition.type==='nexa'&&event.execution.task.definition.command===command){clearTimeout(timer);subscription.dispose();resolve(event.exitCode);}});});
 await vscode.commands.executeCommand(`nexa.${command}`,document.uri);return finished;
}
async function clarification(document,folder){
 const config=vscode.workspace.getConfiguration('nexa',document.uri);
 await fs.writeFile(path.join(folder,'fixture.environment.json'),JSON.stringify({image:'python@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704',allow_model:true,model:'fixture'}));
 await config.update('executableArgs',[process.env.NEXA_HOST_FIXTURE,'cli'],vscode.ConfigurationTarget.WorkspaceFolder);
 await config.update('open.environment','fixture.environment.json',vscode.ConfigurationTarget.WorkspaceFolder);
 const source=document.getText().replace('implementation value 42','implementation open');await replace(document,source);
 const installed=vscode.extensions.getExtension('Nexa-Language.nexa-lang');
 const targetWindow=require('node:module').createRequire(path.join(installed.extensionPath,'dist/openWorkbench.js'))('vscode').window;
 const original={pick:targetWindow.showQuickPick,input:targetWindow.showInputBox,warning:targetWindow.showWarningMessage,error:targetWindow.showErrorMessage,open:targetWindow.showOpenDialog};
 const messages=[];let conflict=true;
 targetWindow.showQuickPick=async items=>(await items)[0];
 targetWindow.showInputBox=async options=>options.title==='Answer clarification'?'42':options.value??'{}';
 targetWindow.showErrorMessage=async message=>{messages.push(message);return undefined;};
 targetWindow.showWarningMessage=async(message,_options,...choices)=>{
   if(message.includes('intent-only')&&conflict){conflict=false;await replace(document,source+'// concurrent edit\n');}
   return choices[0];
 };
 try{
  await vscode.commands.executeCommand('nexa.open.resolve',document.uri);
  let snapshot;
  await until(async()=>{snapshot=await vscode.commands.executeCommand('nexa.open.status',document.uri);return snapshot?.author_activities.some(activity=>activity.request_id);},'fixture clarification request');
  await vscode.commands.executeCommand('nexa.open.answer',document.uri);
  assert.ok(messages.some(message=>message.includes('Source or workspace configuration changed')),messages.join('\n'));
  assert.equal(await task('build',document),1,'pending source synchronization blocks stale build');
  await replace(document,source);
  await vscode.commands.executeCommand('nexa.open.syncSource',document.uri);
  assert.match(document.getText(),/Author clarification: 42/);
  assert.equal(await task('build',document),0);
  targetWindow.showOpenDialog=async()=>undefined;
  assert.equal(await task('run',document),0);
  const current=await vscode.commands.executeCommand('nexa.open.status',document.uri);
  assert.ok(current.runtime_activities.some(activity=>activity.result?.output_json==='42'));
  console.log('HOST OPEN PASS: installed command clarification → conflict preserves pending/build block → reviewed source synchronization → real OCI build/run (fixture-selected dialogs)');
 }finally{
  targetWindow.showQuickPick=original.pick;targetWindow.showInputBox=original.input;targetWindow.showWarningMessage=original.warning;targetWindow.showErrorMessage=original.error;targetWindow.showOpenDialog=original.open;
 }
}

async function maintenance(document,folder){
 const repo=path.join(folder,'repair-repo');await fs.mkdir(repo);const target=path.join(repo,'calc.py');const before='def add(a, b):\n return a - b\n';await fs.writeFile(target,before);
 const {stdout}=await require('node:util').promisify(require('node:child_process').execFile)(process.env.NEXA_PYTHON,[process.env.NEXA_HOST_FIXTURE,'patch',repo]);
 const patch=JSON.parse(stdout);
 const source='language "3.0" program Maintain(repo: Repository) { goal repair(change: ChangeRequest) -> Patch { stage runtime intent "Fix addition" capabilities [repo.read, sandbox.write] ensure checks.regression implementation value '+JSON.stringify(patch)+' } on change_request as request { let result = resolve repair(request) propose repo.apply(result) requires human.approval } }';
 const env={image:'python@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704',checks:[{name:'checks.regression',cases:[{argv:['python','-c','from calc import add; print(add(2, 3))'],expected_output:'5\n'}]}]};
 await fs.writeFile(path.join(folder,'maintenance.environment.json'),JSON.stringify(env));
 const config=vscode.workspace.getConfiguration('nexa',document.uri);
 await config.update('open.state','.nexa/maintenance.db',vscode.ConfigurationTarget.WorkspaceFolder);
 await config.update('open.environment','maintenance.environment.json',vscode.ConfigurationTarget.WorkspaceFolder);await replace(document,source);
 const installed=vscode.extensions.getExtension('Nexa-Language.nexa-lang');const window=require('node:module').createRequire(path.join(installed.extensionPath,'dist/openWorkbench.js'))('vscode').window;
 const original={pick:window.showQuickPick,input:window.showInputBox,warning:window.showWarningMessage,error:window.showErrorMessage,open:window.showOpenDialog};
 const errors=[];const confirmations=[];let conflict=true;
 window.showQuickPick=async items=>(await items)[0];window.showOpenDialog=async()=>[vscode.Uri.file(repo)];
 window.showInputBox=async options=>({'Selected repository paths':'calc.py','Change request':'Fix addition','Approval actor':'fixture-operator'}[options.title]??options.value??'change_request');
 window.showErrorMessage=async message=>{errors.push(message);return undefined;};
 window.showWarningMessage=async(message,_options,...choices)=>{confirmations.push(message);if(conflict){conflict=false;await fs.writeFile(target,'# concurrent edit\n'+before);}return choices[0];};
 try{
  assert.equal(await vscode.commands.executeCommand('nexa.open.maintain',document.uri),0);
  assert.equal(await fs.readFile(target,'utf8'),before,'proposal preserves the repository until approval');
  await vscode.commands.executeCommand('nexa.open.proposal',document.uri);
  assert.ok(vscode.workspace.textDocuments.some(item=>item.uri.scheme==='nexa-review'&&item.getText().includes('a + b')),'native per-file proposal diff');
  await vscode.commands.executeCommand('nexa.open.apply',document.uri);
  assert.ok(errors.some(message=>message.includes('workspace_conflict')),errors.join('\n'));
  assert.equal(await fs.readFile(target,'utf8'),'# concurrent edit\n'+before);
  await fs.writeFile(target,before);
  await vscode.commands.executeCommand('nexa.open.apply',document.uri);
  assert.match(await fs.readFile(target,'utf8'),/a \+ b/);assert.equal(confirmations.length,2);
  assert.ok(confirmations.every(message=>/exact proposal [a-f0-9]{64}/.test(message)));
  console.log('HOST OPEN PASS: installed maintenance → native exact diff/current evidence → explicit fixture confirmation → changed baseline rejection → exact grant/application');
 }finally{window.showQuickPick=original.pick;window.showInputBox=original.input;window.showWarningMessage=original.warning;window.showErrorMessage=original.error;window.showOpenDialog=original.open;}
}
