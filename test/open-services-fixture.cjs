const Module=require('node:module');
const path=require('node:path');
const vscode={workspace:{}};
const load=Module._load;
let OpenServices;
try{
 Module._load=function(id,parent,...args){return id==='vscode'?vscode:load.call(this,id,parent,...args);};
 ({OpenServices}=require('../dist/openServices'));
}finally{Module._load=load;}

exports.createServices=(folder,config)=>{
 const uri={scheme:'file',fsPath:path.join(folder,'main.nx'),toString(){return 'file://'+this.fsPath;}};
 vscode.workspace={isTrusted:true,getWorkspaceFolder:()=>({uri:{fsPath:folder}}),getConfiguration:section=>({get:name=>config[section==='nexa.open'?'open.'+name:name]})};
 return {services:new OpenServices(path.resolve(__dirname,'..')),uri};
};
