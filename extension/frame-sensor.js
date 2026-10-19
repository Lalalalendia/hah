/* Yandex RAR Rescue v0.3: archive row discovery and per-file action sensor.
   Runs only in approved Yandex document frames. */
(() => {
  "use strict";
  const dom = globalThis.RarRescueDOM;
  const crawler = new globalThis.RarRescueCrawler(document,dom);
  const replyToPanel = payload => {
    try { chrome.runtime.sendMessage(payload).catch(() => {}); } catch (_) {}
  };
  const current = () => dom.archiveRows(document);
  const summarize = (requestId) => {
    const rows = current();
    const items = rows.map(row => dom.itemOf(row));
    return {
      kind:"RR_SENSOR_REPORT",
      requestId,
      host:location.hostname,
      count:items.filter(x => x.kind === "file").length,
      folders:items.filter(x => x.kind === "folder").length,
      unknown:items.filter(x => x.kind === "unknown").length,
      names:items.slice(0,12).map(x => x.name),
      knownReadme:items.some(x => x.name === "README.TXT" && x.kind === "file"),
      rowSelector:'[title][class*="resourceItem_"]',
      example:items.find(x => x.kind === "file") || null,
      iconSamples:items.slice(0, 16).map(x => ({
        name:x.name,kind:x.kind,icons:x.iconClasses
      }))
    };
  };
  const getFileRows = () => current().map(row => dom.itemOf(row));
  const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

  async function trigger(message) {
    const name = String(message.name || "");
    if (!name || name.length > 200 || name.includes("/") || name.includes("\\"))
      return {ok:false,error:"invalid-file-name"};
    // The viewer virtualizes long folder lists. During recursive recovery the
    // requested file may not currently be rendered; locate it by scrolling
    // within the CURRENT verified directory, not by clicking a random row.
    const row = dom.rowNamed(document,name) ||
      (message.allowLocate === true ? await crawler.locate(name,"file") : null);
    if (!row) return {ok:false,error:"file-row-not-visible",name};
    try { row.scrollIntoView({block:"nearest",inline:"nearest"}); } catch (_) {}
    // React may create the action buttons only while the row is hovered.
    // JavaScript hover events do not change CSS :hover, but they may trigger
    // React mouse handlers. Missing controls result in an explicit diagnostic.
    row.dispatchEvent(new MouseEvent("mouseover",{bubbles:true,composed:true}));
    row.dispatchEvent(new MouseEvent("mouseenter",{bubbles:false,composed:true}));
    await delay(90);
    if (!document.contains(row)) return {ok:false,error:"row-disappeared"};
    const allowInferred = message.pilot === true ||
      (Boolean(message.approvedMode) && message.approvedMode !== "label");
    const action = dom.actionOf(row,allowInferred);
    if (!action.element) {
      return {ok:false,error:action.error || "button-missing",controls:action.count || 0};
    }
    if (!message.pilot && action.mode !== "label") {
      if (!message.approvedMode || message.approvedMode !== action.mode ||
        Number(message.approvedSlots) !== action.slotCount) {
        return {ok:false,error:"action-layout-changed",mode:action.mode,slots:action.slotCount};
      }
    }
    if (action.element.hasAttribute("disabled")) return {ok:false,error:"action-disabled"};
    if (message.inspectOnly === true) {
      return {ok:true,clicked:false,inspected:true,name,mode:action.mode,slots:action.slotCount};
    }
    const userActivation=Boolean(navigator.userActivation?.isActive);
    action.element.click();
    return {ok:true,clicked:true,name,mode:action.mode,slots:action.slotCount,
      userActivationAtClick:userActivation,syntheticClick:true};
  }

  function scroll(message) {
    const rows = current();
    const scroll = dom.scrollerOf(rows[0],document);
    if (!scroll) return {ok:true,scrollable:false,visible:rows.length};
    if (message.reset) scroll.scrollTop = 0;
    else scroll.scrollTop = Math.min(scroll.scrollHeight,
      scroll.scrollTop + Math.max(100,Math.round(scroll.clientHeight*.75)));
    return {
      ok:true,scrollable:true,top:scroll.scrollTop,height:scroll.scrollHeight,
      viewport:scroll.clientHeight,atEnd:scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4
    };
  }

  chrome.runtime.onMessage.addListener((message,_sender,sendResponse) => {
    if (!message || !message.kind) return false;
    if (message.kind === "RR_SENSOR_SCAN") {
      replyToPanel(summarize(message.requestId));
      setTimeout(()=>replyToPanel(summarize(message.requestId)),700);
      return false;
    }
    if (message.kind === "RR_SENSOR_CRAWL_BEGIN") {
      void crawler.begin().then(sendResponse,error=>
        sendResponse({ok:false,error:String(error.message || error)}));
      return true;
    }
    if (message.kind === "RR_SENSOR_CRAWL_STEP") {
      void crawler.step().then(sendResponse,error=>
        sendResponse({ok:false,error:String(error.message || error)}));
      return true;
    }
    if (message.kind === "RR_SENSOR_CRAWL_STATUS") {
      sendResponse({ok:true,halted:crawler.halted,depth:crawler.frames.length,
        paths:crawler.seenPaths.size,objects:crawler.objectCount});
      return false;
    }
    if (message.kind === "RR_SENSOR_LIST") {
      sendResponse({ok:true,items:getFileRows(),host:location.hostname});
      return false;
    }
    if (message.kind === "RR_SENSOR_SCROLL") {
      sendResponse(scroll(message));
      return false;
    }
    if (message.kind === "RR_SENSOR_TRIGGER") {
      void trigger(message).then(sendResponse,error =>
        sendResponse({ok:false,error:String(error && error.message || error).slice(0,140)}));
      return true;
    }
    return false;
  });
})();
