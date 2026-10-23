const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate, label, timeout=10000) {
  const start = Date.now();
  while(Date.now()-start<timeout) { if(await predicate()) return; await sleep(40); }
  assert.fail(`Timed out: ${label}`);
}
async function calls() {
  return (await fs.readFile(process.env.NEXA_TEST_LOG,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
async function replace(document, text, save=true) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),text);
  assert.equal(await vscode.workspace.applyEdit(edit),true);
  if(save) assert.equal(await document.save(),true);
}
function completedTask(action, uri, name) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{subscription.dispose();reject(new Error(`Task ${action} timed out`));},10000);
    const subscription=vscode.tasks.onDidEndTaskProcess(event=>{
      if(event.execution.task.definition.type==='nexa' && event.execution.task.definition.command===action && (name ? event.execution.task.name===name : event.execution.task.definition.file===uri.fsPath)) {
        clearTimeout(timer);subscription.dispose();resolve(event.exitCode);
      }
    });
  });
}

exports.run = async function() {
  const roots=JSON.parse(process.env.NEXA_TEST_ROOTS);
  const trusted=process.env.NEXA_TEST_TRUSTED==='true';
  const uri=vscode.Uri.file(path.join(roots[0],'main.nx'));
  const document=await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const extension=vscode.extensions.getExtension('Nexa-Language.nexa-lang');
  assert.ok(extension,'extension manifest loaded');
  await extension.activate();
  assert.equal(vscode.workspace.isTrusted,trusted,'Workspace Trust mode');
  const commands=await vscode.commands.getCommands(true);
  for(const name of ['build','run','validate','harnessCheck','inspect','stop']) assert.ok(commands.includes(`nexa.${name}`));
  assert.equal(document.languageId,'nexa');
  if(!trusted) {
    await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',uri);
    await vscode.commands.executeCommand('nexa.validate',uri);
    await vscode.commands.executeCommand('nexa.run',uri);
    await sleep(500);
    assert.deepEqual(await calls(),[],'Restricted Mode launched no CLI process');
    console.log('HOST PASS: Restricted Mode blocks automatic checks, symbols and explicit CLI commands');
    return;
  }
  await until(()=>vscode.languages.getDiagnostics(uri).some(item=>item.code==='E-001'),'automatic Harness diagnostics');
  assert.equal(vscode.languages.getDiagnostics(uri)[0].range.start.line,0);
  const symbols=await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',uri);
  assert.deepEqual(symbols.map(symbol=>symbol.name),['main'],'Outline only includes real spans for current file');
  await replace(document,'flow main { print "😀"; }\n');
  const unicode=await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',uri);
  assert.equal(unicode[0].range.end.character,document.lineAt(0).text.length,'Unicode source span');
  await replace(document,'flow main {\n  INVALID\n}\n');
  await until(()=>vscode.languages.getDiagnostics(uri).some(item=>item.code==='SyntaxError'),'syntax Problems');
  assert.equal(vscode.languages.getDiagnostics(uri).find(item=>item.code==='SyntaxError').range.start.character,2);
  await replace(document,'flow main { print "new"; }\n',false);
  await until(()=>vscode.languages.getDiagnostics(uri).length===0,'dirty document clears stale diagnostics');
  assert.equal(await document.save(),true);
  await until(()=>vscode.languages.getDiagnostics(uri).some(item=>item.code==='E-001'),'save refreshes diagnostics');
  await replace(document,'flow main { print "MALFORMED"; }\n');
  await until(()=>vscode.languages.getDiagnostics(uri).some(item=>item.code==='cli'),'malformed JSON diagnostic');
  const before=(await calls()).length;
  await replace(document,'flow main { print "SLOW INVALID"; }\n');
  await until(async()=> (await calls()).slice(before).some(call=>call.command==='validate'),'slow check starts');
  await replace(document,'flow main { print "current"; }\n',false);
  await sleep(1200);
  assert.equal(vscode.languages.getDiagnostics(uri).length,0,'stale response never republishes');
  assert.equal(await document.save(),true);
  const secondUri=vscode.Uri.file(path.join(roots[1],'main.nx'));
  const second=await vscode.workspace.openTextDocument(secondUri);
  await vscode.window.showTextDocument(second);
  let done=completedTask('build',secondUri);
  await vscode.commands.executeCommand('nexa.build',secondUri);
  assert.equal(await done,0,'build exit code');
  const build=(await calls()).find(call=>call.command==='build'&&call.file===secondUri.fsPath);
  assert.equal(build.marker,'root-2','resource-specific settings');
  assert.equal(build.cwd,await fs.realpath(roots[1]),'resource-specific cwd');
  done=completedTask('build',secondUri,'Configured build 2');
  await vscode.commands.executeCommand('workbench.action.tasks.runTask','Configured build 2');
  assert.equal(await done,0,'configured task expands workspaceFolder and retains its label');
  await replace(second,'flow main { print "EXIT7"; }\n');
  done=completedTask('run',secondUri);
  await vscode.commands.executeCommand('nexa.run',secondUri);
  assert.equal(await done,7,'nonzero task result');
  await replace(second,'flow main { print "HANG"; }\n');
  const runCount=(await calls()).filter(call=>call.command==='run').length;
  done=completedTask('run',secondUri);
  await vscode.commands.executeCommand('nexa.run',secondUri);
  await until(async()=> (await calls()).filter(call=>call.command==='run').length>runCount,'cancellable run starts');
  await vscode.commands.executeCommand('nexa.run',secondUri);
  await vscode.commands.executeCommand('nexa.stop');
  assert.equal(await done,130,'stop task exit code');
  assert.equal((await calls()).filter(call=>call.command==='run').length,runCount+1,'same-file concurrency guard');
  await replace(second,'flow main { print "ready"; }\n');
  await vscode.commands.executeCommand('nexa.inspect',secondUri);
  assert.ok(vscode.workspace.textDocuments.some(doc=>doc.languageId==='json' && doc.getText().includes('total_flows')),'Inspect native JSON editor');
  const closingDocument = await vscode.workspace.openTextDocument(uri);
  assert.equal(closingDocument.languageId, 'nexa');
  const closed = [];
  const closeSubscription = vscode.workspace.onDidCloseTextDocument(doc => closed.push(doc.uri.toString()));
  try {
    // Changing language guarantees document close/open events; closing a tab does not.
    await vscode.languages.setTextDocumentLanguage(closingDocument, 'plaintext');
    await until(()=>closed.includes(uri.toString()),'actual document close event');
    await until(()=>vscode.languages.getDiagnostics(uri).length===0,'document close cleans Problems');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await until(()=>vscode.window.visibleTextEditors.length===0,'editor tabs close');
  }
  catch (error) {
    console.log('HOST CLOSE STATE', JSON.stringify({
      closed, open:vscode.workspace.textDocuments.map(doc=>({uri:doc.uri.toString(),closed:doc.isClosed,dirty:doc.isDirty})),
      diagnostics:vscode.languages.getDiagnostics(uri), editors:vscode.window.visibleTextEditors.map(editor=>editor.document.uri.toString()),
    }));
    throw error;
  } finally { closeSubscription.dispose(); }
  console.log('HOST PASS: activation, diagnostics, dirty/save/close lifecycle, stale output, malformed JSON, symbols, multi-root build, nonzero run, cancellation, concurrency and Inspect');
};
