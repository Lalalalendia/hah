const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const dir=path.resolve(__dirname,".."),c={URL,Date};c.globalThis=c;vm.createContext(c);
for(const file of ["common.js","archive-scope.js","harvest-worker.js","harvest-router.js","viewer-channel.js"])
  vm.runInContext(fs.readFileSync(path.join(dir,file),"utf8"),c);
const scopeApi=c.RarRescueArchiveScope;
const page="https://disk.yandex.ru/client/disk?session_token=PRIVATE#viewer";
const frame={host:"docviewer.yandex.ru",archiveName:"Диск 17.09",count:8,
  folders:1,unknown:0,iconSamples:[{name:"README.TXT",kind:"file"},
    {name:"IMAGES",kind:"folder"}]};
const fingerprint=scopeApi.viewerFingerprint(frame);
assert.match(fingerprint,/^[0-9a-f]{16}$/);
assert.equal(scopeApi.viewerFingerprint({...frame,iconSamples:[...frame.iconSamples].reverse()}),fingerprint);
assert.notEqual(scopeApi.viewerFingerprint({...frame,iconSamples:[{name:"OTHER",kind:"file"}]}),fingerprint);
const named=scopeApi.resolveName(page,[{source:"viewer",value:"Диск 17.09"}],fingerprint);
assert(named.fallback);
const scope=scopeApi.fromYandexViewer(page,named.archiveName,fingerprint);
assert.equal(scope.sourceKind,"yandex-viewer");
assert(!JSON.stringify(scope).includes("PRIVATE"));
assert(!JSON.stringify(scope).includes("README.TXT"));
assert(scopeApi.matchesTab(scope,"https://disk.yandex.ru/client/disk?another=query"));
assert(!scopeApi.matchesTab(scope,"https://disk.yandex.ru/client/disk/other"));
assert.equal(scopeApi.restoreScope(JSON.parse(JSON.stringify(scope))).scopeId,scope.scopeId);
assert.equal(scopeApi.fromYandexViewer("https://disk.yandex.ru/d/someid","Name.rar",fingerprint).sourceKind,"yandex-public");
assert.throws(()=>scopeApi.fromYandexViewer("https://evil.example/client/disk","Name.rar",fingerprint));
assert.throws(()=>scopeApi.resolveName("https://disk.yandex.ru/client/disk",[],null),/Cannot identify/);
const local={},session={};let handler;
const noop={addListener(){}};
const chrome={runtime:{onMessage:{addListener(fn){handler=fn;}}},action:{onClicked:noop},
  tabs:{onRemoved:noop,sendMessage:async()=>({ok:true})},
  downloads:{onCreated:noop,onChanged:noop,onDeterminingFilename:noop,search:async()=>[]},
  storage:{session:{async get(key){return {[key]:session[key]};},
    async set(x){Object.assign(session,x);}},
    local:{async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys])
      .map(key=>[key,local[key]]));},async set(x){Object.assign(local,x);}}}};
c.chrome=chrome;
vm.runInContext(fs.readFileSync(path.join(dir,"background.js"),"utf8")
  .replace('importScripts("common.js","archive-scope.js","harvest-worker.js","harvest-router.js","viewer-channel.js");',""),c);
function send(sender,message){return new Promise((resolve,reject)=>{
  try{assert.equal(handler(message,sender,resolve),true);}catch(err){reject(err);}
});}
(async()=>{
  const sender={frameId:0,tab:{id:11,url:page},url:page};
  assert((await send(sender,{kind:"RR_RESERVE_OUTPUT_ROOT",scope})).ok);
  assert((await send(sender,{kind:"RR_HARVEST_BEGIN",scope,total:8})).ok);
  const arm=await send(sender,{kind:"RR_HARVEST_ARM",scope,folder:"IMAGES",filename:"001.dcm"});
  assert(arm.ok&&!arm.skipped);
  assert((await send(sender,{kind:"RR_HARVEST_STATUS",scope})).total===8);
  assert((await send(sender,{kind:"RR_HARVEST_REPORT",scope})).ok);
  const alien={...sender,tab:{id:22,url:"https://disk.yandex.ru/client/disk/other"}};
  assert(!(await send(alien,{kind:"RR_HARVEST_STATUS",scope})).ok);
  assert(!JSON.stringify(local).includes("PRIVATE"));
  console.log("PASS: authenticated Yandex web viewer, no /d URL, safe scopes, reserve/begin/arm/report, cross-path isolation");
})().catch(err=>{console.error(err.stack||err);process.exitCode=1;});
