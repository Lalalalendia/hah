const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
let clock=Date.parse("2026-10-20T12:00:00Z");
class Clock extends Date{
  constructor(...args){super(...(args.length?args:[clock]));}
  static now(){return clock;}
}
const store={},hist=new Map();
const api={storage:{local:{
  async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys])
    .map(k=>[k,structuredClone(store[k])]));},
  async set(data){Object.assign(store,structuredClone(data));}
}},downloads:{async search(q){return hist.get(q.id)?[hist.get(q.id)]:[];}}};
const c={URL,Date:Clock};c.globalThis=c;vm.createContext(c);
for(const name of ["common.js","archive-scope.js","harvest-worker.js"])
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,"../"+name),"utf8"),c);
const a=c.RarRescueArchiveScope.fromYandexPublicLink("https://disk.yandex.ru/d/one","База.rar");
const b=c.RarRescueArchiveScope.fromYandexPublicLink("https://disk.yandex.ru/d/two","Другая.rar");
const worker=x=>new c.RarRescueHarvestWorker(api,c.RarRescueUtils,x);
const item=(id,name,state="in_progress",error=null)=>({
  id,tabId:13,url:"https://docviewer.yandex.ru/download?secret=DO_NOT_LOG",
  filename:name,state,error,bytesReceived:state==="complete"?150:0,
  totalBytes:150,startTime:new Date(clock).toISOString(),exists:true});
(async()=>{
  const w=worker(a);
  assert((await w.begin(13,3)).ok);
  assert.equal((await w.status()).total,3);
  await w.arm("DEEP/FOLDER","unique.bin");
  await w.dispatch("DEEP/FOLDER","unique.bin");
  await w.sent("DEEP/FOLDER","unique.bin",true);
  const started=item(1,"unique.bin");
  assert(await w.created(started));
  assert.equal((await w.determine(started)).filename,"База.rar/DEEP/FOLDER/unique.bin");
  const failed=item(1,"C:\\Downloads\\База.rar\\DEEP\\FOLDER\\unique.bin",
    "interrupted","NETWORK_FAILED");
  hist.set(1,failed);await w.changed(1,failed);
  const candidate=await w.report();
  assert.equal(candidate.summary.retryableCount,1);
  assert(candidate.retryableSourcePaths.includes("DEEP/FOLDER/unique.bin"));
  const retry=await w.arm("DEEP/FOLDER","unique.bin");
  assert(retry.retryOfInterrupted&&!retry.skipped);
  await w.dispatch("DEEP/FOLDER","unique.bin");
  await w.sent("DEEP/FOLDER","unique.bin",true);
  assert.equal((await w.report()).requests["DEEP/FOLDER/unique.bin"].retryCount,1);
  const received=item(2,"unique.bin");
  await w.created(received);
  assert.equal((await w.determine(received)).filename,"База.rar/DEEP/FOLDER/unique.bin");
  const done=item(2,"C:\\Downloads\\База.rar\\DEEP\\FOLDER\\unique.bin","complete");
  hist.set(2,done);await w.changed(2,done);
  assert.equal((await w.check("DEEP/FOLDER","unique.bin")).state,"complete");
  // A repeated onChanged event for the OLD failed download must never undo
  // successful completion of the NEW retry attempt.
  await w.changed(1,failed);
  assert.equal((await w.report()).requests["DEEP/FOLDER/unique.bin"].state,"complete");
  assert(!(await w.report()).retryableSourcePaths.includes("DEEP/FOLDER/unique.bin"));
  assert((await w.arm("DEEP/FOLDER","unique.bin")).skipped,"Never repeat complete");
  await w.arm("","missing.txt");
  await w.lookupFailed("","missing.txt","file-row-not-visible");
  assert((await w.report()).retryableSourcePaths.includes("missing.txt"));
  assert((await w.arm("","missing.txt")).retryOfNoClick);
  await w.lookupFailed("","missing.txt","not visible");
  assert((await w.arm("","missing.txt")).retryOfNoClick);
  await w.lookupFailed("","missing.txt","not visible");
  assert((await w.arm("","missing.txt")).skipped,"Bound lookup retries");
  await w.arm("","slow.dat");
  await w.dispatch("","slow.dat");await w.sent("","slow.dat",true);
  clock+=120000;
  assert.equal((await w.check("","slow.dat")).state,"timed_out");
  assert((await w.arm("","slow.dat")).skipped,"Do not retry timeout");
  await w.stop();
  const resume=worker(a);
  assert.equal((await resume.status()).total,3);
  assert((await resume.begin(13,3)).ok,"Resume must explicitly activate capture before arming");
  assert((await resume.arm("","slow.dat")).skipped);
  const other=worker(b);
  assert.equal((await other.status()).total,0);
  assert((await other.begin(14,1)).ok);
  assert.equal((await other.status()).requested,0);
  await other.arm("","unrelated.bin");
  assert.equal((await other.status()).requested,1);
  assert.equal((await resume.status()).requested,3);
  assert.notEqual(a.harvestStorageKey,b.harvestStorageKey);
  assert(!JSON.stringify(await resume.report()).includes("DO_NOT_LOG"));
  console.log("PASS: independent archives, 120s timeout, interrupted retry, no-click retries, restart and full paths");
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
