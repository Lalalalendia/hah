const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const root=path.resolve(__dirname,".."),ctx={URL,Date,setTimeout,clearTimeout};
ctx.globalThis=ctx;vm.createContext(ctx);
const noop={addListener(){}};let handler;
const stored={};let ownerReads=0,releaseFirst;
const api={
  runtime:{onMessage:{addListener(fn){handler=fn;}}},
  action:{onClicked:noop},tabs:{onRemoved:noop,sendMessage:async()=>({ok:true})},
  downloads:{onCreated:noop,onChanged:noop,onDeterminingFilename:noop,search:async()=>[]},
  storage:{
    session:{get:async()=>({}),set:async()=>{}},
    local:{
      async get(keys){
        if(keys==="rr_output_owners_v15"){
          ownerReads++;
          if(ownerReads===1)return new Promise(resolve=>{releaseFirst=resolve;});
        }
        if(Array.isArray(keys))return Object.fromEntries(keys.map(k=>[k,stored[k]]));
        return {[keys]:stored[keys]};
      },
      async set(values){Object.assign(stored,values);}
    }
  }
};
ctx.chrome=api;
for(const name of ["common.js","archive-scope.js","harvest-worker.js",
    "harvest-router.js","viewer-channel.js","message-guard.js"])
  vm.runInContext(fs.readFileSync(path.join(root,name),"utf8"),ctx);
vm.runInContext(fs.readFileSync(path.join(root,"background.js"),"utf8")
  .replace(/importScripts\([^;]+;\s*/,""),ctx);
const scopeApi=ctx.RarRescueArchiveScope;
const scope=scopeApi.fromYandexPublicLink("https://disk.yandex.ru/d/test","Archive.rar");
const collision=scopeApi.fromYandexPublicLink("https://disk.yandex.ru/d/other","archive.RAR");
function sender(url){return {frameId:0,tab:{id:12,url},url};}
function reserve(target,url){
  return new Promise(resolve=>assert.equal(handler({kind:"RR_RESERVE_OUTPUT_ROOT",scope:target},
    sender(url),resolve),true));
}
async function within(p){
  let id;
  try{return await Promise.race([p,new Promise((_,reject)=>{
    id=setTimeout(()=>reject(Error("Reservation permanently blocked")),500);
  })]);}finally{clearTimeout(id);}
}
(async()=>{
  const url="https://disk.yandex.ru/d/test";
  const old=reserve(scope,url);
  await Promise.resolve();await Promise.resolve();
  assert.equal(ownerReads,1);
  const next=await within(reserve(scope,url));
  assert.equal(next.ok,false);
  assert.match(next.error,/not finished/i);
  assert.equal(ownerReads,1,"Second request must not be queued behind poisoned Promise");
  releaseFirst({rr_output_owners_v15:{}});
  assert.equal((await within(old)).ok,true);
  assert.equal((await within(reserve(scope,url))).ok,true,
    "Successful previous reservation may be repeated idempotently");
  const foreign=await within(reserve(collision,"https://disk.yandex.ru/d/other"));
  assert.equal(foreign.ok,false);
  assert.match(foreign.error,/reserved by another archive/);
  assert.equal(stored.rr_output_owners_v15["archive.rar"],scope.scopeId);
  delete stored.rr_output_owners_v15;
  stored.rr_active_scopes_v16=[scope];
  const historicallyReserved=await within(reserve(collision,"https://disk.yandex.ru/d/other"));
  assert.equal(historicallyReserved.ok,false);
  assert.match(historicallyReserved.error,/saved registry/);
  console.log("PASS: never queue behind stalled reservation; previous root and archived registry reject collisions");
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
