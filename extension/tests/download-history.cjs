const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const root=path.resolve(__dirname,"..");
let handler;
let filenameHandler;
const registrations=()=>({addListener(fn){handler=fn;}});
const recentTime=new Date(Date.now()-60*1000).toISOString();
const downloads=[
  {
    id:11,tabId:10,url:"https://2.downloader.disk.yandex.ru/disk/signed?secret=DO_NOT_LEAK",
    filename:"C:\\Users\\User\\Downloads\\YandexRARRecovery\\Disk-2.rar\\README.TXT",
    state:"complete",bytesReceived:384,totalBytes:384,exists:true,startTime:recentTime
  },
  {
    id:12,tabId:-1,url:"https://2.downloader.disk.yandex.ru/disk/other?secret=DO_NOT_LEAK",
    filename:"C:\\Users\\User\\Downloads\\README.TXT",
    state:"complete",bytesReceived:20,totalBytes:20,exists:true,startTime:recentTime
  },
  {
    id:13,tabId:10,url:"https://example.org/private?password=PRIVATE",
    filename:"C:\\Users\\User\\Downloads\\PrivateSecret.csv",
    state:"complete",bytesReceived:10,totalBytes:10,exists:true,startTime:recentTime
  }
];
const chrome={
  storage:{
    session:{async get(){return {};},async set(){}},
    local:{async get(){return {};},async set(){}}
  },
  runtime:{onMessage:{addListener(fn){handler=fn;}}},
  action:{onClicked:{addListener(){}}},
  tabs:{sendMessage:async()=>({ok:true}),onRemoved:{addListener(){}}},
  downloads:{
    search:async()=>downloads,
    onCreated:{addListener(){}},
    onChanged:{addListener(){}},
    onDeterminingFilename:{addListener(fn){filenameHandler=fn;}}
  }
};
const scope={chrome,URL,setTimeout,clearTimeout};
scope.globalThis=scope;
vm.runInNewContext(fs.readFileSync(path.join(root,"common.js"),"utf8"),scope);
const bg=fs.readFileSync(path.join(root,"background.js"),"utf8")
  .replace('importScripts("common.js");','');
vm.runInNewContext(bg,scope);
assert.equal(typeof handler,"function");
function dispatch(message) {
  const sender={tab:{id:10,url:"https://disk.yandex.ru/d/test"},url:"https://disk.yandex.ru/d/test",frameId:0};
  return new Promise((resolve,reject)=>{
    const didWait=handler(message,sender,result=>resolve(result));
    if(!didWait)reject(new Error("Expected asynchronous message handler"));
    setTimeout(()=>reject(new Error("Timed out")),1500).unref();
  });
}
(async()=>{
  const x=await dispatch({kind:"RR_INSPECT_DOWNLOADS",filename:"README.TXT",folder:""});
  assert(x.ok,JSON.stringify(x));
  assert.equal(x.matches.length,2);
  assert.equal(x.matches[0].savedToRecovery,true);
  assert.equal(x.matches[0].exists,true);
  assert.equal(x.matches[1].savedToRecovery,false);
  assert(!JSON.stringify(x).includes("DO_NOT_LEAK"));
  assert(!JSON.stringify(x).includes("PRIVATE"));
  assert(!JSON.stringify(x).includes("PrivateSecret"));
  assert(!JSON.stringify(x).includes("C:"));
  const y=await dispatch({kind:"RR_INSPECT_DOWNLOADS",filename:"README.TXT",folder:"HELP"});
  assert(y.ok);
  assert(y.matches.every(v=>v.savedToRecovery===false));
  const arm=await dispatch({
    kind:"RR_ARM",token:"nested-test",key:"Disk-2.rar/HELP/SUB/NESTED.JSON",
    folder:"HELP/SUB",filename:"NESTED.JSON"
  });
  assert(arm.ok,JSON.stringify(arm));
  const suggestion=await new Promise((resolve,reject)=>{
    const handled=filenameHandler({
      id:998,tabId:10,
      url:"https://downloader.disk.yandex.ru/disk/item?token=DO_NOT_LEAK"
    },resolve);
    assert.equal(handled,true);
    setTimeout(()=>reject(new Error("No filename suggestion")),1500).unref();
  });
  assert.equal(suggestion.filename,
    "YandexRARRecovery/Disk-2.rar/HELP/SUB/NESTED.JSON");
  assert.equal(suggestion.conflictAction,"uniquify");
  assert(!JSON.stringify(suggestion).includes("DO_NOT_LEAK"));
  const release=await dispatch({kind:"RR_RELEASE",token:"nested-test"});
  assert(release.ok);
  const cross=await dispatch({
    kind:"RR_ARM",token:"cross-tab-test",key:"Disk-2.rar/README.TXT",
    folder:"",filename:"README.TXT"
  });
  assert(cross.ok);
  const mismatched=await new Promise(resolve=>{
    filenameHandler({id:1002,tabId:88,
      filename:"OTHER.TXT",
      url:"https://docviewer.yandex.ru/download"},resolve);
  });
  assert.equal(mismatched,undefined);
  const foreignTab=await new Promise(resolve=>{
    filenameHandler({id:1003,tabId:88,
      filename:"README.TXT",url:"https://docviewer.yandex.ru/download"},resolve);
  });
  assert.equal(foreignTab.filename,"YandexRARRecovery/Disk-2.rar/README.TXT");
  assert.equal(foreignTab.conflictAction,"uniquify");
  const released=await dispatch({kind:"RR_RELEASE",token:"cross-tab-test"});
  assert(released.ok);
  console.log("OK: nested paths, foreign-tab docviewer correlation, disjoint filenames, and no signed URLs");
})().catch(e=>{console.error(e);process.exitCode=1;});
