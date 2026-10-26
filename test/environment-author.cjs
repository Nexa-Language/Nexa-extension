const fs=require('node:fs');
const readline=require('node:readline');
const argument=name=>process.argv[process.argv.indexOf(name)+1];
const environment=process.argv.includes('--environment')?argument('--environment'):undefined;
const permissions=environment?JSON.parse(fs.readFileSync(environment,'utf8')):{};
const write=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 fs.appendFileSync(argument('--log'),JSON.stringify({method:request.method,pid:process.pid,environment})+'\n');
 if(process.argv.includes('--initialize-fail'))return process.stdout.write('{broken}\n');
 if(request.method==='initialize')return write(request.id,{protocol_version:'3.0',max_inflight:1,methods:['program/check','revision/propose','goal/resolve','author/answer','events/read','activity/read','activity/cancel','evidence/explain']});
 if(process.argv.includes('--hang'))return;
 setTimeout(()=>write(request.id,{allow_model:permissions.allow_model??false,pid:process.pid,environment}),request.params.delay??0);
});
