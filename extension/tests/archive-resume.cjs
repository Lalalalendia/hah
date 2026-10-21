const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const root=path.resolve(__dirname,"..");
const c={URL};c.globalThis=c;vm.createContext(c);
for(const name of ["archive-scope.js","archive-resume.js"])
  vm.runInContext(fs.readFileSync(path.join(root,name),"utf8"),c);
const api=c.RarRescueArchiveScope,resume=c.RarRescueResume;
const url="https://disk.yandex.ru/client/disk";
const entries=[
  ...["10000000","HELP","IHE_PDI","JRE","PLUGINS","REPORT","XTR_CONT"]
    .map(name=>({name,kind:"folder"})),
  ...["CDVIEWER.EXE","DICOMDIR","INDEX.HTM","LOG4J.XML","README.TXT","RUN.CMD",
      "RUN.COMMAND","RUN.SH"].map(name=>({name,kind:"file"}))
];
const frame={count:8,folders:7,unknown:0,archiveName:null,iconSamples:entries};
const old=api.fromYandexViewer(url,"Yandex-RAR-159387743bd5c9f7.rar",
  api.viewerFingerprint(frame));
const freshFrame={...frame,archiveName:"Диск 1.rar"};
const detected=api.fromYandexViewer(url,"Диск 1.rar",api.viewerFingerprint(freshFrame));
assert.notEqual(detected.scopeId,old.scopeId,"Title really must have changed generated identity");
const tree={schema:"rar-rescue-tree-v2",scopeId:old.scopeId,scanned:true,complete:true,
  directories:{"":{entries}},files:Object.create(null)};
for(const entry of entries.filter(x=>x.kind==="file"))
  tree.files[entry.name]={sourcePath:entry.name,name:entry.name,folder:""};
for(let n=0;n<3019;n++){
  const name="IMAGES/image"+String(n).padStart(5,"0")+".jpg";
  tree.files[name]={sourcePath:name,name:name.split("/").at(-1),folder:"IMAGES"};
}
assert.equal(Object.keys(tree.files).length,3027);
const requests=Object.create(null);
for(const sourcePath of Object.keys(tree.files).slice(0,2165))
  requests[sourcePath]={sourcePath,expectedFullPath:old.outputRoot+"/"+sourcePath,
    state:"complete",clickConfirmedAt:1};
const capture={schema:"rar-rescue-capture-v3",scopeId:old.scopeId,
  sourcePathsCount:3027,requests,downloads:{}};
const data={
  rr_active_scopes_v16:[old],
  [old.treeStorageKey]:tree,[old.harvestStorageKey]:capture
};
const storage={async get(keys){
  return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]]));
}};
(async()=>{
  let found=await resume.find(storage,api,url,freshFrame,detected);
  assert.equal(found.scope.scopeId,old.scopeId);
  assert.equal(found.scope.outputRoot,old.outputRoot);
  assert.equal(found.processed,2165);
  assert.equal(found.tree.files["IMAGES/image00000.jpg"].name,"image00000.jpg");
  assert.equal(data.rr_output_owners_v15,undefined,"Old owner map can be missing");
  assert.equal(Object.keys(data[old.harvestStorageKey].requests).length,2165,
    "Read-only lookup never rewrites downloaded requests");
  delete data.rr_active_scopes_v16;
  assert.equal(await resume.find(storage,api,url,freshFrame,detected),null,
    "Do not guess historical identity when registry is unavailable and title changes");
  data.rr_active_scopes_v16=[old];
  const mismatched={...freshFrame,iconSamples:[...entries.slice(0,-1),
    {name:"OTHER.SH",kind:"file"}]};
  assert.equal(await resume.find(storage,api,url,mismatched,detected),null,
    "Different RAR root must never inherit old click records");
  const wrongOwner={"rr_output_owners_v15":{
    [old.outputRoot.toLowerCase()]:"foreign scope"
  }};
  Object.assign(data,wrongOwner);
  await assert.rejects(()=>resume.find(storage,api,url,freshFrame,detected),
    /принадлежит другому заданию/);
  delete data.rr_output_owners_v15;
  const altered={...requests};
  altered["IMAGES/image00000.jpg"]={...altered["IMAGES/image00000.jpg"],
    expectedFullPath:"Another.rar/IMAGES/image00000.jpg"};
  data[old.harvestStorageKey]={...capture,requests:altered};
  assert.equal(await resume.find(storage,api,url,freshFrame,detected),null,
    "Wrong output root in historical ledger must fail closed");
  console.log("PASS: 2165 existing downloads recovered with old root across viewer-title drift, no owner handshake");
})().catch(err=>{console.error(err.stack||err);process.exitCode=1;});
