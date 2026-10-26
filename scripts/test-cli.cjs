const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { CliRunner } = require('../dist/cli');
const { parseDiagnostics, parseInspection } = require('../dist/protocol');
const {languageVersion,parseCheckReport}=require('../dist/openProtocol');

async function main() {
  const executable=process.env.NEXA_CLI;
  if(!executable) throw new Error('Set NEXA_CLI to the Nexa 3.0.0 executable.');
  const directory=await fs.mkdtemp(path.join(tmpdir(),'nexa real cli '));
  const home=path.join(directory,'home');
  await fs.mkdir(home);
  const env={HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config')};
  for(const key of ['PATH','SystemRoot','SYSTEMROOT','COMSPEC','TMPDIR','TMP','TEMP','LANG','LC_ALL']) {
    if(process.env[key] !== undefined) env[key]=process.env[key];
  }
  const runner=new CliRunner();
  const evidence=[];
  const invoke=async(command,file,extra=[])=>{
    const result=await runner.run({executable,args:[command,file,...extra],cwd:directory,env,timeoutMs:30000,maxOutputBytes:4194304});
    assert.equal(result.kind,'exited',JSON.stringify(result));
    evidence.push({command,file,...result});
    return result;
  };
  for(const [name,snippet] of Object.entries(require('../snippets/nexa.json'))) {
    const source=snippet.body.join('\n').replace(/\$\{\d+:([^}]+)\}/g,'$1');
    const file=path.join(directory,`${name}.nx`);
    await fs.writeFile(file,source+'\n');
    if(languageVersion(source)==='3.0') {
      const checked=await invoke('check',file,['--json']);
      assert.equal(checked.code,0,checked.stdout);
      assert.ok(parseCheckReport(JSON.parse(checked.stdout)).program);
      console.log(`CLI PASS: 3.0 snippet ${name}`);continue;
    }
    const validation=await invoke('validate',file,['--json']);
    assert.equal(validation.code,0,validation.stdout);
    assert.ok(!parseDiagnostics(validation.stdout,'validate',{file,folder:directory}).some(item=>item.severity==='error'));
    console.log(`CLI PASS: snippet ${name}`);
  }
  const file=path.join(directory,'Flow entry point.nx');
  const inspection=await invoke('inspect',file,['--format','json']);
  const entries=parseInspection(inspection.stdout,{file,folder:directory}).entries;
  assert.equal(entries.find(entry=>entry.name==='main').span.start.line,0);
  assert.equal((await invoke('build',file,['--harness','warn'])).code,0);
  const run=await invoke('run',file,['--harness','warn']);
  assert.equal(run.code,0);
  assert.match(run.stdout,/Hello, Nexa!/);
  const agent=path.join(directory,'Agent definition.nx');
  const tool=path.join(directory,'Typed tool.nx');
  const toolInspection=await invoke('inspect',tool,['--format','json']);
  const toolEntry=parseInspection(toolInspection.stdout,{file:tool,folder:directory}).entries.find(entry=>entry.name==='echo');
  assert.equal(toolEntry.kind,'tools');
  assert.ok(toolEntry.span);
  const harness=await invoke('harness-check',agent,['--harness','warn','--json']);
  assert.ok(parseDiagnostics(harness.stdout,'harness',{file:agent,folder:directory}).length>0);
  const invalid=path.join(directory,'invalid.nx');
  await fs.writeFile(invalid,'flow main {\n  print ;\n}\n');
  const invalidResult=await invoke('validate',invalid,['--json']);
  assert.equal(invalidResult.code,1);
  assert.ok(parseDiagnostics(invalidResult.stdout,'validate',{file:invalid,folder:directory}).some(item=>item.severity==='error'));
  const library=path.join(directory,'library.nx');
  await fs.writeFile(library,'agent Included { prompt: "Hello" }\n');
  const including=path.join(directory,'including.nx');
  await fs.writeFile(including,'include "library.nx";\nflow main { print "hello"; }\n');
  const includedResult=await invoke('inspect',including,['--format','json']);
  const included=parseInspection(includedResult.stdout,{file:including,folder:directory});
  assert.equal(included.entries.find(entry=>entry.name==='Included').span.file,await fs.realpath(library));
  const output=path.resolve(__dirname,'../.test-artifacts/cli-evidence.json');
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(output,JSON.stringify({executable,directory,evidence},null,2)+'\n');
  runner.dispose();
  console.log(`CLI PASS: build/run, validate errors, Harness warnings and include-aware source spans. Evidence: ${output}`);
}

main().catch(error=>{console.error(error);process.exitCode=1;});
