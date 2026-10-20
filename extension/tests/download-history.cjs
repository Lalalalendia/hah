const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
const session={},local={},notifications=[],downloads=[];
let messageHandler,createdHandler,changedHandler,filenameHandler;
const hooks={
  runtime:{onMessage:{addListener(fn){messageHandler=fn;}}},
  action:{onClicked:{addListener(){}}},
  tabs:{sendMessage:async(tabId,msg)=>{notifications.push({tabId,msg});return {ok:true};},
    onRemoved:{addListener(){}}},
  storage:{
    session:{async get(key){return {[key]:session[key]};},async set(obj){Object.assign(session,obj);}},
    local:{async get(key){return {[key]:local[key]};},async set(obj){Object.assign(local,obj);}}
  },
  downloads:{
    async search(query){
      if(query && Number.isInteger(query.id))return downloads.filter(x=>x.id===query.id);
      return downloads.slice().sort((a,b)=>
        Date.parse(b.startTime||"")-Date.parse(a.startTime||""));
    },
    onCreated:{addListener(fn){createdHandler=fn;}},
    onChanged:{addListener(fn){changedHandler=fn;}},
    onDeterminingFilename:{addListener(fn){filenameHandler=fn;}}
  }
};
const scope={chrome:hooks,URL,Date,setTimeout,clearTimeout};
scope.globalThis=scope;
vm.createContext(scope);
vm.runInContext(fs.readFileSync(path.join(root,"common.js"),"utf8"),scope);
vm.runInContext(fs.readFileSync(path.join(root,"archive-scope.js"),"utf8"),scope);
vm.runInContext(fs.readFileSync(path.join(root,"harvest-worker.js"),"utf8"),scope);
vm.runInContext(fs.readFileSync(path.join(root,"harvest-router.js"),"utf8"),scope);
vm.runInContext(fs.readFileSync(path.join(root,"background.js"),"utf8")
  .replace('importScripts("common.js","archive-scope.js","harvest-worker.js","harvest-router.js");',''),scope);
assert(messageHandler && createdHandler && changedHandler && filenameHandler);
const sender={tab:{id:10,url:"https://disk.yandex.ru/d/_RSlWomRWmty1w"},
  url:"https://disk.yandex.ru/d/_RSlWomRWmty1w",frameId:0};
function dispatch(message){
  return new Promise((resolve,reject)=>{
    const handled=messageHandler(message,sender,result=>resolve(result));
    if(!handled)reject(new Error("Missing async message response"));
    setTimeout(()=>reject(new Error("Background request timeout")),2500).unref();
  });
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
function downloadedItem(id,name,target,tab=77,url="https://docviewer.yandex.ru/download?secret=DO_NOT_LEAK"){
  return {
    id,tabId:tab,url,filename:target,
    state:"in_progress",bytesReceived:0,totalBytes:2229,exists:true,
    startTime:new Date().toISOString(),
    initialName:name
  };
}
async function rename(item){
  return new Promise(resolve=>{
    const handled=filenameHandler(item,resolve);
    assert(handled===true);
  });
}
(async()=>{
  const recent=downloadedItem(50,"README.TXT",
    "C:\\Users\\User\\Downloads\\README.TXT",77);
  recent.state="complete";recent.bytesReceived=2229;
  const hidden=downloadedItem(51,"secret.txt",
    "C:\\Users\\User\\Downloads\\secret.txt",10,"https://evil.example.com/?private=1");
  hidden.state="complete";hidden.bytesReceived=999;
  downloads.push(recent,hidden);
  const inspect=await dispatch({kind:"RR_INSPECT_DOWNLOADS",
    filename:"README.TXT",folder:""});
  assert(inspect.ok && inspect.matches.length===1);
  assert.equal(inspect.matches[0].savedToRecovery,false);
  assert(!JSON.stringify(inspect).includes("DO_NOT_LEAK"));
  assert(!JSON.stringify(inspect).includes("secret.txt"));
  assert(!JSON.stringify(inspect).includes("C:\\"));
  downloads.length=0;

  const key="Disk-2.rar/README.TXT";
  const arm=await dispatch({kind:"RR_ARM",token:"attempt-1",key,folder:"",
    filename:"README.TXT"});
  assert(arm.ok,JSON.stringify(arm));
  assert.equal(local.rr_ledger[key].state,"armed");
  const click=await dispatch({kind:"RR_CLICK_SENT",token:"attempt-1"});
  assert(click.ok);
  assert.equal(local.rr_ledger[key].state,"awaiting");
  const double=await dispatch({kind:"RR_ARM",token:"attempt-2",key,folder:"",
    filename:"README.TXT"});
  assert(!double.ok && /already downloaded|unresolved/i.test(double.error),double);
  // Delayed after 2 min. Old v0.5 code would have abandoned the watcher
  // after 25s and started another README (2).TXT request.
  vm.runInContext('watchers["10"].started=Date.now()-120000',scope);
  const late=downloadedItem(100,"README (6).TXT","README (6).TXT");
  downloads.push(late);
  createdHandler(late);
  await tick();
  assert.equal(session.rr_pending["10"].downloadId,100);
  const suggested=await rename(late);
  assert.equal(suggested.filename,"YandexRARRecovery/Disk-2.rar/README.TXT");
  assert.equal(suggested.conflictAction,"uniquify");
  late.filename="C:\\Users\\User\\Downloads\\"+
    "YandexRARRecovery\\Disk-2.rar\\README.TXT";
  late.state="complete";late.bytesReceived=2229;
  changedHandler({id:100,state:{current:"complete"}});
  await tick();
  assert.equal(local.rr_ledger[key].state,"downloaded");
  assert.equal(local.rr_ledger[key].bytes,2229);
  assert.equal(Object.keys(session.rr_pending).length,0);
  assert(notifications.some(n=>n.msg.kind==="RR_RESULT"&&n.msg.state==="downloaded"));
  const blockDone=await dispatch({kind:"RR_ARM",token:"attempt-3",key,folder:"",
    filename:"README.TXT"});
  assert(!blockDone.ok);
  // Unknown result must NOT automatically release or re-click.
  const nestedKey="Disk-2.rar/HELP/SUB/NESTED.JSON";
  const nested=await dispatch({kind:"RR_ARM",token:"attempt-nested",key:nestedKey,
    folder:"HELP/SUB",filename:"NESTED.JSON"});
  assert(nested.ok);
  await dispatch({kind:"RR_CLICK_SENT",token:"attempt-nested"});
  await dispatch({kind:"RR_MARK_UNKNOWN",token:"attempt-nested"});
  assert.equal(local.rr_ledger[nestedKey].state,"needs-review");
  const unrelated=await dispatch({kind:"RR_ARM",token:"other",key:"Disk-2.rar/OTHER.DAT",
    folder:"",filename:"OTHER.DAT"});
  assert(!unrelated.ok);
  // Even if the panel calls RELEASE after timeout, a confirmed click cannot
  // be forgotten; late downloads remain eligible for recovery.
  await dispatch({kind:"RR_RELEASE",token:"attempt-nested"});
  assert(session.rr_pending["10"]);
  vm.runInContext('watchers["10"].started=Date.now()-540000',scope);
  const delayed=downloadedItem(101,"NESTED.JSON","NESTED.JSON",99,
    "https://2.downloader.disk.yandex.ru/api/download");
  downloads.push(delayed);
  createdHandler(delayed);
  await tick();
  assert.equal(session.rr_pending["10"].downloadId,101);
  const newPath=await rename(delayed);
  assert.equal(newPath.filename,
    "YandexRARRecovery/Disk-2.rar/HELP/SUB/NESTED.JSON");
  delayed.filename="C:\\Users\\User\\Downloads\\"+
    "YandexRARRecovery\\Disk-2.rar\\HELP\\SUB\\NESTED.JSON";
  delayed.state="complete";delayed.bytesReceived=44;delayed.totalBytes=44;
  changedHandler({id:101,state:{current:"complete"}});
  await tick();
  assert.equal(local.rr_ledger[nestedKey].state,"downloaded");
  // A browser completion outside expected path must NOT count as a good
  // recovered file and must never be automatically retried.
  const unsafeKey="Disk-2.rar/HELP/FAIL.TXT";
  assert((await dispatch({kind:"RR_ARM",token:"path-test",key:unsafeKey,
    folder:"HELP",filename:"FAIL.TXT"})).ok);
  await dispatch({kind:"RR_CLICK_SENT",token:"path-test"});
  const wrong=downloadedItem(102,"FAIL.TXT","FAIL.TXT",10);
  downloads.push(wrong);
  createdHandler(wrong);await tick();
  wrong.filename="C:\\Users\\User\\Downloads\\FAIL (2).TXT";
  wrong.state="complete";wrong.bytesReceived=24;wrong.totalBytes=24;
  changedHandler({id:102,state:{current:"complete"}});
  await tick();
  assert.equal(local.rr_ledger[unsafeKey].state,"needs-review");
  assert(!(await dispatch({kind:"RR_ARM",token:"retry-block",key:unsafeKey,
    folder:"HELP",filename:"FAIL.TXT"})).ok);

  // A wrong-path completed transfer is explicitly reviewed but no longer
  // owns a live watcher. Another unrelated file can safely proceed.
  const reviewed=await dispatch({kind:"RR_PREPARE_RESUME"});
  assert(reviewed.ok && reviewed.active===null,JSON.stringify(reviewed));
  assert(reviewed.unresolved.some(x=>x.path==="HELP/FAIL.TXT"));
  const risky=await dispatch({kind:"RR_ARM",token:"collision",key:"Disk-2.rar/REPORT/FAIL.TXT",
    folder:"REPORT",filename:"FAIL.TXT"});
  assert(!risky.ok && /matching filename/.test(risky.error),risky);
  // Browser history may prove an unknown download arrived exactly in the
  // assigned destination. Reconcile it without clicking anything again.
  const reconciledKey="Disk-2.rar/REPORT/LATE.TXT";
  local.rr_ledger[reconciledKey]={
    state:"needs-review",filename:"LATE.TXT",
    target:"YandexRARRecovery/Disk-2.rar/REPORT/LATE.TXT",
    started:Date.now()-9*60*1000,reason:"Server delay"
  };
  const already=downloadedItem(200,"LATE.TXT",
    "C:\\Downloads\\YandexRARRecovery\\Disk-2.rar\\REPORT\\LATE.TXT");
  already.state="complete";already.bytesReceived=2229;
  downloads.push(already);
  const check=await dispatch({kind:"RR_PREPARE_RESUME"});
  assert(check.ok && check.reconciled>=1,JSON.stringify(check));
  assert.equal(local.rr_ledger[reconciledKey].state,"downloaded");
  assert.equal(local.rr_ledger[reconciledKey].bytes,2229);
  // Uncertain watcher younger than 8 minutes cannot be deferred.
  const oldKey="Disk-2.rar/HELP/UNCONFIRMED.XML";
  assert((await dispatch({kind:"RR_ARM",token:"old-click",key:oldKey,
    folder:"HELP",filename:"UNCONFIRMED.XML"})).ok);
  await dispatch({kind:"RR_CLICK_SENT",token:"old-click"});
  await dispatch({kind:"RR_MARK_UNKNOWN",token:"old-click"});
  const tooEarly=await dispatch({kind:"RR_PREPARE_RESUME"});
  assert(tooEarly.ok && tooEarly.active?.state==="waiting",JSON.stringify(tooEarly));
  assert.equal(tooEarly.deferred,0);
  assert(session.rr_pending["10"]);
  // After 9 minutes and no browser in-progress download, explicit Resume
  // review may safely defer this record, but not re-request it.
  vm.runInContext('watchers["10"].started=Date.now()-540000',scope);
  const parked=await dispatch({kind:"RR_PREPARE_RESUME"});
  assert(parked.ok && parked.active===null && parked.deferred===1,JSON.stringify(parked));
  assert(!session.rr_pending["10"]);
  assert.equal(local.rr_ledger[oldKey].state,"needs-review");
  assert(!(await dispatch({kind:"RR_ARM",token:"try-again",key:oldKey,
    folder:"HELP",filename:"UNCONFIRMED.XML"})).ok);
  assert(!(await dispatch({kind:"RR_ARM",token:"colliding-name",
    key:"Disk-2.rar/REPORT/UNCONFIRMED.XML",folder:"REPORT",
    filename:"UNCONFIRMED.XML"})).ok);
  // An unrelated file can be requested. If the old uncertain transfer
  // appears late, its different basename cannot attach to the new watcher.
  const freshKey="Disk-2.rar/HELP/NEW-UNIQUE.XML";
  assert((await dispatch({kind:"RR_ARM",token:"fresh",key:freshKey,
    folder:"HELP",filename:"NEW-UNIQUE.XML"})).ok);
  await dispatch({kind:"RR_CLICK_SENT",token:"fresh"});
  const oldLate=downloadedItem(201,"UNCONFIRMED.XML","UNCONFIRMED.XML",71);
  downloads.push(oldLate);
  createdHandler(oldLate);await tick();
  assert.equal(session.rr_pending["10"].downloadId,null);
  const unlabelled=downloadedItem(202,"","",10);
  downloads.push(unlabelled);
  createdHandler(unlabelled);await tick();
  assert.equal(session.rr_pending["10"].downloadId,null);
  const newItem=downloadedItem(203,"NEW-UNIQUE.XML","NEW-UNIQUE.XML",89);
  downloads.push(newItem);
  createdHandler(newItem);await tick();
  assert.equal(session.rr_pending["10"].downloadId,203);
  const renamed=await rename(newItem);
  assert.equal(renamed.filename,
    "YandexRARRecovery/Disk-2.rar/HELP/NEW-UNIQUE.XML");
  newItem.filename="C:\\Downloads\\YandexRARRecovery\\Disk-2.rar\\HELP\\NEW-UNIQUE.XML";
  newItem.state="complete";newItem.bytesReceived=20;newItem.totalBytes=20;
  changedHandler({id:203,state:{current:"complete"}});
  await tick();
  assert.equal(local.rr_ledger[freshKey].state,"downloaded");
  assert.equal(local.rr_ledger[oldKey].state,"needs-review");
  // A truly in-progress transfer is NOT deferred even after nine minutes.
  const activeKey="Disk-2.rar/HELP/ACTIVE.XML";
  assert((await dispatch({kind:"RR_ARM",token:"active",key:activeKey,
    folder:"HELP",filename:"ACTIVE.XML"})).ok);
  await dispatch({kind:"RR_CLICK_SENT",token:"active"});
  vm.runInContext('watchers["10"].started=Date.now()-540000',scope);
  const progress=downloadedItem(204,"ACTIVE.XML","ACTIVE.XML");
  downloads.push(progress);
  createdHandler(progress);await tick();
  const activeCheck=await dispatch({kind:"RR_PREPARE_RESUME"});
  assert(activeCheck.ok && activeCheck.active?.state==="in_progress",
    JSON.stringify(activeCheck));
  assert.equal(activeCheck.deferred,0);
  assert(session.rr_pending["10"]);
  progress.state="interrupted";progress.error="NETWORK_FAILED";
  changedHandler({id:204,state:{current:"interrupted"}});
  await tick();
  assert.equal(local.rr_ledger[activeKey].state,"needs-review");
  assert(!session.rr_pending["10"]);
  console.log("PASS: resume reconciles completed files, defers stale unknowns only after 8 min, blocks same-name retries, never captures old late downloads");

  console.log("PASS: 2/9-minute delayed events, single click, persisted uncertainty, nested paths, path mismatch and no leaked signed URLs");
})().catch(error=>{console.error(error);process.exitCode=1;});
