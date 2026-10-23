const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const resources = require('../dist/resources');

const vscode = {
  workspace: {}, languages: {},
  Uri: { file: fsPath => ({ fsPath }) },
  Range: class {},
  Diagnostic: class { constructor(_range, message) { this.message = message; } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  SymbolKind: { Class: 0, Function: 1, Interface: 2, Method: 3, Struct: 4 },
};
const originalLoad = Module._load;
let NexaDiagnostics, NexaSymbols;
try {
  Module._load = function(id, parent, ...args) {
    return id === 'vscode' ? vscode : originalLoad.call(this, id, parent, ...args);
  };
  ({ NexaDiagnostics } = require('../dist/diagnostics'));
  ({ NexaSymbols } = require('../dist/symbols'));
} finally { Module._load = originalLoad; }

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function cancellation() {
  const listeners = new Set();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
  };
  return { token, cancel() { token.isCancellationRequested = true; for (const listener of listeners) listener(); } };
}

async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'request did not reach the expected lifecycle stage');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

const validation = { kind: 'exited', code: 0, stdout: '{"valid":true,"errors":[],"warnings":[{"message":"current warning"}]}', stderr: '' };
const inspection = { kind: 'exited', code: 0, stdout: '{"agents":[],"tools":[],"protocols":[],"flows":[],"tests":[],"types":[]}', stderr: '' };

function fixture(t, delayMs = 0, finishImmediately = false) {
  let folder = '/workspace';
  const uri = { fsPath: '/workspace/main.nx', scheme: 'file', toString() { return `file://${this.fsPath}`; } };
  const document = { uri, version: 1, isDirty: false, isClosed: false, getText: () => '' };
  const published = new Map();
  vscode.workspace = {
    isTrusted: true, textDocuments: [document],
    getWorkspaceFolder: () => folder ? { uri: { fsPath: folder, toString: () => folder } } : undefined,
    getConfiguration: () => ({ get: name => name === 'diagnostics.delayMs' ? delayMs : undefined }),
  };
  vscode.languages.createDiagnosticCollection = () => ({
    clear: () => published.clear(), set: (resource, values) => published.set(resource.fsPath, values), dispose() {},
  });
  const calls = [];
  const runner = { run(request, { signal }) {
    const pending = deferred();
    calls.push({ request, signal, finish: pending.resolve });
    if (finishImmediately) pending.resolve(request.args.includes('inspect') ? inspection : validation);
    return pending.promise;
  } };
  const originalCheck = resources.canCheckAutomatically;
  resources.canCheckAutomatically = async (_file, currentFolder, trusted) => Boolean(currentFolder && trusted);
  const diagnostics = new NexaDiagnostics(runner, { appendLine() {} });
  const symbols = new NexaSymbols(runner, { appendLine() {} });
  t.after(() => {
    diagnostics.dispose(); symbols.dispose();
    for (const call of calls) call.finish(inspection);
    resources.canCheckAutomatically = originalCheck;
  });
  return { document, diagnostics, symbols, calls, published, removeFolder: () => { folder = undefined; } };
}

test('cancelling old diagnostic progress leaves the replacement request running and publishable', async t => {
  const f = fixture(t);
  const old = cancellation();
  const first = f.diagnostics.check(f.document, false, ['validate'], old.token);
  await until(() => f.calls.length === 1);
  const second = f.diagnostics.check(f.document, false, ['validate']);
  await until(() => f.calls.length === 2);
  assert.equal(f.calls[0].signal.aborted, true);
  old.cancel();
  assert.equal(f.calls[1].signal.aborted, false, 'old progress must only cancel its own request');
  f.calls[0].finish({ kind: 'cancelled', code: null, stdout: '', stderr: '' });
  f.calls[1].finish(validation);
  await Promise.all([first, second]);
  assert.equal(f.published.get(f.document.uri.fsPath)[0].message, '[File-level] current warning');
});

test('invalidating automatic diagnostic preflight prevents later scheduling after folder removal', async t => {
  const f = fixture(t, 0, true);
  const preflight = deferred();
  resources.canCheckAutomatically = (_file, folder) => folder ? preflight.promise : Promise.resolve(false);
  const pending = f.diagnostics.check(f.document);
  f.removeFolder();
  f.diagnostics.invalidate(f.document);
  await f.diagnostics.check(f.document);
  preflight.resolve(true);
  await pending;
  assert.equal(f.calls.length, 0, 'invalidated preflight must launch no CLI process');
});

test('invalidating diagnostics also expires preflight while the document and folder stay unchanged', async t => {
  const f = fixture(t, 0, true);
  const preflight = deferred();
  resources.canCheckAutomatically = () => preflight.promise;
  const pending = f.diagnostics.check(f.document);
  f.diagnostics.invalidate(f.document);
  preflight.resolve(true);
  await pending;
  assert.equal(f.calls.length, 0, 'invalidation must cover preflight before it enters the scheduler');
});

test('closing a document clears published diagnostics and rejects in-flight output', async t => {
  const f = fixture(t);
  const first = f.diagnostics.check(f.document, false, ['validate']);
  await until(() => f.calls.length === 1);
  f.calls[0].finish(validation);
  await first;
  assert.equal(f.published.get(f.document.uri.fsPath).length, 1);

  const pending = f.diagnostics.check(f.document, false, ['validate']);
  await until(() => f.calls.length === 2);
  f.document.isClosed = true;
  f.diagnostics.invalidate(f.document);
  assert.equal(f.calls[1].signal.aborted, true);
  assert.equal(f.published.size, 0);
  f.calls[1].finish(validation);
  await pending;
  assert.equal(f.published.size, 0, 'late CLI output must not restore diagnostics for a closed document');
});

test('automatic diagnostics recheck folder ownership before a delayed CLI launch', async t => {
  const f = fixture(t, 30, true);
  const pending = f.diagnostics.check(f.document);
  await new Promise(resolve => setTimeout(resolve, 5));
  f.removeFolder();
  await pending;
  assert.equal(f.calls.length, 0, 'a queued check must not run outside its captured workspace');
});

for (const invalidate of [true, false]) {
  test(`symbols reject an expired preflight ${invalidate ? 'after invalidation' : 'when folder ownership changes'}`, async t => {
    const f = fixture(t, 0, true);
    const preflight = deferred();
    resources.canCheckAutomatically = () => preflight.promise;
    const pending = f.symbols.provideDocumentSymbols(f.document, cancellation().token);
    if (invalidate) f.symbols.invalidate(f.document);
    else f.removeFolder();
    preflight.resolve(true);
    assert.deepEqual(await pending, []);
    assert.equal(f.calls.length, 0, 'expired symbol preflight must launch no inspect process');
  });
}

test('cancelling old symbol progress leaves the replacement request and cache intact', async t => {
  const f = fixture(t);
  const old = cancellation();
  const first = f.symbols.inspect(f.document, old.token);
  const second = f.symbols.inspect(f.document, cancellation().token);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].signal.aborted, true);
  old.cancel();
  assert.equal(f.calls[1].signal.aborted, false);
  f.calls[0].finish(inspection); f.calls[1].finish(inspection);
  assert.equal(await first, undefined);
  assert.ok(await second);
  assert.ok(await f.symbols.inspect(f.document, cancellation().token));
  assert.equal(f.calls.length, 2, 'current inspection remains cached');
});
