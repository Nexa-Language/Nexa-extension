const test = require('node:test');
const assert = require('node:assert/strict');
const open = require('../dist/openProtocol');

test('version routing preserves implicit 2.4 and rejects unsupported or malformed declarations', () => {
  assert.equal(open.languageVersion('// language "9.0"\nflow main {}'), '2.4');
  assert.equal(open.languageVersion('// header\nlanguage "3.0"\nprogram Demo {}'), '3.0');
  assert.equal(open.languageVersion('language "2.4"\nflow main {}'), '2.4');
  assert.throws(() => open.languageVersion('language "9.0"\nprogram Demo {}'), /Unsupported/);
  assert.throws(() => open.languageVersion('language nope\nprogram Demo {}'), /language declaration/);
  assert.throws(() => open.languageVersion('\uFEFFlanguage "3.0"\nprogram Demo {}'), /prefix/);
  assert.throws(() => open.languageVersion('/* header */ language "3.0"\nprogram Demo {}'), /prefix/);
});

test('native reports map goal and handler spans and full diagnostic ranges', () => {
  const span = {path:'/root/test.nx',line:3,column:5,end_line:5,end_column:6};
  const report = open.parseCheckReport({program:{language_version:'3.0',name:'Demo',goals:[{name:'answer',span}],handlers:[{event:'change_request',span}]},diagnostics:[{code:'bad',message:'bad goal',severity:'error',span}],obligations:['answer']});
  const problems = open.openProblems(report, {file:'/root/test.nx'});
  assert.deepEqual(problems[0].position, {line:2,character:4});
  assert.deepEqual(problems[0].end, {line:4,character:5});
  assert.deepEqual(open.openInspection(report, {file:'/root/test.nx'}).entries.map(e=>[e.name,e.kind,e.span.start.line]), [['answer','goals',2],['change_request','handlers',2]]);
});

test('native point diagnostics preserve the starting position and message while Outline stays strict',()=>{
 const span={path:'/root/test.nx',line:6,column:3,end_line:1,end_column:1};
 const report={program:null,diagnostics:[{code:'syntax_error',message:'Invalid Open Program syntax',severity:'error',span}],obligations:[]};
 const [problem]=open.openProblems(report,{file:'/root/test.nx'});
 assert.deepEqual(problem.position,{line:5,character:2});assert.deepEqual(problem.end,problem.position);
 assert.equal(problem.code,'syntax_error');assert.equal(problem.message,'Invalid Open Program syntax');
 assert.throws(()=>open.openInspection({...report,program:{goals:[{name:'answer',span}],handlers:[]}},{file:'/root/test.nx'}),/span order/);
 assert.throws(()=>open.openProblems({...report,diagnostics:[{...report.diagnostics[0],span:{...span,end_line:2,end_column:1}}]},{file:'/root/test.nx'}),/span order/);
});

test('intent synchronization changes only the selected JSON token inside verified goal span', () => {
  const source = 'language "3.0"\nprogram Demo {\n  // intent "not this"\n  goal answer() -> String {\n    intent "😀 old \\\"quoted\\\""\n    implementation value "intent \\\"also not this\\\""\n  }\n}\n';
  const goal = {name:'answer',intent:'😀 old "quoted"',span:{path:'test.nx',line:4,column:3,end_line:7,end_column:4}};
  const result = open.replaceIntent(source,goal,'new\nAuthor clarification: yes');
  assert.equal(result,source.replace('"😀 old \\\"quoted\\\""',JSON.stringify('new\nAuthor clarification: yes')));
  assert.throws(()=>open.replaceIntent(source,{...goal,intent:'different'},'new'),/Source intent/);
});

test('semantic equality ignores source locations but rejects any unrelated goal change', () => {
  assert.ok(open.sameProgram({goals:[{intent:'yes',span:{line:1}}]}, {goals:[{intent:'yes',span:{line:9}}]}));
  assert.ok(!open.sameProgram({goals:[{intent:'yes',return_type:'Int'}]}, {goals:[{intent:'yes',return_type:'String'}]}));
});
