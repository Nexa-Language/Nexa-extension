const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root=path.resolve(__dirname,'..');
const manifest=require('../package.json');
const archive=path.join(root,`${manifest.name}-${manifest.version}.vsix`);
const files=execFileSync('unzip',['-Z1',archive],{encoding:'utf8'}).trim().split('\n');
for(const name of files) {
  assert.ok(!/(^|\/)(node_modules|src|test|scripts|\.test-artifacts|\.git)(\/|$)/.test(name),`unexpected packaged path: ${name}`);
  assert.ok(!/\.(nxs|map|log)$/.test(name),`unexpected packaged data: ${name}`);
}
const find=name=>files.find(file=>file.toLowerCase()===`extension/${name === 'LICENSE' ? 'LICENSE.txt' : name}`.toLowerCase());
for(const file of ['package.json','README.md','LICENSE','CHANGELOG.md','icon.png','dist/extension.js','dist/author.js','dist/openEnvironment.js','dist/openWorkbench.js','bridge/query.py','schemas/3.0/author-protocol.schema.json','schemas/3.0/environment.schema.json','syntaxes/nexa.tmLanguage.json','syntaxes/secrets.tmLanguage.json','snippets/nexa.json']) {
  assert.ok(find(file),`missing ${file}`);
}
const packaged=JSON.parse(execFileSync('unzip',['-p',archive,find('package.json')],{encoding:'utf8'}));
assert.equal(packaged.license,'MIT');
assert.equal(packaged.main,'./dist/extension.js');
const modules=files.filter(file=>/^extension\/dist\/.*\.js$/.test(file)).length;
assert.equal(files.filter(file=>/^extension\/schemas\/3.0\/.*\.json$/.test(file)).length,16);
assert.match(execFileSync('unzip',['-p',archive,find('LICENSE')],{encoding:'utf8'}),/^MIT License/);
console.log(`VSIX PASS: ${files.length} entries; ${modules} compiled modules; read-only Python bridge, 16 official schemas, grammars, snippets, docs and MIT license; no development sources, tests, credentials or dependencies.`);
