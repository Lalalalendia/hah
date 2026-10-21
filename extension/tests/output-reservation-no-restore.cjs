const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const root=path.resolve(__dirname,"..");
let onMessage,readyRestoreReads=0,legacyReads=0,outputReads=0;
const db={},session={};
const noop={addListener(){}};
const chrome={
  action:{onClicked:noop},
  runtime:{onMessage:{addListener(fn){onMessage=fn;}}},
  tabs:{onRemoved:noop,sendMessage:async()=>({ok:true})},
  downloads:{onCreated:noop,onChanged:noop,onDeterminingFilename:noop,search:async()=>[]},
  storage:{
    session:{get:async()=>session,set:async x=>Object.assign(session,x)},
    local:{
      async get(keys){
        if(keys==="rr_active_scopes_v16"){
          readyRestoreReads++;
          // Simulate a service-worker restore stuck on a very large prior log.
          return new Promise(()=>{});
        }
        if(keys==="rr_output_owners_v15")outputReads++;
        if(Array.isArray(keys)&&keys.includes("rr_harvest_v13"))legacyReads++;
        if(Array.isArray(keys))return Object.fromEntries(keys.map(k=>[k,db[k]]));
        return {[keys]:db[keys]};
      },
      async set(values){Object.assign(db,values);}
    }
  }
};
const ctx={chrome,URL,Date,setTimeout,clearTimeout};ctx.globalThis=ctx;
vm.createContext(ctx);
for(const name of ["common.js","archive-scope.js","harvest-worker.js",
    "harvest-router.js","viewer-channel.js","message-guard.js"]){
  vm.runInContext(fs.readFileSync(path.join(root,name),"utf8"),ctx);
}
const main=fs.readFileSync(path.join(root,"background.js"),"utf8")
  .replace(/importScripts\([^;]+;\s*/,"");
vm.runInContext(main,ctx);
const scopeApi=ctx.RarRescueArchiveScope;
const one=scopeApi.fromYandexViewer("https://disk.yandex.ru/client/disk",
  "Example.rar","0123456789abcdef");
const two=scopeApi.fromYandexViewer("https://disk.yandex.ru/d/other",
  "example.RAR");
function request(scope,url,frameId=0){
  return new Promise(resolve=>{
    assert.equal(onMessage({kind:"RR_RESERVE_OUTPUT_ROOT",scope},{
      frameId,tab:{id:12,url},url
    },resolve),true);
  });
}
async function within(p,ms=600){
  let t;
  try{return await Promise.race([p,new Promise((_,reject)=>{
    t=setTimeout(()=>reject(Error("Reserve stalled behind unrelated restore")),ms);
  })]);}finally{clearTimeout(t);}
}
(async()=>{
  assert.equal(readyRestoreReads,0,"Cold worker must not eagerly load scoped captures");
  assert.equal(legacyReads,0,"Cold worker must not eagerly load legacy captures");
  // Bootstrap remains safe even if restoration is later initiated and stalls.
  const originalScope=scopeApi.fromYandexViewer("https://disk.yandex.ru/client/disk",
    "Example.rar","0123456789abcdef");
  assert((await within(request(originalScope,"https://disk.yandex.ru/client/disk"))).ok);
  assert.equal(readyRestoreReads,0,"Folder reservation must not start scoped restoration");
  assert.equal(legacyReads,0,"Folder reservation must not start legacy restoration");
  void vm.runInContext("rawRouter.ready",ctx);
  assert.equal(readyRestoreReads,1,"Explicit capture state request must start lazy restoration");
  assert.equal(legacyReads,1,"Legacy lookup must run only after explicit capture request");
  // Browser scan and sensor reports must also work before any large
  // session is loaded, otherwise the only user-visible button remains gray.
  function call(payload,sender){
    return new Promise(resolve=>{
      assert.equal(onMessage(payload,sender,resolve),true);
    });
  }
  const publicTab={id:21,url:"https://disk.yandex.ru/client/disk"};
  const scan=await within(call({kind:"RR_SCAN_FRAMES",requestId:"test-scan"},
    {frameId:0,tab:publicTab,url:publicTab.url}));
  assert.equal(scan.ok,true);
  const report=await within(call({kind:"RR_SENSOR_REPORT",requestId:"test-scan",
    count:8,folders:7,host:"docviewer.yandex.ru",names:["README.TXT"]},
    {frameId:7,tab:publicTab,url:"https://docviewer.yandex.ru/view"}));
  assert.equal(report.ok,true);
  const url="https://disk.yandex.ru/client/disk";
  assert.equal((await within(request(one,url))).ok,true);
  assert.equal((await within(request(one,url))).ok,true,"Same scope is idempotent");
  assert.equal(outputReads,3);
  const collision=await within(request(two,"https://disk.yandex.ru/d/other"));
  assert.equal(collision.ok,false);
  assert.match(collision.error,/reserved by another archive/);
  const unsafe=await within(request(one,"https://disk.yandex.ru/client/other"));
  assert.equal(unsafe.ok,false);
  assert.match(unsafe.error,/does not match/);
  assert.deepEqual(Object.keys(db.rr_output_owners_v15),["example.rar"]);
  assert.equal(db.rr_output_owners_v15["example.rar"],one.scopeId);
  console.log("PASS: output reservation bypasses indefinitely blocked worker restore, idempotent and collision-safe");
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
