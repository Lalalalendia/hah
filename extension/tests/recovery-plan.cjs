const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const ctx={};
ctx.globalThis=ctx;
vm.runInNewContext(fs.readFileSync(
  path.resolve(__dirname,"../recovery-plan.js"),"utf8"),ctx);
const choose=ctx.RarRescuePlan.selectTwo;
function make(files){
  return {complete:true,scanned:true,observedObjects:1286,
    directories:{"":{},HELP:{},PLUGINS:{},REPORT:{},JRE:{}},
    files:Object.fromEntries(files.map(([folder,name,status])=>[
      folder+"/"+name,{folder,name,sourcePath:folder+"/"+name,status:status||"pending"}]))};
}
let tree=make([
  ["HELP","README.TXT"],["PLUGINS","README.TXT"],
  ["HELP","INDEX.HTM"],["REPORT","STATUS.XML"],["JRE","java.exe"]
]);
let found=choose(tree,{});
assert(found.ok && found.files.length===2 && found.sameBasename);
assert.deepEqual(Array.from(found.files,x=>x.folder).sort(),["HELP","PLUGINS"]);
assert.equal(found.files[0].name,"README.TXT");
assert.equal(found.files[1].name,"README.TXT");
const ledger={"Disk-2.rar/HELP/README.TXT":{state:"downloaded"}};
found=choose(tree,ledger);
assert(found.ok && !found.sameBasename);
assert.equal(new Set(found.files.map(x=>x.folder)).size,2);
assert(found.files.every(x=>x.name!=="java.exe"));
const forbidden=make([
  ["HELP","README.TXT"],["PLUGINS","README.TXT"],
  ["REPORT","status.xml","needs-review"]
]);
const l={
  "Disk-2.rar/HELP/README.TXT":{state:"awaiting"},
  "Disk-2.rar/PLUGINS/README.TXT":{state:"downloaded"}
};
assert(!choose(forbidden,l).ok);
assert(!choose({...tree,complete:false},{}).ok);
assert(!choose(make([["HELP","A.TXT"],["HELP","B.XML"]]),{}).ok);
assert(!choose(make([["JRE","jre.exe"],["JRE","config.ini"]]),{}).ok);
console.log("PASS: exact two nested files, duplicate basenames preferred, distinct parents, no already-sent or executable selections");
