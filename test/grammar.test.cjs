const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { Registry } = require('vscode-textmate');
const { loadWASM, OnigScanner, OnigString } = require('vscode-oniguruma');
const root = path.resolve(__dirname, '..');

const loaded = loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer);
const registry = new Registry({
  onigLib: loaded.then(() => ({ createOnigScanner:patterns=>new OnigScanner(patterns),createOnigString:source=>new OnigString(source) })),
  loadGrammar: async scope => JSON.parse(fs.readFileSync(path.join(root, 'syntaxes', scope === 'source.nexa' ? 'nexa.tmLanguage.json' : 'secrets.tmLanguage.json'),'utf8')),
});

async function scopeAt(source, word, scope='source.nexa') {
  const grammar = await registry.loadGrammar(scope);
  const tokens = grammar.tokenizeLine(source).tokens;
  const offset = source.indexOf(word);
  return tokens.find(token=>token.startIndex<=offset && token.endIndex>offset).scopes.join(' ');
}

test('grammar gives declarations, tool decorators, typed attributes and longest operators accurate scopes', async () => {
  assert.match(await scopeAt('flow main {','main'),/entity.name.function/);
  assert.match(await scopeAt('@tool("Echo")','tool'),/decorator/);
  assert.match(await scopeAt('fn echo(value: string): string {','echo'),/entity.name.function/);
  assert.match(await scopeAt('agent A -> Result {','->'),/arrow/);
  assert.match(await scopeAt('x = A |>> B;','|>>'),/operator.dag/);
  assert.match(await scopeAt('x => y','=>'),/operator.arrow/);
  assert.match(await scopeAt('prompt: "agent Fake {}"','Fake'),/string/);
  assert.match(await scopeAt('r"[a-z]+"','r"'),/regexp/);
  assert.match(await scopeAt('// agent Fake {}','Fake'),/comment/);
  assert.match(await scopeAt('config dev {','dev','source.nexa.secrets'),/namespace/);
});

test('grammar carries triple string and block comment state across lines', async () => {
  const grammar = await registry.loadGrammar('source.nexa');
  const open = grammar.tokenizeLine('prompt: """');
  assert.match(grammar.tokenizeLine('agent Fake {}',open.ruleStack).tokens[0].scopes.join(' '),/string.quoted.triple/);
  const comment = grammar.tokenizeLine('/* opening');
  assert.match(grammar.tokenizeLine('agent Fake {}',comment.ruleStack).tokens[0].scopes.join(' '),/comment.block/);
});

test('manifest retains commands, shortcuts, associations and an MIT package allowlist', () => {
  const manifest = require('../package.json');
  const commands = manifest.contributes.commands.map(command=>command.command);
  for (const command of ['build','run','validate','harnessCheck','inspect','stop']) assert.ok(commands.includes(`nexa.${command}`));
  assert.deepEqual(manifest.contributes.languages.flatMap(language=>language.extensions),['.nx','.nxlib','.nxs']);
  assert.equal(manifest.contributes.keybindings.find(item=>item.command==='nexa.run').key,'f5');
  assert.equal(manifest.license,'MIT');
  assert.match(fs.readFileSync(path.join(root,'LICENSE'),'utf8'),/^MIT License/);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported,'limited');
  for (const snippet of Object.values(require('../snippets/nexa.json'))) {
    assert.ok(snippet.prefix.startsWith('nx-'));
    assert.ok(Array.isArray(snippet.body));
  }
});
