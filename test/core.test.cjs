const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, mkdir, writeFile, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { resolveSettings } = require('../dist/config');
const { prepareDocument, canCheckAutomatically } = require('../dist/resources');
const { parseDiagnostics, parseInspection, toUtf16Position } = require('../dist/protocol');
const { CheckScheduler } = require('../dist/scheduler');

const base = { file: '/workspace one/main.nx', folder: '/workspace one' };

test('configuration preserves executable and argument paths with spaces', () => {
  const settings = resolveSettings({ executablePath: '/tool chain/nexa', executableArgs: ['--project', '${workspaceFolder}'] }, base);
  assert.equal(settings.executable, '/tool chain/nexa');
  assert.deepEqual(settings.args, ['--project', '/workspace one']);
  assert.equal(settings.cwd, '/workspace one');
});

test('legacy uv, Python, quoted paths and Windows backslashes migrate without a shell', () => {
  assert.deepEqual(resolveSettings({ executable: 'uv run nexa' }, base).args, ['run', 'nexa']);
  assert.deepEqual(resolveSettings({ executable: 'python -m src.cli' }, base).args, ['-m', 'src.cli']);
  assert.equal(resolveSettings({ executable: '"/tool chain/nexa"' }, base).executable, '/tool chain/nexa');
  assert.equal(resolveSettings({ executable: '"C:\\Program Files\\Python\\python.exe" -m src.cli' }, base).executable, 'C:\\Program Files\\Python\\python.exe');
  assert.throws(() => resolveSettings({ executable: '"unfinished' }, base), /quote/i);
  assert.throws(() => resolveSettings({ executablePath: '${unknown}/nexa' }, base), /variable/i);
});

test('legacy unquoted existing executable paths with spaces remain intact', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nexa executable '));
  const file = path.join(dir, 'nexa cli');
  await writeFile(file, '');
  assert.equal(resolveSettings({ executable: file }, base).executable, file);
});

test('resource configuration uses its owning root and validates limits', () => {
  assert.equal(resolveSettings({}, { file: '/root two/sub/main.nx', folder: '/root two' }).cwd, '/root two');
  assert.equal(resolveSettings({}, { file: '/stand alone/main.nx' }).cwd, '/stand alone');
  assert.throws(() => resolveSettings({ checkTimeoutMs: -1 }, base), /checkTimeoutMs/);
  assert.throws(() => resolveSettings({ executableArgs: [42] }, base), /executableArgs/);
});

function document(overrides = {}) {
  return { uri: { scheme: 'file', fsPath: '/root/main.nx' }, isUntitled: false, isDirty: true, save: async () => true, ...overrides };
}

test('save failures, thrown saves, unsafe resources and trust block command execution', async () => {
  await assert.rejects(prepareDocument(document({ save: async () => false }), () => true), /save/i);
  await assert.rejects(prepareDocument(document({ save: async () => { throw new Error('disk full'); } }), () => true), /disk full/);
  await assert.rejects(prepareDocument(document(), () => false), /trust/i);
  await assert.rejects(prepareDocument(document({ uri: { scheme: 'untitled', fsPath: 'Untitled-1' } }), () => true), /saved/i);
  await assert.rejects(prepareDocument(document({ uri: { scheme: 'file', fsPath: '/root/secret.nxs' } }), () => true), /source/i);
  let trusted = true;
  await assert.rejects(prepareDocument(document({ save: async () => { trusted = false; return true; } }), () => trusted), /trust/i);
});

test('automatic checks require trust and real workspace-contained files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexa workspace '));
  const folder = path.join(root, 'project');
  await mkdir(folder);
  const outside = path.join(root, 'outside.nx');
  const inside = path.join(folder, 'main.nx');
  await writeFile(outside, '');
  await writeFile(inside, '');
  await symlink(outside, path.join(folder, 'linked.nx'));
  assert.equal(await canCheckAutomatically(inside, folder, true), true);
  assert.equal(await canCheckAutomatically(inside, folder, false), false);
  assert.equal(await canCheckAutomatically(outside, folder, true), false);
  assert.equal(await canCheckAutomatically(path.join(folder, 'linked.nx'), folder, true), false);
});

test('diagnostics map actual validate and Harness locations and preserve file-level messages', () => {
  const validation = parseDiagnostics(JSON.stringify({ valid: false, errors: [{file: 'lib/a.nx', line: 3, column: 5, error_type: 'SyntaxError', message: 'Expected ;', fix_hint: 'Add ;'}], warnings: [] }), 'validate', base);
  assert.deepEqual(validation[0].position, { line: 2, character: 4 });
  assert.equal(validation[0].file, '/workspace one/lib/a.nx');
  assert.match(validation[0].message, /Add ;/);
  const harness = parseDiagnostics(JSON.stringify({ valid: true, errors: [], warnings: [{ location: 'C:\\folder:a\\main.nx:7:2', rule_id: 'E-001', message: 'Limit steps' }, { location: 'Agent A', message: 'Missing context' }] }), 'harness', base);
  assert.deepEqual(harness[0].position, {line: 6, character: 1});
  assert.equal(harness[1].position, undefined);
  assert.equal(harness[1].file, base.file);
});

test('malformed diagnostics are rejected instead of erasing existing errors silently', () => {
  for (const raw of ['not json', 'null', '{}', '{"valid":true,"errors":[{}],"warnings":[]}']) {
    assert.throws(() => parseDiagnostics(raw, 'validate', base));
  }
});

test('inspect without real spans produces no navigable symbols', () => {
  const result = parseInspection(JSON.stringify({ file: base.file, agents: [{ name: 'A' }], flows: [], tools: [], protocols: [], tests: [], types: [], summary: {} }), base);
  assert.equal(result.entries[0].name, 'A');
  assert.equal(result.entries[0].span, undefined);
});

test('inspect consumes 1-based exclusive source spans and retains include origins', () => {
  const raw = { agents: [{ name: 'A', source: {file: '/other/library.nx', line: 2, column: 1, end_line: 4, end_column: 2} }], flows: [], tools: [], protocols: [], tests: [], types: [] };
  const result = parseInspection(JSON.stringify(raw), base);
  assert.deepEqual(result.entries[0].span, {file:'/other/library.nx',start:{line:1,character:0},end:{line:3,character:1}});
  raw.agents[0].source.end_line = 1;
  assert.throws(() => parseInspection(JSON.stringify(raw), base), /span/);
});

test('Python code point columns map to VS Code UTF-16 offsets without guessing invalid spans', () => {
  assert.deepEqual(toUtf16Position({line:0,character:3},['a😀b;']),{line:0,character:4});
  assert.equal(toUtf16Position({line:0,character:9},['short']),undefined);
  assert.equal(toUtf16Position({line:3,character:0},['one line']),undefined);
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
test('debounced checks cancel older work and reject stale publication', async () => {
  const scheduler = new CheckScheduler(2);
  const published = [];
  const first = scheduler.schedule('a', 0, async (_signal, current) => {
    await delay(40);
    if (current()) published.push('stale');
  });
  await delay(10);
  const second = scheduler.schedule('a', 0, async (_signal, current) => {
    if (current()) published.push('new');
  });
  await Promise.all([first, second]);
  assert.deepEqual(published, ['new']);
  const closed = scheduler.schedule('a', 30, async () => published.push('closed'));
  scheduler.cancel('a');
  await closed;
  assert.deepEqual(published, ['new']);
  scheduler.dispose();
});

test('diagnostics scheduler bounds concurrency and drains on disposal', async () => {
  const scheduler = new CheckScheduler(2);
  let active = 0;
  let max = 0;
  const pending = Array.from({ length: 6 }, (_, i) => scheduler.schedule(String(i), 0, async () => {
    max = Math.max(max, ++active);
    await delay(10);
    active--;
  }));
  await Promise.all(pending);
  assert.equal(max, 2);
  scheduler.dispose();
  await scheduler.schedule('after disposal', 0, async () => assert.fail('ran after disposal'));
});
