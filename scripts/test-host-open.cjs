const fs=require('node:fs/promises');
const path=require('node:path');
const {tmpdir}=require('node:os');
const {downloadAndUnzipVSCode,resolveCliArgsFromVSCodeExecutablePath}=require('@vscode/test-electron');
const {CliRunner,describeResult}=require('../dist/cli');

async function main(){
 const root=path.resolve(__dirname,'..');const manifest=require('../package.json');
 if(!process.env.NEXA_CLI||!process.env.NEXA_PYTHON)throw Error('Set NEXA_CLI and NEXA_PYTHON for native installed-package host tests.');
 const base=await fs.mkdtemp(path.join(process.platform==='darwin'?'/tmp':tmpdir(),'nexa-installed-host-'));
 const executable=process.env.VSCODE_EXECUTABLE_PATH??await downloadAndUnzipVSCode('1.96.4');
 const extensions=path.join(base,'extensions');const installation=path.join(base,'install-profile');
 const runner=new CliRunner();
 try{
  const [cli,...cliArgs]=resolveCliArgsFromVSCodeExecutablePath(executable);
  const installed=await runner.run({executable:cli,args:[...cliArgs,'--user-data-dir',installation,'--extensions-dir',extensions,'--install-extension',path.join(root,`${manifest.name}-${manifest.version}.vsix`),'--force'],cwd:base,env:process.env,timeoutMs:60000,maxOutputBytes:4194304});
  if(installed.kind!=='exited'||installed.code!==0)throw Error(installed.stdout+installed.stderr);
  const folders=['root-one','root-two'].map(name=>path.join(base,name));
  const wrapper=path.join(base,'native-cli.py');
  await fs.writeFile(wrapper,'import json, os, sys\nfrom pathlib import Path\nwith Path(os.environ["NEXA_HOST_PROCESS_LOG"]).open("a") as log:\n log.write(json.dumps({"argv":sys.argv[1:],"cwd":os.getcwd()})+"\\n")\nos.execv(os.environ["NEXA_HOST_REAL_CLI"], [os.environ["NEXA_HOST_REAL_CLI"], *sys.argv[1:]])\n');
  for(const [index,folder]of folders.entries()){
   await fs.mkdir(path.join(folder,'.vscode'),{recursive:true});
   await fs.writeFile(path.join(folder,'main.nx'),'language "3.0"\nprogram Demo {\n  goal answer() -> Int {\n    intent "Return 42 😀"\n    implementation value 42\n  }\n}\n');
   await fs.writeFile(path.join(folder,'offline.environment.json'),JSON.stringify({image:'python@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704'}));
   await fs.writeFile(path.join(folder,'.vscode/settings.json'),JSON.stringify({'nexa.executablePath':process.env.NEXA_PYTHON,'nexa.executableArgs':[wrapper],
     'nexa.open.pythonPath':process.env.NEXA_PYTHON,'nexa.open.environment':'offline.environment.json','nexa.open.programId':`root-${index+1}`,
     'nexa.diagnostics.delayMs':50,'nexa.checkTimeoutMs':10000,'nexa.taskTimeoutMs':60000}));
  }
  const workspace=path.join(base,'fixture.code-workspace');await fs.writeFile(workspace,JSON.stringify({folders:folders.map(folder=>({path:folder}))}));
  const harness=path.join(base,'harness');await fs.mkdir(harness);await fs.writeFile(path.join(harness,'package.json'),JSON.stringify({name:'nexa-package-host-test',publisher:'fixture',version:'1.0.0',engines:{vscode:'^1.96.0'}}));
  for(const trusted of [true,false]){
   const profile=path.join(base,trusted?'trusted':'restricted');await fs.mkdir(path.join(profile,'User'),{recursive:true});
   await fs.writeFile(path.join(profile,'User/settings.json'),JSON.stringify({'security.workspace.trust.enabled':true,'security.workspace.trust.startupPrompt':'never','security.workspace.trust.banner':'never','telemetry.telemetryLevel':'off','update.mode':'none'}));
   const log=path.join(base,trusted?'trusted.jsonl':'restricted.jsonl');await fs.writeFile(log,'');
   const result=await runner.run({executable,args:[workspace,'--user-data-dir',profile,'--extensions-dir',extensions,`--extensionDevelopmentPath=${harness}`,`--extensionTestsPath=${path.join(root,'test/host-open.cjs')}`,
     '--skip-welcome','--skip-release-notes','--disable-updates','--disable-telemetry',...(trusted?['--disable-workspace-trust']:[])],
     cwd:base,env:{...process.env,NEXA_HOST_ROOTS:JSON.stringify(folders),NEXA_HOST_TRUSTED:String(trusted),NEXA_HOST_PROCESS_LOG:log,NEXA_HOST_REAL_CLI:process.env.NEXA_CLI,NEXA_HOST_INSTALLED:extensions,NEXA_HOST_FIXTURE:path.join(root,'test/open-fixture.py')},timeoutMs:180000,maxOutputBytes:16777216});
   const output=result.stdout+result.stderr;await fs.mkdir(path.join(root,'.test-artifacts'),{recursive:true});await fs.writeFile(path.join(root,'.test-artifacts',trusted?'host-open-trusted.log':'host-open-restricted.log'),output);
   if(result.kind!=='exited'||result.code!==0)throw Error(`${describeResult(result)}\n${output.slice(-4000)}`);
   console.log(output.split('\n').filter(line=>line.includes('HOST OPEN PASS')).join('\n'));
  }
  await fs.writeFile(path.join(root,'.test-artifacts/installed-vsix.json'),JSON.stringify({base,extensions,executable,version:manifest.version},null,2));
 }finally{await runner.shutdown();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
