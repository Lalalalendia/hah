/* Manifest V3 service worker. All state stays on the user's machine. */
importScripts("common.js");
"use strict";

const STATE_KEY = "rr_pending";
const LEDGER_KEY = "rr_ledger";
const watchers = {};
const ready = chrome.storage.session.get(STATE_KEY).then(data => {
  Object.assign(watchers, data[STATE_KEY] || {});
}).catch(() => {});

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
  // Only the originating tab can be associated when Chrome hasn't yet
  // supplied a name. Never guess for unrelated positive or detached tabs.
  return item.tabId===record.tabId;
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
    downloadId:item?.id??record.downloadId,target:record.target
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
        ["kind", "requestId", "host", "names", "count", "folders", "unknown", "rowSelector", "example", "iconSamples", "knownReadme"] :
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
    if (message.kind === "RR_ARM") {
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
      if(["downloaded","armed","awaiting","needs-review"].includes(ledger[key]?.state))
        throw new Error("File already downloaded or its previous click is unresolved; no repeated clicks");
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
    const record=findByDownloadId(delta.id);
    if(!record)return;
    const item=(await chrome.downloads.search({id:delta.id}))[0] || {};
    await completeFromChrome(record,item);
  })();
});

chrome.tabs.onRemoved.addListener(tabId => {
  void (async () => {
    await ready;
    if (watchers[String(tabId)]) {
      delete watchers[String(tabId)];
      await saveWatchers();
    }
  })();
});
