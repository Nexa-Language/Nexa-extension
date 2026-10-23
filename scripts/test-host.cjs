const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { mkdtemp, mkdir, writeFile, copyFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { CliRunner, describeResult } = require('../dist/cli');

async function main() {
  const root = path.resolve(__dirname, '..');
  const base = await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'nexa-host '));
  const script = path.join(base,'fake cli.cjs');
  await copyFile(path.join(root,'test/fake-cli.cjs'),script);
  const folders = ['root one','root two'].map(name=>path.join(base,name));
  for (const [index,folder] of folders.entries()) {
    await mkdir(path.join(folder,'.vscode'),{recursive:true});
    await writeFile(path.join(folder,'main.nx'),'flow main { print "hello"; }\n');
    await writeFile(path.join(folder,'.vscode/settings.json'),JSON.stringify({
      'nexa.executablePath':process.execPath,'nexa.executableArgs':[script,`root-${index+1}`],
      'nexa.diagnostics.delayMs':50,'nexa.checkTimeoutMs':3000,'nexa.taskTimeoutMs':3000,
    }));
    await writeFile(path.join(folder,'.vscode/tasks.json'),JSON.stringify({version:'2.0.0',tasks:[
      {type:'nexa',command:'build',file:'${workspaceFolder}/main.nx',label:`Configured build ${index+1}`},
    ]}));
  }
  const workspace = path.join(base,'smoke.code-workspace');
  await writeFile(workspace,JSON.stringify({folders:folders.map(folder=>({path:folder})),settings:{'files.autoSave':'off'}}));
  const installed = ['Code', 'Electron'].map(name => `/Applications/Visual Studio Code.app/Contents/MacOS/${name}`);
  const executable = process.env.VSCODE_EXECUTABLE_PATH ?? installed.find(file => existsSync(file)) ?? await downloadAndUnzipVSCode('1.96.4');
  const runner = new CliRunner();
  const evidence = path.join(root, '.test-artifacts');
  await mkdir(evidence, { recursive: true });
  for (const trusted of [true,false]) {
    const userData = path.join(base,trusted?'trusted profile':'restricted profile');
    await mkdir(path.join(userData,'User'),{recursive:true});
    await writeFile(path.join(userData,'User/settings.json'),JSON.stringify({
      'security.workspace.trust.enabled':true,'security.workspace.trust.startupPrompt':'never',
      'security.workspace.trust.banner':'never','telemetry.telemetryLevel':'off','update.mode':'none',
    }));
    const log = path.join(base,trusted?'trusted.jsonl':'restricted.jsonl');
    await writeFile(log,'');
    // The official runTests helper forces --disable-workspace-trust; launch directly
    // so Restricted Mode is exercised with its real trust service and isolated profile.
    const result = await runner.run({
      executable, cwd: root, timeoutMs: 60000, maxOutputBytes: 16777216,
      env:{...process.env,NEXA_TEST_LOG:log,NEXA_TEST_ROOTS:JSON.stringify(folders),NEXA_TEST_TRUSTED:String(trusted)},
      args:[workspace,'--user-data-dir',userData,'--extensions-dir',path.join(base,'extensions'),
        `--extensionDevelopmentPath=${root}`,`--extensionTestsPath=${path.join(root,'test/host-smoke.cjs')}`,
        '--skip-welcome','--skip-release-notes','--disable-updates','--disable-telemetry',
        '--disable-extension','GitHub.copilot','--disable-extension','GitHub.copilot-chat',
        ...(trusted?['--disable-workspace-trust']:[])],
    });
    const output = result.stdout + result.stderr;
    const logPath = path.join(evidence, trusted ? 'host-trusted.log' : 'host-restricted.log');
    await writeFile(logPath, output);
    if (result.kind !== 'exited' || result.code !== 0) throw new Error(`${describeResult(result)} See ${logPath}\n${output.slice(-3000)}`);
    console.log(output.split('\n').filter(line => line.includes('HOST PASS')).join('\n'));
  }
  runner.dispose();
  console.log(`Extension host smoke passed. Fixture logs: ${base}`);
}

main().catch(error=>{console.error(error);process.exitCode=1;});
