const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const base=path.resolve(__dirname,"..");
const raw=fs.readFileSync(path.join(base,"content.js"),"utf8");
const start=raw.indexOf("  let verifiedViewerTitle=null;");
const end=raw.indexOf("  function show(message)",start);
assert(start>=0&&end>start,"Cannot find owner-aware archive bootstrap");
const scopeContext={URL};scopeContext.globalThis=scopeContext;
vm.runInNewContext(fs.readFileSync(path.join(base,"archive-scope.js"),"utf8"),scopeContext);
const api=scopeContext.RarRescueArchiveScope;
const url="https://disk.yandex.ru/client/disk?secret=not-stored";
const frame={frameId:4,host:"docviewer.yandex.ru",count:8,folders:7,unknown:0,
  iconSamples:[{name:"README.TXT",kind:"file"},{name:"HELP",kind:"folder"}]};
const fingerprint=api.viewerFingerprint(frame);
const resolved=api.resolveName(url,[{source:"viewer",value:""},
  {source:"page",value:"Яндекс Диск"}],fingerprint);
const existing=api.fromYandexViewer(url,resolved.archiveName,fingerprint);
const ownerKey="rr_output_owners_v15";
const root=existing.outputRoot.normalize("NFC").toLowerCase();
function harness(owner,mode){
  const store={
    [ownerKey]:owner===null?{}:{[root]:owner},
    [existing.treeStorageKey]:{scopeId:existing.scopeId,complete:true,
      directories:{"":{}},files:{"README.TXT":{name:"README.TXT"}}}
  };
  const events=[],calls=[];
  const ctx={URL,location:{href:url},document:{title:"Яндекс Диск",
    querySelector:()=>null},frame,RarRescueArchiveScope:api,store,events,calls};
  ctx.globalThis=ctx;
  ctx.chrome={storage:{local:{async get(key){return {[key]:store[key]};}}}};
  ctx.send=async(message)=>{
    calls.push(message.kind);
    if(mode==="commit"||mode==="commit-then-close")
      store[ownerKey][root]=existing.scopeId;
    if(mode==="close"||mode==="commit-then-close")
      throw Error("Message channel closed before response");
    return {ok:true};
  };
  ctx.bestFrame=()=>frame;
  ctx.show=message=>events.push(message);
  vm.createContext(ctx);
  vm.runInContext('let scope=null,tree=null;'+raw.slice(start,end)+
    'globalThis.test={ensureArchiveScope,getScope:()=>scope,getTree:()=>tree};',ctx);
  return ctx;
}
(async()=>{
  const resumed=harness(existing.scopeId,"close");
  await resumed.test.ensureArchiveScope();
  assert.deepEqual(resumed.calls,[],"Already-owned scope must not contact broken background");
  assert.equal(resumed.test.getScope().scopeId,existing.scopeId);
  assert.equal(resumed.test.getTree().complete,true);
  assert(resumed.events.some(x=>x.includes("новый запрос регистрации не нужен")));
  const collision=harness("another-archive-scope","commit");
  await assert.rejects(()=>collision.test.ensureArchiveScope(),/закреплена за другим архивом/);
  assert.equal(collision.calls.length,0);
  assert.equal(collision.test.getScope(),null);
  const fresh=harness(null,"commit");
  await fresh.test.ensureArchiveScope();
  assert.deepEqual(fresh.calls,["RR_RESERVE_OUTPUT_ROOT"]);
  assert.equal(fresh.store[ownerKey][root],existing.scopeId);
  const late=harness(null,"commit-then-close");
  await late.test.ensureArchiveScope();
  assert.deepEqual(late.calls,["RR_RESERVE_OUTPUT_ROOT"],
    "Late committed reservation is reconciled, never blindly repeated");
  const refused=harness(null,"close");
  await assert.rejects(()=>refused.test.ensureArchiveScope(),/Message channel closed/);
  assert.deepEqual(refused.calls,["RR_RESERVE_OUTPUT_ROOT"]);
  assert.equal(refused.test.getScope(),null);
  assert.equal(refused.store[ownerKey][root],undefined);
  console.log("PASS: 2165-file resumed scope skips broken background reservation, new roots serialize, collisions fail closed");
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
