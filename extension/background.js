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
function findActiveWatcher(item) {
  if (!RarRescueUtils.isDownloadHost(item.url || "")) return null;
  const direct = watchers[String(item.tabId)];
  if (direct && Date.now() - direct.started < 120000) return direct;
  // Certain Yandex-created downloads have tabId=-1. Only correlate when
  // there is exactly ONE armed tab and its request is still very recent.
  if (item.tabId !== -1) return null;
  const candidates = Object.values(watchers).filter(w =>
    Date.now() - w.started < 25000 && w.downloadId == null);
  return candidates.length === 1 ? candidates[0] : null;
}

async function complete(record, status, reason, item) {
  if (watchers[String(record.tabId)] !== record) return;
  const ledger = (await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY] || {};
  ledger[record.key] = {
    state: status,
    reason: String(reason || "").slice(0, 100),
    bytes: Number(item && item.bytesReceived) || 0,
    time: new Date().toISOString()
  };
  await chrome.storage.local.set({ [LEDGER_KEY]: ledger });
  delete watchers[String(record.tabId)];
  await saveWatchers();
  await notify(record.tabId, {
    kind: "RR_RESULT", token: record.token, state: status,
    reason: String(reason || "").slice(0, 100),
    bytes: Number(item && item.bytesReceived) || 0
  });
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
        ["kind", "requestId", "host", "names", "count", "folders", "unknown", "rowSelector", "example", "knownReadme"] :
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
    if (message.kind === "RR_FRAME_CALL") {
      if (sender.frameId !== 0) throw new Error("Only the top-level panel can call viewer");
      const frameId = Number(message.frameId);
      if (!Number.isInteger(frameId) || frameId < 0) throw new Error("Invalid viewer frame");
      const payload = message.payload || {};
      if (!["RR_SENSOR_LIST", "RR_SENSOR_TRIGGER", "RR_SENSOR_SCROLL"].includes(payload.kind)) {
        throw new Error("Unsupported viewer command");
      }
      const result = await chrome.tabs.sendMessage(tabId, payload, { frameId });
      respond(result && typeof result === "object" ? result : {ok:false,error:"Viewer did not respond"});
      return;
    }
    if (message.kind === "RR_ARM") {
      if (sender.frameId !== 0) throw new Error("Only the top-level panel can arm a download");
      const token = String(message.token || "").slice(0, 80);
      const key = String(message.key || "").slice(0, 500);
      const filename = String(message.filename || "");
      const folder = String(message.folder || "");
      if (!token || !key) throw new Error("Missing download identity");
      if (watchers[String(tabId)]) throw new Error("A download is already pending");
      const target = RarRescueUtils.relative(folder, filename);
      watchers[String(tabId)] = {
        tabId, token, key, target, started: Date.now(), downloadId: null
      };
      await saveWatchers();
      respond({ ok: true });
    } else if (message.kind === "RR_RELEASE") {
      const active = watchers[String(tabId)];
      if (active && active.token === message.token) {
        delete watchers[String(tabId)];
        await saveWatchers();
      }
      respond({ok:true});
    } else if (message.kind === "RR_DISARM") {
      const active = watchers[String(tabId)];
      if (active && active.token === message.token && active.downloadId == null) {
        delete watchers[String(tabId)];
        await saveWatchers();
      }
      respond({ ok: true });
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
    if (Date.now() - record.started > 45000) return;
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
    suggest({ filename: record.target, conflictAction: "overwrite" });
  })().catch(() => suggest());
  return true;
});

chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state || !["complete", "interrupted"].includes(delta.state.current)) return;
  void (async () => {
    await ready;
    const record = findByDownloadId(delta.id);
    if (!record) return;
    const items = await chrome.downloads.search({ id: delta.id });
    const item = items[0] || {};
    if (delta.state.current === "interrupted") {
      return complete(record, "failed", (delta.error && delta.error.current) || item.error || "interrupted", item);
    }
    const received = Number(item.bytesReceived) || 0;
    const total = Number(item.totalBytes);
    const finalPath = String(item.filename || "").replace(/\\/g, "/");
    const rightPath = finalPath.toLowerCase().endsWith(record.target.toLowerCase());
    const good = received > 0 && !(total > 0 && received !== total) && rightPath;
    return complete(record, good ? "downloaded" : "failed",
      good ? "Browser download complete; checksum not verified" :
        (!rightPath ? "Download path was not controlled by extension" : "Zero or inconsistent downloaded bytes"), item);
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
