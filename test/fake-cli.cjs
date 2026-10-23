const fs = require('node:fs');
const path = require('node:path');
const [marker, command, file] = process.argv.slice(2);
const source = fs.readFileSync(file, 'utf8');
fs.appendFileSync(process.env.NEXA_TEST_LOG, JSON.stringify({marker,command,file,cwd:process.cwd()})+'\n');
const respond = () => {
  if (command === 'validate') {
    if (source.includes('MALFORMED')) { console.log('not json'); return; }
    const error = source.includes('INVALID');
    console.log(JSON.stringify({valid:!error,errors:error?[{file,line:2,column:3,message:'Expected expression',error_type:'SyntaxError',fix_hint:'Complete the expression'}]:[],warnings:[]}));
    process.exitCode = error ? 1 : 0;
  } else if (command === 'harness-check') {
    console.log(JSON.stringify({valid:true,errors:[],warnings:[{location:`${file}:1:1`,message:'Add a step limit',rule_id:'E-001',suggestion:'Use autoloop'}]}));
  } else if (command === 'inspect') {
    const end = [...source.split('\n')[0]].length + 1;
    console.log(JSON.stringify({file,agents:[],tools:[],protocols:[],flows:[
      {name:'main',source:{file,line:1,column:1,end_line:1,end_column:end}},
      {name:'included',source:{file:path.join(path.dirname(file),'library.nx'),line:1,column:1,end_line:1,end_column:5}},
    ],tests:[],types:[],summary:{total_flows:2}}));
  } else if (command === 'build' || command === 'run') {
    console.log('stdout streamed');
    console.error('stderr streamed');
    if (source.includes('HANG')) { setInterval(()=>{},1000); return; }
    if (source.includes('EXIT7')) process.exitCode = 7;
  } else {
    console.error(`Unexpected command ${command}`);
    process.exitCode = 9;
  }
};
if (source.includes('SLOW')) setTimeout(respond,1000);
else respond();
