const readline = require('node:readline');
const mode = process.argv[2];
const write = (id,result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if(request.method==='initialize') return write(request.id,{protocol_version:mode==='version'?'2.4':'3.0',max_inflight:2,methods:['program/check','revision/propose','goal/resolve','author/answer','events/read','activity/read','activity/cancel','evidence/explain']});
  if(mode==='malformed') return process.stdout.write('{bad}\n');
  if(mode==='oversized') return process.stdout.write('x'.repeat(8192));
  if(mode==='exit') return process.exit(3);
  if(mode==='identity') return write(99999,{wrong:true});
  if(mode==='error') return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'Conflict',data:{code:'revision_conflict'}}})+'\n');
  if(mode==='error-frame') return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:'broken'})+'\n');
  if(mode==='hang') return;
  setTimeout(()=>write(request.id,{source:request.params.source}),request.params.delay||0);
});
