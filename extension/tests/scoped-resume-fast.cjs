const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const root=path.resolve(__dirname,".."),ctx={URL,Date,setTimeout,clearTimeout};
ctx.globalThis=ctx;vm.createContext(ctx);
let handler,legacyReads=0,allRestoreReads=0;
const noop={addListener(){}},stored={};
const chrome={
  action:{onClicked:noop},
  runtime:{onMessage:{addListener(fn){handler=fn;}}},
  tabs:{onRemoved:noop,sendMessage:async()=>({ok:true})},
  downloads:{onCreated:noop,onChanged:noop,onDeterminingFilename:noop,
    search:async()=>[]},
  storage:{
    session:{get:async()=>({}),set:async()=>{}},
    local:{
      async get(key){
        if(Array.isArray(key)&&key.includes("rr_harvest_v13")){
          legacyReads++;return new Promise(()=>{});
        }
        if(key==="rr_active_archive_v15")allRestoreReads++;
        if(Array.isArray(key))
          return Object.fromEntries(key.map(k=>[k,stored[k]]));
        return {[key]:stored[key]};
      },
      async set(x){Object.assign(stored,x);}
    }
  }
};
ctx.chrome=chrome;
for(const name of ["common.js","archive-scope.js","harvest-worker.js",
    "harvest-router.js","viewer-channel.js","message-guard.js"])
  vm.runInContext(fs.readFileSync(path.join(root,name),"utf8"),ctx);
const url="https://disk.yandex.ru/client/disk";
const scope=ctx.RarRescueArchiveScope.fromYandexViewer(url,
  "Yandex-RAR-159387743bd5c9f7.rar","3f46788dc428957a");
const requests=Object.create(null);
for(let i=0;i<2165;i++){
  const name="image"+String(i+1).padStart(5,"0")+".jpg",sourcePath="IMAGES/"+name;
  requests[sourcePath]={sourcePath,folder:"IMAGES",name,
    expectedFullPath:scope.outputRoot+"/"+sourcePath,
    state:"complete",clickConfirmedAt:1,downloadIds:[]};
}
stored.rr_active_scopes_v16=[scope];
stored[scope.harvestStorageKey]={
  schema:"rar-rescue-capture-v3",scopeId:scope.scopeId,sourcePathsCount:3027,
  phase:"tail",tabId:11,batchId:"old-batch",requests,downloads:{},audit:[]
};
vm.runInContext(fs.readFileSync(path.join(root,"background.js"),"utf8")
  .replace(/importScripts\([^;]+;\s*/,""),ctx);
const sender={frameId:0,tab:{id:11,url},url};
function call(kind,more={}){
  return new Promise(resolve=>{
    assert.equal(handler({kind,scope,...more},sender,resolve),true);
  });
}
async function bounded(p){
  let timer;try{return await Promise.race([p,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error("Scoped resume waited for all historical archives")),800);
  })]);}finally{clearTimeout(timer);}
}
(async()=>{
  assert.equal((await bounded(call("RR_HARVEST_PLAN"))).processedSourcePaths.length,2165);
  const started=await bounded(call("RR_HARVEST_BEGIN",{total:3027}));
  assert(started.ok);
  assert.equal(started.requested,2165);
  const status=await bounded(call("RR_HARVEST_STATUS"));
  assert.equal(status.requested,2165);
  const existing=await bounded(call("RR_HARVEST_ARM",{
    folder:"IMAGES",filename:"image00001.jpg"}));
  assert(existing.skipped,"Previously clicked file must NOT be clicked again");
  assert.equal(stored[scope.harvestStorageKey].requests["IMAGES/image00001.jpg"].state,"complete");
  const router=vm.runInContext("rawRouter",ctx);
  const worker=await router.bind(sender,scope);
  const newName="image02166.jpg";
  assert(!(await worker.arm("IMAGES",newName)).skipped);
  assert((await worker.dispatch("IMAGES",newName)).ok);
  assert((await worker.sent("IMAGES",newName,true)).ok);
  const item={id:5099,tabId:11,
    url:"https://docviewer.yandex.ru/download",
    filename:newName,state:"in_progress",bytesReceived:0,totalBytes:100,
    startTime:new Date().toISOString()};
  assert(await bounded(router.created(item)),"Chrome event must attach to active click");
  assert((await bounded(router.determine(item))).handled);
  const done={...item,state:"complete",bytesReceived:100,
    filename:"C:\\Downloads\\"+scope.outputRoot+"\\IMAGES\\"+newName};
  assert(await bounded(router.changed(item.id,done)));
  assert.equal(worker.state.downloads[String(item.id)].state,"complete");
  assert.equal(worker.state.requests["IMAGES/"+newName].state,"complete");
  assert.equal(legacyReads,0,"Legacy large log must not be restored for this capture");
  assert.equal(allRestoreReads,0,"Unrelated 64-archive registry must not be restored");
  assert.equal(stored.rr_active_scopes_v16.length,1,"Registry remains unchanged");
  console.log("PASS: 2165 old requests resume on exact scope without any global/legacy restore or duplicate click");
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
