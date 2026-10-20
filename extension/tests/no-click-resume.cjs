/* Regression from the real 1199-file v0.13 audit: 493 files had
 * file-row-not-visible with no click. Only these may be rearmed. */
const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const base=path.resolve(__dirname,"..");
const requests={},downloads={};
for(let i=0;i<1199;i++){
  const name="image"+String(i+1).padStart(5,"0")+".jpg";
  const sourcePath="IHE_PDI/IMAGES/"+name;
  const noClick=i<493,completed=!noClick && i<1191;
  requests[sourcePath]={
    sourcePath,folder:"IHE_PDI/IMAGES",name,
    clickId:"capture:"+i,expectedFullPath:"Disk-2.rar/"+sourcePath,
    armedAt:10000+i,dispatchAt:10000+i,deadlineAt:130000+i,
    state:noClick?"not-clicked":completed?"complete":i===1191?"timed_out":"sent-unconfirmed",
    clickConfirmedAt:noClick?0:10000+i,clickedAt:noClick?0:10000+i,
    downloadIds:completed?[i+2000]:[],
    lastError:noClick?"file-row-not-visible":null
  };
  if(completed){
    downloads[String(i+2000)]={
      downloadId:i+2000,sourcePath,state:"complete",bytes:220,
      serverReportedName:name,nameMismatch:false
    };
  }
}
// ID must not overlap source downloads (2000...3190); otherwise the
// fixture overwrites a genuine completion rather than adding a report.
downloads["999999"]={downloadId:999999,sourcePath:null,state:"complete",
  serverReportedName:"Disk-2.rar-download-log.json",bytes:12345};
const store={rr_harvest_v13:{
  schema:"rar-rescue-capture-v3",phase:"tail",tabId:10,batchId:"capture-test",
  requests,downloads,audit:[],tailDeadline:0
}};
const api={
  storage:{local:{
    async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys])
      .map(k=>[k,store[k]]));},
    async set(updates){Object.assign(store,updates);}
  }},
  downloads:{async search(){return []}}
};
const scope={chrome:api,URL};scope.globalThis=scope;vm.createContext(scope);
for(const name of ["common.js","harvest-worker.js"])
  vm.runInContext(fs.readFileSync(path.join(base,name),"utf8"),scope);
(async()=>{
  const w=new scope.RarRescueHarvestWorker(api,scope.RarRescueUtils);
  let s=await w.status();
  assert.equal(s.total,1199);
  assert.equal(s.notClickedCount,493);
  assert.equal(s.safeToRetryLookupCount,493);
  assert.equal(s.downloadCompletedCount,698,"Own JSON is not an archive file");
  await w.begin(10,1199);
  const retry=await w.arm("IHE_PDI/IMAGES","image00001.jpg");
  assert.equal(retry.skipped,false);
  assert.equal(retry.retryOfNoClick,true);
  assert((await w.arm("IHE_PDI/IMAGES","image00001.jpg")).skipped);
  const evidence=(await w.report()).requests["IHE_PDI/IMAGES/image00001.jpg"];
  assert.equal(evidence.noClickHistory.length,1);
  assert.equal(evidence.clickConfirmedAt,0);
  await w.dispatch("IHE_PDI/IMAGES","image00001.jpg");
  await w.sent("IHE_PDI/IMAGES","image00001.jpg",true);
  assert((await w.arm("IHE_PDI/IMAGES","image00001.jpg")).skipped,
    "No click can be repeated");
  for(const id of [494,1192,1199]){
    const name="image"+String(id).padStart(5,"0")+".jpg";
    assert((await w.arm("IHE_PDI/IMAGES",name)).skipped,
      "Completed/timed-out/uncertain clicks may not be rearmed: "+name);
  }
  s=await w.status();
  assert.equal(s.safeToRetryLookupCount,492);
  assert.equal(s.clickCount,707);
  assert.equal(s.clickDispatchAttempts,1200);
  console.log("PASS: 493 known non-clicks resumable, previous clicks protected, timeout protected, extension JSON excluded, audit retained");
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
