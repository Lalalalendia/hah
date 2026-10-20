const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const local={},downloads=new Map();
const api={
  storage:{local:{
    async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys])
      .map(k=>[k,structuredClone(local[k])]));},
    async set(obj){Object.assign(local,structuredClone(obj));}
  }},
  downloads:{async search(q){return downloads.get(q.id)?[downloads.get(q.id)]:[];}}
};
const c={URL,Date};c.globalThis=c;vm.createContext(c);
for(const file of ["common.js","archive-scope.js","harvest-worker.js","harvest-router.js"])
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,"../"+file),"utf8"),c);
const scopes=c.RarRescueArchiveScope;
const a=scopes.fromYandexPublicLink("https://disk.yandex.ru/d/a1","Сборник.rar");
const b=scopes.fromYandexPublicLink("https://disk.yandex.ru/d/b2","Второй.rar");
const sender=(tabId,url)=>({tab:{id:tabId,url},frameId:0});
const first=sender(11,"https://disk.yandex.ru/d/a1");
const second=sender(22,"https://disk.yandex.ru/d/b2");
const make=(id,tabId,name)=>({id,tabId,filename:name,
  url:"https://docviewer.yandex.ru/download?secret=DO_NOT_LOG",state:"in_progress",
  bytesReceived:0,totalBytes:100,startTime:new Date().toISOString()});
const router=()=>new c.RarRescueHarvestRouter(api,c.RarRescueUtils,scopes,c.RarRescueHarvestWorker);
async function claim(r,s,scope,id,name,folder){
  const worker=await r.bind(s,scope);
  await worker.arm(folder,name);
  await worker.dispatch(folder,name);
  await worker.sent(folder,name,true);
  const item=make(id,s.tab.id,name);
  assert(await r.created(item));
  const output=await r.determine(item);
  assert(output.handled);
  return {worker,item,output};
}
(async()=>{
  const r=router();
  await r.ready;
  assert((await r.start(first,a,2)).ok);
  const ar=await claim(r,first,a,101,"same.txt","FIRST");
  assert.equal(ar.output.filename,"Сборник.rar/FIRST/same.txt");
  assert((await r.start(second,b,1)).ok,"Two archive tabs can have independent queues");
  const br=await claim(r,second,b,201,"same.txt","OTHER");
  assert.equal(br.output.filename,"Второй.rar/OTHER/same.txt");
  assert.equal((await r.bind(first,a)),ar.worker);
  assert.equal((await r.bind(second,b)),br.worker);
  // Browser events are selected by tab even when names and service hosts are equal.
  const pendingA=make(102,11,"other.txt");
  assert(await r.created(pendingA));
  assert.equal((await r.determine(pendingA)).filename,"Сборник.rar/other.txt");
  const pendingB=make(202,22,"unrelated.bin");
  assert(await r.created(pendingB));
  assert.equal((await r.determine(pendingB)).filename,"Второй.rar/unrelated.bin");
  // A detached Yandex response has no unique owner while two scopes are live.
  const detached=make(250,-1,"same.txt");
  assert.equal(await r.created(detached),false);
  assert.equal((await r.determine(detached)).handled,false);
  assert.equal(local.rr_ambiguous_downloads_v16.length,1,"Quarantine by download ID");
  assert(!JSON.stringify(local).includes("DO_NOT_LOG"),"Signed URLs never enter storage");
  assert.equal(ar.worker.state.downloads["250"],undefined);
  assert.equal(br.worker.state.downloads["250"],undefined);
  // Known IDs remain with their original worker after a tab closes or another
  // archive becomes active, even if the browser reports a later completion.
  await r.removedTab(11);
  assert.equal(ar.worker.state.phase,"tail");
  const finished={...ar.item,state:"complete",bytesReceived:100,totalBytes:100,
    filename:"C:\\Downloads\\Сборник.rar\\FIRST\\same.txt"};
  downloads.set(101,finished);
  assert(await r.changed(101,finished));
  assert.equal(ar.worker.state.downloads["101"].state,"complete");
  assert(!br.worker.state.downloads["101"]);
  // A Yandex download from the old tab cannot be claimed by the new tab.
  const oldTab=make(252,11,"same.txt");
  assert.equal(await r.created(oldTab),false);
  assert.equal((await r.determine(oldTab)).handled,false);
  assert(!br.worker.state.downloads["252"],"Old tab must not leak into newer archive");
  const lateDone={...oldTab,state:"complete",bytesReceived:100,
    filename:"C:\\Downloads\\same.txt"};
  assert(await r.changed(252,lateDone));
  const unassigned=(await r.report(second,b)).unattributedBrowserDownloads;
  assert(unassigned.some(x=>x.id===252&&x.actualSavedFullPath===lateDone.filename),
    "Quarantined downloads must retain their real browser paths");
  // New service worker reconstructs BOTH archive sessions from local registry.
  const reloaded=router();
  await reloaded.ready;
  assert.equal((await reloaded.bind(first,a)).state.downloads["101"].state,"complete");
  assert.equal((await reloaded.bind(second,b)).state.downloads["201"].outputRelative,
    "Второй.rar/OTHER/same.txt");
  assert.equal((await reloaded.bind(first,a)).state.tabId,11);
  assert.equal((await reloaded.bind(second,b)).state.tabId,22);
  // Scope metadata, source URL and browser download IDs must match owner.
  await assert.rejects(()=>r.bind(first,b),/identity|match/i);
  console.log("PASS: two simultaneous archives, separate same-name paths, late event ownership, detached quarantine, restart");
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
