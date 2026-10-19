const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
const ctx={Date,URL};
ctx.globalThis=ctx;
for(const file of ["common.js","manifest-model.js"]){
  vm.runInNewContext(fs.readFileSync(path.join(root,file),"utf8"),ctx);
}
const dirs={
  "":{path:"",entries:[{name:"README.TXT",kind:"file"},{name:"HELP",kind:"folder"}]},
  HELP:{path:"HELP",entries:[]}
};
for(let i=2;i<=87;i++){
  const name="F"+String(i).padStart(3,"0");
  dirs[""].entries.push({name,kind:"folder"});
  dirs[name]={path:name,entries:[]};
}
for(let i=0;i<1198;i++)
  dirs.HELP.entries.push({name:"item"+String(i).padStart(4,"0")+".dat",kind:"file"});
const originalFiles={};
for(const [folder,info] of Object.entries(dirs)){
  info.empty=info.entries.length===0;
  for(const item of info.entries){
    if(item.kind!=="file")continue;
    const p=(folder?folder+"/":"")+item.name;
    originalFiles[p]={
      sourcePath:p,folder,name:item.name,
      destination:ctx.RarRescueUtils.relative(folder,item.name),
      status:"downloaded",attempts:5,bytes:55,error:""
    };
  }
}
const raw={
  schema:"rar-rescue-tree-v1",archive:"Диск 2.rar",
  expectedObjects:1286,createdAt:"2026-10-19T19:43:07.881Z",
  scanned:true,complete:true,observedObjects:1286,
  directories:dirs,files:originalFiles,issues:[],unknown:[]
};
const imported=ctx.RarRescueManifest.importManifest(raw,ctx.RarRescueUtils);
assert.equal(Object.keys(imported.directories).length,88);
assert.equal(Object.keys(imported.files).length,1199);
assert.equal(imported.files["README.TXT"].status,"pending");
assert.equal(imported.files["HELP/item0000.dat"].destination,
  "YandexRARRecovery/Disk-2.rar/HELP/item0000.dat");
assert.equal(imported.files["HELP/item0000.dat"].bytes,0);
assert.equal(imported.complete,true);
assert(imported.importedAt);
function reject(change) {
  const copy=JSON.parse(JSON.stringify(raw));
  change(copy);
  assert.throws(()=>ctx.RarRescueManifest.importManifest(copy,ctx.RarRescueUtils));
}
reject(x=>x.observedObjects=1285);
reject(x=>x.directories.HELP.entries[0].name="../evil");
reject(x=>x.files["README.TXT"].destination="../README.TXT");
reject(x=>delete x.directories.F087);
reject(x=>x.issues.push({reason:"corruption"}));
reject(x=>x.directories[""].entries.push({name:"__proto__",kind:"folder"}));
reject(x=>x.directories[""].entries.push({name:"readme.txt",kind:"file"}));
console.log("PASS: 1286-member import validation, path integrity and no false downloaded states");
