/* Manifest V3 service worker. All state stays on the user's machine. */
importScripts("common.js","archive-scope.js","harvest-worker.js","harvest-router.js");
"use strict";

const STATE_KEY = "rr_pending";
const LEDGER_KEY = "rr_ledger";
const rawRouter=new globalThis.RarRescueHarvestRouter(
  chrome,RarRescueUtils,RarRescueArchiveScope,RarRescueHarvestWorker);
const watchers={};
const ready=Promise.all([
  chrome.storage.session.get(STATE_KEY),
  rawRouter.ready
]).then(([session])=>{
  Object.assign(watchers,session[STATE_KEY]||{});
}).catch(()=>{});

async function saveWatchers() {
  await chrome.storage.session.set({ [STATE_KEY]: watchers });
}

function pageAllowed(sender) {
  if (!sender || !sender.tab || !Number.isInteger(sender.tab.id)) return false;
  try { const topHost = new URL(sender.tab.url).hostname;
    const frameHost = new URL(sender.url || sender.tab.url).hostname;
    return topHost === "disk.yandex.ru" &&
      ["disk.yandex.ru", "docviewer.yandex.ru", "docviewer.360.yandex.ru"].includes(frameHost); }
  catch (_) { return false; }
}

async function notify(tabId, payload) {
  try { await chrome.tabs.sendMessage(tabId, payload, { frameId: 0 }); }
  catch (_) { /* Page was navigated or closed; ledger still survives. */ }
}

function findByDownloadId(id) {
  return Object.values(watchers).find(w => w.downloadId === id);
}

const PENDING_WINDOW_MS = 15 * 60 * 1000;
function sameExpectedFile(filename, expected) {
  const base=String(filename || "").replace(/\\/g,"/").split("/").pop().toLowerCase();
  const name=String(expected || "").toLowerCase();
  if (!base || !name) return false;
  if (base === name) return true;
  // Browsers may pre-uniquify Yandex's filename as README (6).TXT.
  const dot=name.lastIndexOf(".");
  const stem=dot<0?name:name.slice(0,dot);
  const ext=dot<0?"":name.slice(dot);
  if (!base.startsWith(stem+" (") || !base.endsWith(")"+ext)) return false;
  const digits=base.slice((stem+" (").length,base.length-(")"+ext).length);
  return /^[1-9][0-9]{0,3}$/.test(digits);
}
function downloadEligible(item, record, now=Date.now()) {
  if (!item || !record || !RarRescueUtils.isDownloadHost(item.url || item.finalUrl || "")) return false;
  if (now-record.started > PENDING_WINDOW_MS || record.downloadId!=null && record.downloadId!==item.id) return false;
  const base=String(item.filename||"").replace(/\\/g,"/").split("/").pop();
  if (base) return sameExpectedFile(base,record.filename);
  // An unlabelled download is ambiguous if the viewer can deliver older
  // requests late. Wait until Chrome supplies its filename instead of
  // claiming it based only on the tab ID.
  return false;
}
function findActiveWatcher(item) {
  const records=Object.values(watchers).filter(w=>w && w.downloadId==null &&
    Date.now()-w.started<PENDING_WINDOW_MS);
  if(records.length!==1)return null;
  return downloadEligible(item,records[0]) ? records[0] : null;
}
async function markReview(record,reason){
  if(watchers[String(record.tabId)]!==record)return;
  const ledger=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY] || {};
  if(ledger[record.key]?.state==="downloaded")return;
  ledger[record.key]={
    state:"needs-review",reason:String(reason||"Unconfirmed delayed download").slice(0,160),
    time:new Date().toISOString(),token:record.token,filename:record.filename,
    target:record.target,started:record.started,downloadId:record.downloadId
  };
  await chrome.storage.local.set({[LEDGER_KEY]:ledger});
}
async function complete(record,status,reason,item){
  if(watchers[String(record.tabId)]!==record)return;
  const ledger=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY] || {};
  ledger[record.key]={
    state:status,reason:String(reason||"").slice(0,160),
    bytes:Number(item?.bytesReceived)||0,time:new Date().toISOString(),
    downloadId:item?.id??record.downloadId,target:record.target,
    // Keep identity even on wrong-path / interrupted completion. Otherwise
    // a later same-name file in another folder may be incorrectly captured.
    filename:record.filename,started:record.started,token:record.token
  };
  await chrome.storage.local.set({[LEDGER_KEY]:ledger});
  delete watchers[String(record.tabId)];
  await saveWatchers();
  await notify(record.tabId,{
    kind:"RR_RESULT",token:record.token,key:record.key,state:status,
    reason:ledger[record.key].reason,bytes:ledger[record.key].bytes
  });
}
async function completeFromChrome(record,item) {
  if(!item || item.state!=="complete" && item.state!=="interrupted")return false;
  if(item.state==="interrupted"){
    await complete(record,"needs-review",item.error||"Browser download interrupted",item);
    return true;
  }
  const bytes=Number(item.bytesReceived)||0;
  const total=Number(item.totalBytes)||0;
  const path=String(item.filename||"").replace(/\\/g,"/");
  const expected=String(record.target||"").toLowerCase();
  const correct=path.toLowerCase().endsWith("/"+expected);
  const valid=bytes>0 && (!total||bytes===total) && item.exists!==false && correct;
  await complete(record,valid?"downloaded":"needs-review",
    valid?"Completed, size nonzero; checksum not verified":
      (!correct?"Download completed outside required directory":
      (item.exists===false?"Downloaded file no longer exists":"Unverified downloaded bytes")),item);
  return true;
}
async function latestAttemptItem(record) {
  const rows=await chrome.downloads.search({limit:100,orderBy:["-startTime"]});
  const candidates=rows.filter(item=>{
    const started=Date.parse(item.startTime||"");
    return Number.isFinite(started) && started>=record.started-10000 &&
      downloadEligible(item,record);
  });
  candidates.sort((a,b)=>{
    const exactA=String(a.filename||"").replace(/\\/g,"/").toLowerCase().endsWith("/"+record.target.toLowerCase())?1:0;
    const exactB=String(b.filename||"").replace(/\\/g,"/").toLowerCase().endsWith("/"+record.target.toLowerCase())?1:0;
    return exactB-exactA;
  });
  return candidates[0]||null;
}

chrome.action.onClicked.addListener(async tab => {
  if (!tab || !tab.id || !tab.url || !tab.url.startsWith("https://disk.yandex.ru/")) return;
  try { await chrome.tabs.sendMessage(tab.id, { kind: "RR_TOGGLE" }, { frameId: 0 }); }
  catch (_) { /* Content script not yet loaded. */ }
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || !String(message.kind || "").startsWith("RR_")) return false;
  (async () => {
    await ready;
    if (!pageAllowed(sender)) throw new Error("Not a Yandex Disk tab");
    const tabId = sender.tab.id;
    if (message.kind === "RR_SENSOR_REPORT" || message.kind === "RR_SENSOR_PICKED") {
      const allowed = message.kind === "RR_SENSOR_REPORT" ?
        ["kind", "requestId", "host", "names", "count", "folders", "unknown", "rowSelector", "example", "iconSamples", "archiveName"] :
        ["kind", "host", "found", "name", "ancestry", "clickedTag", "count"];
      const sanitized = {};
      for (const field of allowed) if (Object.prototype.hasOwnProperty.call(message, field)) sanitized[field] = message[field];
      sanitized.frameId = sender.frameId;
      await notify(tabId, sanitized);
      respond({ ok: true });
      return;
    }
    if (message.kind === "RR_SCAN_FRAMES") {
      if (sender.frameId !== 0) throw new Error("Only the top-level panel can scan");
      const id = String(message.requestId || "").slice(0, 80);
      await chrome.tabs.sendMessage(tabId, { kind: "RR_SENSOR_SCAN", requestId: id });
      respond({ ok: true });
      return;
    }
    if (message.kind === "RR_PICK_FILE" || message.kind === "RR_STOP_PICK") {
      if (sender.frameId !== 0) throw new Error("Only the top-level panel can pick");
      const kind = message.kind === "RR_PICK_FILE" ? "RR_SENSOR_START_PICK" : "RR_SENSOR_STOP_PICK";
      await chrome.tabs.sendMessage(tabId, { kind });
      respond({ ok: true });
      return;
    }
    if (message.kind === "RR_INSPECT_DOWNLOADS") {
      if (sender.frameId !== 0) throw new Error("Only main recovery panel may inspect downloads");
      const filename = String(message.filename || "");
      const folder = String(message.folder || "");
      const expected = RarRescueUtils.relative(folder, filename);
      const basename = filename.toLowerCase();
      // Read only the newest browser entries and report matches to the file
      // the user explicitly selected. Never return unrelated download history.
      const found = await chrome.downloads.search({limit:180,orderBy:["-startTime"]});
      const now = Date.now();
      const matches = found.filter(item => {
        const name = String(item.filename || "").replace(/\\/g,"/").split("/").pop();
        if (!sameExpectedFile(name,basename)) return false;
        const started = Date.parse(item.startTime || "");
        if (!Number.isFinite(started) || now-started > 4*60*60*1000 || started-now>60000) return false;
        return RarRescueUtils.isDownloadHost(item.url || "") ||
          RarRescueUtils.isDownloadHost(item.finalUrl || "") ||
          item.tabId === tabId;
      }).slice(0,4).map(item => {
        const pathname = String(item.filename || "").replace(/\\/g,"/");
        let host = "";
        try {host = new URL(item.finalUrl || item.url || "").hostname || "blob";}catch (_) {}
        let sourceScheme="";
        try {sourceScheme=new URL(item.url||"").protocol.replace(":","");}catch (_) {}
        return {
          id:item.id, state:item.state,sourceScheme,
          bytes:Number(item.bytesReceived)||0,
          size:Number(item.totalBytes)||0,
          savedToRecovery:pathname.toLowerCase().endsWith("/"+expected.toLowerCase()),
          browserRenamed:pathname.split("/").pop().toLowerCase()!==filename.toLowerCase(),
          exists:item.exists !== false,
          sourceHost:host.slice(0,100),
          browserTabMatched:item.tabId === tabId,
          ageSeconds:Math.max(0,Math.round((now-Date.parse(item.startTime))/1000)),
          error:String(item.error || "").slice(0,100)
        };
      });
      respond({ok:true,matches});
      return;
    }
    if (message.kind === "RR_FRAME_CALL") {
      if (sender.frameId !== 0) throw new Error("Only the top-level panel can call viewer");
      const frameId = Number(message.frameId);
      if (!Number.isInteger(frameId) || frameId < 0) throw new Error("Invalid viewer frame");
      const payload = message.payload || {};
      if (!["RR_SENSOR_LIST", "RR_SENSOR_TRIGGER", "RR_SENSOR_SCROLL",
        "RR_SENSOR_CRAWL_BEGIN", "RR_SENSOR_CRAWL_STEP", "RR_SENSOR_CRAWL_STATUS", "RR_SENSOR_NAV_START", "RR_SENSOR_NAV_GOTO", "RR_SENSOR_NAV_STATUS"].includes(payload.kind)) {
        throw new Error("Unsupported viewer command");
      }
      const result = await chrome.tabs.sendMessage(tabId, payload, { frameId });
      respond(result && typeof result === "object" ? result : {ok:false,error:"Viewer did not respond"});
      return;
    }
    if(message.kind==="RR_HARVEST_BEGIN") {
      if(sender.frameId!==0)throw new Error("Only parent frame can start raw capture");
      // The previous strict attempt may still respond much later. Preserve
      // the old ledger status, but do not let that watcher force another
      // filename on a new raw file. The raw inbox will log late transfers.
      for(const record of Object.values(watchers))
        await markReview(record,"Superseded by raw as-returned archive collection");
      for(const id of Object.keys(watchers))delete watchers[id];
      await saveWatchers();
      const result=await rawRouter.start(sender,message.scope||null,Number(message.total??1199));
      respond(result);return;
    }
    if(message.kind==="RR_HARVEST_STOP") {
      if(sender.frameId!==0)throw new Error("Only parent frame can stop raw capture");
      const worker=await rawRouter.bind(sender,message.scope||null);
      respond(await worker.stop());return;
    }
    if(message.kind==="RR_HARVEST_ARM") {
      if(sender.frameId!==0)throw new Error("Only parent frame can reserve raw source");
      const worker=await rawRouter.bind(sender,message.scope||null);
      respond(await worker.arm(String(message.folder||""),String(message.filename||"")));
      return;
    }
    if(message.kind==="RR_HARVEST_LOOKUP_FAILED") {
      if(sender.frameId!==0)throw Error("Only main frame can record a failed row lookup");
      const worker=await rawRouter.bind(sender,message.scope||null);
      respond(await worker.lookupFailed(String(message.folder||""),
        String(message.filename||""),String(message.reason||"")));
      return;
    }
    if(message.kind==="RR_HARVEST_DISPATCH") {
      if(sender.frameId!==0)throw new Error("Only parent frame can dispatch a click");
      const worker=await rawRouter.bind(sender,message.scope||null);
      respond(await worker.dispatch(String(message.folder||""),String(message.filename||"")));
      return;
    }
    if(message.kind==="RR_HARVEST_CHECK") {
      if(sender.frameId!==0)throw new Error("Only parent frame can check a download");
      const worker=await rawRouter.bind(sender,message.scope||null);
      respond(await worker.check(String(message.folder||""),String(message.filename||"")));
      return;
    }
    if(message.kind==="RR_HARVEST_SENT") {
      if(sender.frameId!==0)throw new Error("Only parent frame can confirm archive-row action");
      const worker=await rawRouter.bind(sender,message.scope||null);
      respond(await worker.sent(String(message.folder||""),
        String(message.filename||""),message.clicked===true,String(message.reason||""),
        message.definiteFailure===true));
      return;
    }
    if(message.kind==="RR_HARVEST_STATUS") {
      if(sender.frameId!==0)throw new Error("Only parent frame can inspect raw capture");
      const worker=await rawRouter.bind(sender,message.scope||null);
      respond(await worker.status());return;
    }
    if(message.kind==="RR_HARVEST_REPORT") {
      if(sender.frameId!==0)throw new Error("Only parent frame can export raw capture");
      const worker=await rawRouter.bind(sender,message.scope||null);
      respond(await worker.report());return;
    }
    if(message.kind==="RR_PREPARE_RESUME") {
      if(sender.frameId!==0)throw new Error("Only main recovery panel can inspect or defer transfers");
      const ledger=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY]||{};
      const files=Object.entries(ledger).filter(([key,val])=>
        key.startsWith("Disk-2.rar/") &&
        ["needs-review","armed","awaiting","failed"].includes(val?.state));
      const history=await chrome.downloads.search({limit:1000,orderBy:["-startTime"]});
      let reconciled=0;
      let deferred=0;
      const changes=[];
      for(const [key,entry] of files) {
        const target=String(entry.target||"").replace(/\\/g,"/").toLowerCase();
        if(!target)continue;
        const matched=history.find(item=>{
          const path=String(item.filename||"").replace(/\\/g,"/").toLowerCase();
          const received=Number(item.bytesReceived)||0;
          const total=Number(item.totalBytes)||0;
          return item.state==="complete" && received>0 &&
            (total===0||received===total) && item.exists!==false &&
            RarRescueUtils.isDownloadHost(item.url||item.finalUrl||"") &&
            path.endsWith("/"+target);
        });
        if(matched){
          const watcher=Object.values(watchers).find(w=>w?.key===key);
          if(watcher) {
            // Use the existing completion path to remove the watcher, update
            // the ledger and notify any still-open UI.
            await completeFromChrome(watcher,matched);
          } else {
            ledger[key]={...entry,state:"downloaded",downloadId:matched.id,
              bytes:Number(matched.bytesReceived),target:entry.target,
              reason:"Reconciled completed Chrome download at exact target",
              time:new Date().toISOString()};
            changes.push(key);
          }
          reconciled++;
        }
      }
      if(changes.length){
        // Avoid overwriting a concurrent onChanged completion that wrote the
        // ledger while we reconciled another filename.
        const fresh=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY]||{};
        for(const key of changes){
          if(fresh[key]?.state==="downloaded")continue;
          fresh[key]=ledger[key];
        }
        await chrome.storage.local.set({[LEDGER_KEY]:fresh});
      }
      const live=watchers[String(tabId)];
      let active=null;
      if(live){
        const item=live.downloadId!=null?
          history.find(x=>x.id===live.downloadId) :
          (history.find(x=>{
            const begun=Date.parse(x.startTime||"");
            return Number.isFinite(begun) && begun>=live.started-10000 &&
              RarRescueUtils.isDownloadHost(x.url||x.finalUrl||"") &&
              sameExpectedFile(String(x.filename||"").replace(/\\/g,"/").split("/").pop(),
                live.filename) &&
              ["in_progress","complete","interrupted"].includes(x.state);
          }) || await latestAttemptItem(live));
        if(item?.state==="complete" || item?.state==="interrupted"){
          await completeFromChrome(live,item);
        } else if(item?.state==="in_progress"){
          active={path:live.key.slice("Disk-2.rar/".length),state:"in_progress",
            bytes:Number(item.bytesReceived)||0,
            ageSeconds:Math.max(0,Math.floor((Date.now()-live.started)/1000))};
        } else {
          const age=Date.now()-live.started;
          if(age<8*60*1000) {
            active={path:live.key.slice("Disk-2.rar/".length),state:"waiting",
              secondsUntilSafeDefer:Math.ceil((8*60*1000-age)/1000)};
          } else {
            // An old transfer may still appear much later. Preserve an
            // immutable uncertain ledger record, NEVER re-request its path,
            // and reserve related basenames in the planner. Do not claim
            // or redirect a future late download without proof.
            await markReview(live,
              "Deferred unresolved download; original request may still complete later");
            delete watchers[String(tabId)];
            await saveWatchers();
            deferred++;
          }
        }
      }
      const otherActive=Object.keys(watchers).filter(id=>id!==String(tabId)).length;
      if(otherActive && !active)
        active={state:"another-tab",reason:"Another Yandex recovery transfer is still active"};
      const updated=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY]||{};
      const unresolved=Object.entries(updated).filter(([key,val])=>
        key.startsWith("Disk-2.rar/") &&
        ["needs-review","armed","awaiting","failed"].includes(val?.state));
      respond({ok:true,reconciled,deferred,active,unresolvedCount:unresolved.length,
        unresolved:unresolved.slice(0,12).map(([key,val])=>({
          path:key.slice("Disk-2.rar/".length),
          state:val.state,reason:String(val.reason||"").slice(0,140)
        }))});
      return;
    }
    if (message.kind === "RR_ARM") {
      if(rawRouter.recording())throw new Error("Raw archive capture is active; strict download is disabled");
      if (sender.frameId !== 0) throw new Error("Only the top-level panel can arm a download");
      const token=String(message.token||"").slice(0,80);
      const key=String(message.key||"").slice(0,500);
      const filename=String(message.filename||"");
      const folder=String(message.folder||"");
      if(!token || !key)throw new Error("Missing download identity");
      const target=RarRescueUtils.relative(folder,filename);
      if(key!=="Disk-2.rar/"+(folder?folder+"/":"")+filename)
        throw new Error("Download path identity mismatch");
      const ledger=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY]||{};
      if(["downloaded","armed","awaiting","needs-review","failed"].includes(ledger[key]?.state))
        throw new Error("File already downloaded or its previous click is unresolved; no repeated clicks");
      const filenameCollision=Object.entries(ledger).find(([priorKey,prior])=>
        priorKey!==key && priorKey.startsWith("Disk-2.rar/") &&
        ["armed","awaiting","needs-review","failed"].includes(prior?.state) &&
        prior.filename &&
        (sameExpectedFile(filename,prior.filename) ||
         sameExpectedFile(prior.filename,filename)));
      if(filenameCollision)
        throw new Error("Another unresolved source has a matching filename; "+
          "reconcile it before attempting a different directory");
      if(!ledger[key]) {
        // Survive extension reinstall/import when Chrome already has a valid
        // completed file in the exact destination but the local ledger is empty.
        const prior=await chrome.downloads.search({limit:300,orderBy:["-startTime"]});
        const existing=prior.find(item=>
          item.state==="complete" && item.exists!==false &&
          Number(item.bytesReceived)>0 &&
          RarRescueUtils.isDownloadHost(item.url || item.finalUrl || "") &&
          String(item.filename||"").replace(/\\/g,"/").toLowerCase()
            .endsWith("/"+target.toLowerCase()));
        if(existing) {
          ledger[key]={state:"downloaded",reason:"Existing completed browser download at exact target",
            bytes:Number(existing.bytesReceived),time:new Date().toISOString(),
            downloadId:existing.id,target};
          await chrome.storage.local.set({[LEDGER_KEY]:ledger});
          throw new Error("File already exists in recovery directory; skipped to avoid duplicate");
        }
      }
      if(Object.keys(watchers).length)
        throw new Error("Another download remains pending/unconfirmed. Check it before starting another");
      const record={tabId,token,key,target,filename,started:Date.now(),
        downloadId:null,clicked:false,confirmedByBrowser:false};
      watchers[String(tabId)]=record;
      ledger[key]={state:"armed",token,filename,target,started:record.started,
        time:new Date().toISOString(),reason:"Armed, no click confirmed yet"};
      await chrome.storage.local.set({[LEDGER_KEY]:ledger});
      await saveWatchers();
      respond({ok:true});
    } else if(message.kind==="RR_CLICK_SENT") {
      const record=watchers[String(tabId)];
      if(!record || record.token!==message.token) {
        const ledger=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY]||{};
        if(Object.values(ledger).some(x=>x.token===message.token && x.state==="downloaded")){
          respond({ok:true,completedAlready:true});return;
        }
        throw new Error("No matching armed file");
      }
      record.clicked=true;
      await saveWatchers();
      const ledger=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY]||{};
      if(ledger[record.key]?.state!=="downloaded") {
        ledger[record.key]={state:"awaiting",token:record.token,
          target:record.target,filename:record.filename,started:record.started,
          time:new Date().toISOString(),reason:"Viewer click emitted; server response may be delayed"};
        await chrome.storage.local.set({[LEDGER_KEY]:ledger});
      }
      respond({ok:true});
    } else if(message.kind==="RR_CHECK_ATTEMPT") {
      if(sender.frameId!==0)throw new Error("Only main panel can inspect pending attempt");
      const record=watchers[String(tabId)];
      if(!record || record.token!==message.token) {
        const ledger=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY]||{};
        const entry=ledger[String(message.key||"")];
        respond({ok:true,state:entry?.state||"none",
          reason:String(entry?.reason||"").slice(0,120),bytes:entry?.bytes||0});
        return;
      }
      const item=record.downloadId!=null?
        (await chrome.downloads.search({id:record.downloadId}))[0]:
        await latestAttemptItem(record);
      if(item && record.downloadId==null) {
        record.downloadId=item.id;
        await saveWatchers();
        await notify(record.tabId,{kind:"RR_STARTED",token:record.token});
      }
      if(item) await completeFromChrome(record,item);
      const ledger=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY]||{};
      const state=ledger[record.key]?.state||"armed";
      respond({ok:true,state:state==="armed"?"awaiting":state,
        browserState:item?.state||"not-yet-visible",
        bytes:Number(item?.bytesReceived)||0,
        reason:String(ledger[record.key]?.reason||"").slice(0,120)});
    } else if(message.kind==="RR_MARK_UNKNOWN") {
      if(sender.frameId!==0)throw new Error("Only main panel can suspend pending download");
      const record=watchers[String(tabId)];
      if(record && record.token===message.token)
        await markReview(record,"Browser did not conclusively report a result. Do not retry automatically.");
      respond({ok:true});
    } else if(message.kind==="RR_RELEASE" || message.kind==="RR_DISARM") {
      const active=watchers[String(tabId)];
      if(active && active.token===message.token) {
        if(active.clicked || active.downloadId!=null) {
          await markReview(active,"File click/download started; further clicks blocked pending reconciliation");
        } else {
          const ledger=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY]||{};
          if(ledger[active.key]?.state==="armed"){
            delete ledger[active.key];
            await chrome.storage.local.set({[LEDGER_KEY]:ledger});
          }
          delete watchers[String(tabId)];
          await saveWatchers();
        }
      }
      respond({ok:true});
    } else {
      respond({ ok: false, error: "Unknown action" });
    }
  })().catch(error => respond({ ok: false, error: String(error.message || error) }));
  return true;
});

chrome.downloads.onCreated.addListener(item => {
  void (async () => {
    await ready;
    if(await rawRouter.created(item))return;
    if (!RarRescueUtils.isDownloadHost(item.url)) return;
    const record = findActiveWatcher(item);
    if (!record || record.downloadId != null) return;
    if (Date.now()-record.started > PENDING_WINDOW_MS) return;
    record.downloadId = item.id;
    await saveWatchers();
    await notify(record.tabId, { kind: "RR_STARTED", token: record.token });
  })();
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  void (async () => {
    await ready;
    const raw=await rawRouter.determine(item);
    if(raw.handled){
      suggest({filename:raw.filename,conflictAction:raw.conflictAction});
      return;
    }
    const record = findByDownloadId(item.id) || findActiveWatcher(item);
    if (!record || !RarRescueUtils.isDownloadHost(item.url) ||
        (record.downloadId != null && record.downloadId !== item.id)) return suggest();
    if (record.downloadId == null) {
      record.downloadId = item.id;
      await saveWatchers();
      await notify(record.tabId, {kind:"RR_STARTED",token:record.token,linkMode:"download"});
    }
    suggest({ filename: record.target, conflictAction: "uniquify" });
  })().catch(() => suggest());
  return true;
});

chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state || !["complete", "interrupted"].includes(delta.state.current)) return;
  void (async () => {
    await ready;
    const item=(await chrome.downloads.search({id:delta.id}))[0] || {};
    if(await rawRouter.changed(delta.id,item))return;
    const record=findByDownloadId(delta.id);
    if(!record)return;
    await completeFromChrome(record,item);
  })();
});

chrome.tabs.onRemoved.addListener(tabId => {
  void (async () => {
    await ready;
    await rawRouter.removedTab(tabId);
    if (watchers[String(tabId)]) {
      delete watchers[String(tabId)];
      await saveWatchers();
    }
  })();
});
