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
  try { return new URL(sender.url || sender.tab.url).hostname === "disk.yandex.ru"; }
  catch (_) { return false; }
}

async function notify(tabId, payload) {
  try { await chrome.tabs.sendMessage(tabId, payload); }
  catch (_) { /* Page was navigated or closed; ledger still survives. */ }
}

function findByDownloadId(id) {
  return Object.values(watchers).find(w => w.downloadId === id);
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
  try { await chrome.tabs.sendMessage(tab.id, { kind: "RR_TOGGLE" }); }
  catch (_) { /* Content script not yet loaded. */ }
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || !String(message.kind || "").startsWith("RR_")) return false;
  (async () => {
    await ready;
    if (!pageAllowed(sender)) throw new Error("Not a Yandex Disk tab");
    const tabId = sender.tab.id;
    if (message.kind === "RR_ARM") {
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
    const record = watchers[String(item.tabId)];
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
    const record = findByDownloadId(item.id);
    if (!record || !RarRescueUtils.isDownloadHost(item.url)) return suggest();
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
    const good = received > 0 && !(total > 0 && received !== total);
    return complete(record, good ? "downloaded" : "failed",
      good ? "Browser download complete; checksum not verified" : "Zero or inconsistent downloaded bytes", item);
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
