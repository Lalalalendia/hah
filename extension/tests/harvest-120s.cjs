const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const base=path.resolve(__dirname,"..");
let clock=Date.parse("2026-10-20T07:00:00Z");
class Clock extends Date{
  constructor(...args){super(...(args.length?args:[clock]));}
  static now(){return clock;}
}
const store={},downloadHistory=new Map();
const chrome={storage:{local:{
  async get(keys){const data={};for(const key of Array.isArray(keys)?keys:[keys])
    data[key]=structuredClone(store[key]);return data;},
  async set(values){Object.assign(store,structuredClone(values));}
}},downloads:{async search(query){const v=downloadHistory.get(query.id);return v?[v]:[];}}};
const scope={chrome,URL,Date:Clock};scope.globalThis=scope;
vm.createContext(scope);
for(const name of ["common.js","harvest-worker.js"])
  vm.runInContext(fs.readFileSync(path.join(base,name),"utf8"),scope);
const worker=new scope.RarRescueHarvestWorker(chrome,scope.RarRescueUtils);
const source={tabId:10,url:"https://docviewer.yandex.ru/download?signature=SECRET"};
(async()=>{
  assert((await worker.begin(10,1199)).ok);
  const arm=await worker.arm("HELP/SUB","100000");
  assert(!arm.skipped);
  await worker.dispatch("HELP/SUB","100000");
  await worker.sent("HELP/SUB","100000",true);
  let result=await worker.check("HELP/SUB","100000");
  assert.equal(result.state,"waiting");
  clock+=119999;
  assert.equal((await worker.check("HELP/SUB","100000")).state,"waiting");
  clock+=1;
  assert.equal((await worker.check("HELP/SUB","100000")).state,"timed_out");
  assert((await worker.arm("HELP/SUB","100000")).skipped,
    "Never re-click a timed-out source");
  await worker.arm("REPORT","OTHER.TXT");
  await worker.dispatch("REPORT","OTHER.TXT");
  await worker.sent("REPORT","OTHER.TXT",true);
  const received={...source,id:501,filename:"OTHER.TXT",state:"in_progress"};
  assert(await worker.created(received));
  const target=await worker.determine(received);
  assert.equal(target.filename,"Disk-2.rar/REPORT/OTHER.TXT");
  downloadHistory.set(501,{...received,
    filename:"C:\\Downloads\\Disk-2.rar\\REPORT\\OTHER.TXT",
    bytesReceived:10,totalBytes:10,state:"complete",exists:true});
  await worker.changed(501,downloadHistory.get(501));
  assert.equal((await worker.check("REPORT","OTHER.TXT")).state,"complete");
  const late={...source,id:502,filename:"100000E1",state:"in_progress"};
  await worker.created(late);
  const lateRoute=await worker.determine(late);
  assert(lateRoute.filename.startsWith("Disk-2.rar/"));
  downloadHistory.set(502,{...late,filename:"C:\\Downloads\\"+lateRoute.filename.replaceAll("/","\\"),
    state:"complete",bytesReceived:7,totalBytes:7,exists:true});
  await worker.changed(502,downloadHistory.get(502));
  const report=await worker.report();
  assert.equal(report.summary.clickCount,2);
  assert.equal(report.summary.clickDispatchCount,2);
  assert.equal(report.summary.downloadStartedCount,2);
  assert.equal(report.summary.downloadCompletedCount,2);
  assert.equal(report.summary.timedOutCount,1);
  assert.equal(report.downloads["502"].serverReportedName,"100000E1");
  assert(report.downloads["502"].actualSavedFullPath.includes("100000E1"));
  assert(!JSON.stringify(report).includes("SECRET"));
  // Same filename in distinct folders remains independent, not global blocking.
  await worker.arm("PLUGINS","README.TXT");
  await worker.dispatch("PLUGINS","README.TXT");
  await worker.sent("PLUGINS","README.TXT",true);
  const sibling={...source,id:503,filename:"README.TXT",state:"in_progress"};
  await worker.created(sibling);
  assert.equal((await worker.determine(sibling)).filename,
    "Disk-2.rar/PLUGINS/README.TXT");
  // The browser's own report must not count as an archive member.
  const own={...source,id:504,filename:"Disk-2.rar-download-log.json",
    url:"blob:https://disk.yandex.ru/report"};
  assert.equal(await worker.created(own),false);
  assert.equal((await worker.determine(own)).handled,false);
  await worker.stop();
  const resumed=new scope.RarRescueHarvestWorker(chrome,scope.RarRescueUtils);
  await resumed.begin(10,1199);
  assert((await resumed.arm("HELP/SUB","100000")).skipped);
  console.log("PASS: 120s timeout then next click; no retry, late download tracked, real filename retained, distinct counters, restart");
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
