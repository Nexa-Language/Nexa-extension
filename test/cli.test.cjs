const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, writeFile, readFile, realpath } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { CliRunner, describeResult, taskExitCode } = require('../dist/cli');

async function fixture(source) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'nexa process '));
  const script = path.join(cwd, 'fake cli.cjs');
  await writeFile(script, source);
  return { executable: process.execPath, args: [script], cwd, timeoutMs: 3000, maxOutputBytes: 10000 };
}

test('CLI streams stdout/stderr and preserves paths and args with spaces', async () => {
  const runner = new CliRunner();
  const spec = await fixture('console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));console.error("streamed error");');
  spec.args.push('a b.nx', '$(never executed)');
  const output = [];
  const result = await runner.run(spec, { onOutput: (text, stream) => output.push([stream,text]) });
  assert.equal(result.kind, 'exited');
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {cwd:await realpath(spec.cwd),args:['a b.nx','$(never executed)']});
  assert.match(result.stderr, /streamed error/);
  assert.ok(output.some(([stream]) => stream === 'stderr'));
  runner.dispose();
});

test('missing executables and nonzero exits are failures', async () => {
  const runner = new CliRunner();
  const spec = await fixture('process.exit(7)');
  assert.equal((await runner.run(spec)).code, 7);
  const result = await runner.run({...spec,executable:path.join(spec.cwd,'missing')});
  assert.equal(result.kind, 'spawnError');
  assert.match(describeResult(result), /executablePath/);
  assert.notEqual(taskExitCode(result), 0);
  runner.dispose();
});

test('signal termination is reported distinctly from exit zero', {skip:process.platform==='win32'}, async () => {
  const runner = new CliRunner();
  const result = await runner.run(await fixture('process.kill(process.pid,"SIGTERM")'));
  assert.equal(result.kind, 'signal');
  assert.equal(result.signal, 'SIGTERM');
  assert.notEqual(taskExitCode(result), 0);
  runner.dispose();
});

test('cancellation, deadline and output limits terminate real processes', async () => {
  const runner = new CliRunner();
  const spec = await fixture('setInterval(()=>{},1000)');
  const controller = new AbortController();
  const task = runner.run(spec, {signal:controller.signal});
  setTimeout(() => controller.abort(), 40);
  assert.equal((await task).kind, 'cancelled');
  assert.equal((await runner.run({...spec,timeoutMs:40})).kind, 'timeout');
  const flood = await fixture('setInterval(()=>console.log("x".repeat(1000)),1)');
  const result = await runner.run({...flood,maxOutputBytes:2000});
  assert.equal(result.kind, 'outputLimit');
  assert.ok(Buffer.byteLength(result.stdout) <= 2000);
  runner.dispose();
});

test('pre-cancelled work and disposed runners never execute', async () => {
  const runner = new CliRunner();
  const spec = await fixture('require("node:fs").writeFileSync("ran","yes")');
  const controller = new AbortController();
  controller.abort();
  assert.equal((await runner.run(spec,{signal:controller.signal})).kind,'cancelled');
  runner.dispose();
  assert.equal((await runner.run(spec)).kind,'cancelled');
  await assert.rejects(readFile(path.join(spec.cwd,'ran')));
});

test('shutdown waits for owned processes to terminate before returning', async () => {
  const runner = new CliRunner();
  const spec = await fixture('console.log("started");setInterval(()=>{},1000)');
  let ready;
  const started = new Promise(resolve => { ready=resolve; });
  const result = runner.run(spec,{onOutput:()=>ready()});
  await started;
  await runner.shutdown();
  assert.equal((await result).kind,'cancelled');
});

test('POSIX cancellation stops subprocess descendants, including SIGTERM-resistant children', {skip:process.platform==='win32'}, async () => {
  const runner = new CliRunner();
  const spec = await fixture(`const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'inherit'});
    console.log(child.pid);setInterval(()=>{},1000);`);
  const controller = new AbortController();
  let childPid;
  const result = await runner.run(spec,{signal:controller.signal,onOutput:text=>{
    childPid=Number(text.trim());setTimeout(()=>controller.abort(),100);
  }});
  assert.equal(result.kind,'cancelled');
  assert.ok(childPid>0);
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.throws(()=>process.kill(childPid,0));
  runner.dispose();
});
