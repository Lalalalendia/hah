const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const dir=path.resolve(__dirname,"..");
const store={},session={};let handler;
const listeners={addListener(){}};
const api={
  runtime:{onMessage:{addListener(fn){handler=fn;}}},
  action:{onClicked:listeners},
  tabs:{onRemoved:listeners,sendMessage:async()=>({ok:true})},
  downloads:{onCreated:listeners,onDeterminingFilename:listeners,
    onChanged:listeners,search:async()=>[]},
  storage:{
    session:{async get(key){return {[key]:session[key]};},
      async set(update){Object.assign(session,structuredClone(update));}},
    local:{
      async get(key){
        await new Promise(resolve=>setTimeout(resolve,4));
        return {[key]:structuredClone(store[key])};
      },
      async set(update){
        await new Promise(resolve=>setTimeout(resolve,4));
        Object.assign(store,structuredClone(update));
      }
    }
  }
};
const c={chrome:api,Date,URL,setTimeout,clearTimeout};c.globalThis=c;vm.createContext(c);
for(const file of ["common.js","archive-scope.js","harvest-worker.js","harvest-router.js","viewer-channel.js","message-guard.js"])
  vm.runInContext(fs.readFileSync(path.join(dir,file),"utf8"),c);
vm.runInContext(fs.readFileSync(path.join(dir,"background.js"),"utf8")
  .replace('importScripts("common.js","archive-scope.js","harvest-worker.js","harvest-router.js","viewer-channel.js","message-guard.js");',''),c);
function tab(id,key){
  const url="https://disk.yandex.ru/d/"+key;
  return {frameId:0,tab:{id,url},url};
}
function reserve(sender,scope){
  return new Promise((resolve,reject)=>{
    try{
      const async=handler({kind:"RR_RESERVE_OUTPUT_ROOT",scope},sender,resolve);
      assert.equal(async,true);
    }catch(e){reject(e);}
  });
}
const identity=(key,name)=>c.RarRescueArchiveScope.fromYandexPublicLink(
  "https://disk.yandex.ru/d/"+key,name);
(async()=>{
  const a=identity("a1","Archive.rar"),b=identity("b2","archive.RAR");
  const results=await Promise.all([reserve(tab(10,"a1"),a),reserve(tab(11,"b2"),b)]);
  assert.equal(results.filter(x=>x.ok).length,1,
    "Two source archives must never be reserved to one Windows folder");
  assert.equal(results.filter(x=>!x.ok).length,1);
  assert(/reserved by another archive|reservation has not finished/i.test(
    results.find(x=>!x.ok).error));
  // The second tab retries only after the first reservation finishes.
  const blocked=results[0].ok
    ? await reserve(tab(11,"b2"),b)
    : await reserve(tab(10,"a1"),a);
  assert(!blocked.ok&&/reserved by another archive/.test(blocked.error));
  const winner=results[0].ok?a:b,ownerTab=results[0].ok?tab(10,"a1"):tab(11,"b2");
  assert((await reserve(ownerTab,winner)).ok,"Idempotent reservation by same source");
  const owners=store.rr_output_owners_v15;
  assert.equal(owners["archive.rar"],winner.scopeId);
  assert.equal(Object.keys(owners).length,1);
  const other=identity("c3","Another.rar");
  assert((await reserve(tab(12,"c3"),other)).ok);
  assert.equal(Object.keys(store.rr_output_owners_v15).length,2);
  const mismatch=await reserve(tab(10,"a1"),b);
  assert(!mismatch.ok && /match.*current|public link/i.test(mismatch.error));
  console.log("PASS: concurrent output reservations are serialized, Windows collisions fail, independent roots and same-source retry succeed");
})().catch(err=>{console.error(err.stack||err);process.exitCode=1;});
