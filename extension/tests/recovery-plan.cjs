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
// Full-size synthetic manifest, matching the real archive file count.
const basics=[
  ["HELP","FIRST.TXT"],["HELP","SECOND.XML"],
  ["PLUGINS","CONFIG.XML"],["REPORT","README.TXT"]
];
const filler=Array.from({length:1195},(_,i)=>
  ["JRE","file"+String(i).padStart(4,"0")+".bin"]);
const all=make([...basics,...filler]);
const fillerDone=Object.fromEntries(filler.map(([folder,name])=>[
  "Disk-2.rar/"+folder+"/"+name,{state:"downloaded",bytes:3}
]));
all.files["HELP/FIRST.TXT"].status="downloaded";
const recoveryLedger={
  ...fillerDone,
  "Disk-2.rar/HELP/FIRST.TXT":{state:"downloaded"},
  "Disk-2.rar/PLUGINS/CONFIG.XML":{state:"downloaded"}
};
const work=ctx.RarRescuePlan.pendingDirectories(all,recoveryLedger);
assert(work.ok,JSON.stringify(work));
assert.equal(work.pending,2);
assert.equal(work.visitedDirectoryCount,2);
assert.equal(work.skipped,1197);
assert.equal(work.blockedCount,0);
assert.equal(work.accounted,1199);
assert.deepEqual(Array.from(work.groups,g=>g.path),["HELP","REPORT"]);
assert(!work.groups.some(g=>g.path==="PLUGINS"));
const partlyBlocked=ctx.RarRescuePlan.pendingDirectories(all,{
  ...recoveryLedger,
  "Disk-2.rar/HELP/SECOND.XML":{
    state:"needs-review",reason:"Yandex has not confirmed transfer"
  }
});
assert(partlyBlocked.ok,"one needs-review must not block everything");
assert.equal(partlyBlocked.blockedCount,1);
assert.equal(partlyBlocked.pending,1);
assert.equal(partlyBlocked.accounted,1199);
assert.equal(partlyBlocked.blocked[0].sourcePath,"HELP/SECOND.XML");
assert.deepEqual(Array.from(partlyBlocked.groups,g=>g.path),["REPORT"]);
// Same filename in another folder would be ambiguous if the delayed Chrome
// download finally appears, so BOTH source paths remain off the worklist.
const conflict=make([
  ["HELP","SERIES.HTM"],["REPORT","SERIES.HTM"],
  ["PLUGINS","OTHER.XML"],...filler,
  ["HELP","README.TXT"]
]);
const conflictResult=ctx.RarRescuePlan.pendingDirectories(conflict,{
  ...fillerDone,
  "Disk-2.rar/HELP/SERIES.HTM":{
    state:"needs-review",reason:"Late Yandex response"
  }
});
assert(conflictResult.ok);
assert.equal(conflictResult.blockedCount,1);
assert.equal(conflictResult.collisionBlockedCount,1);
assert.equal(conflictResult.pending,2);
assert(conflictResult.collisionBlocked.includes("REPORT/SERIES.HTM"));
assert(!conflictResult.groups.some(g=>g.files.some(f=>f.name==="SERIES.HTM")));
// Reproduce actual progress: 129 complete + 1 unknown, 1069 can progress.
const paths=Array.from({length:1199},(_,i)=>["JRE","FILE"+String(i).padStart(4,"0")+".dat"]);
const progressTree=make(paths);
const progressLedger=Object.fromEntries(paths.slice(0,129).map(([dir,name])=>[
  "Disk-2.rar/"+dir+"/"+name,{state:"downloaded",bytes:128}
]));
progressLedger["Disk-2.rar/JRE/FILE0129.dat"]={
  state:"needs-review",reason:"Late or interrupted transfer"
};
const progress=ctx.RarRescuePlan.pendingDirectories(progressTree,progressLedger);
assert(progress.ok);
assert.equal(progress.skipped,129);
assert.equal(progress.blockedCount,1);
assert.equal(progress.pending,1069);
assert.equal(progress.accounted,1199);
assert.equal(progress.visitedDirectoryCount,1);
assert.equal(progress.held,1);
assert.equal(ctx.RarRescuePlan.collisionName("SERIES (6).HTM"),
  ctx.RarRescuePlan.collisionName("SERIES.HTM"));
const completed=ctx.RarRescuePlan.pendingDirectories(all,
  Object.fromEntries(Object.keys(all.files).map(k=>[
    "Disk-2.rar/"+k,{state:"downloaded",bytes:1}
  ])));
assert(completed.ok && completed.pending===0 && completed.groups.length===0);
const ledgerLost=make([...basics,...filler]);
ledgerLost.files["REPORT/README.TXT"].status="downloaded";
const lostResult=ctx.RarRescuePlan.pendingDirectories(ledgerLost,fillerDone);
assert(lostResult.ok);
assert(lostResult.blocked.some(x=>x.sourcePath==="REPORT/README.TXT"));

console.log("PASS: exact two nested files, duplicate basenames preferred, distinct parents, no already-sent or executable selections");
console.log("PASS: 129 complete + 1 needs-review resumes 1069 other files, protects basename collisions and lost ledger");
