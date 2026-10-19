/* Read-only archive viewer sensor. Runs in every permitted frame.
 * Never reads cookies, storage, HTTP headers or download URLs.
 */
(() => {
  "use strict";
  const FILE_PATTERN = /^[^\u0000-\u001f\/\\]{1,120}\.(?:txt|htm|html|xml|exe|dll|cmd|bat|sh|json|xml|pdf|jpg|jpeg|png|gif|svg|ini|cfg|dat|bin|db|zip|rar|7z|jar|class|properties|js|css|py|java|sql|csv|xls|xlsx|doc|docx|ppt|pptx|md|log|chm|iso|img|dicom|dcm|pdi|idx|xsl|dtd|conf|so|lib|inf|ico|otf|ttf|mp3|mp4|avi|mov|webp|bmp|tif|tiff|lua|pl|rb|epub|rtf|odt|bak|enc)$/i;
  const SPECIAL_FILES = new Set(["DICOMDIR", "README", "LICENSE", "Makefile"]);
  const MAX_NODES = 18000;
  let pickerActive = false;
  let pickTimer;

  const tell = (message) => {
    try { chrome.runtime.sendMessage(message).catch(() => {}); }
    catch (_) { /* Extension was reloaded. */ }
  };
  function visible(el) {
    if (!(el instanceof Element)) return false;
    if (el.closest("#rr-recovery-panel,script,style,noscript,textarea,pre")) return false;
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }
  function entries() {
    const found = [];
    if (!document.body) return found;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let current, steps = 0;
    const seen = new Set();
    while ((current = walker.nextNode()) && steps++ < MAX_NODES && found.length < 2500) {
      const value = (current.textContent || "").trim();
      if (!value || value.length > 125 || (!FILE_PATTERN.test(value) && !SPECIAL_FILES.has(value))) continue;
      const el = current.parentElement;
      if (!visible(el)) continue;
      const key = value + "@" + (el.tagName || "") + "@" + found.length;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ name: value, el });
    }
    return found;
  }
  function attrs(el) {
    if (!el || !(el instanceof Element)) return {};
    return {
      tag: el.tagName.toLowerCase(),
      classes: Array.from(el.classList).slice(0, 4),
      role: el.getAttribute("role"),
      testid: el.getAttribute("data-testid")
    };
  }
  function ancestry(el, limit = 7) {
    const result = [];
    for (let i = 0; el && i < limit; i++, el = el.parentElement) {
      const d = attrs(el);
      d.siblings = el.parentElement ? el.parentElement.children.length : 0;
      const actions = Array.from(el.querySelectorAll("button,[role=button],[aria-label],[title]"))
        .filter(a => a !== el && /скач|download|сохран|save/i.test(
          (a.getAttribute("aria-label") || "") + " " + (a.getAttribute("title") || "") + " " + (a.innerText || "").slice(0, 40)
        ))
        .slice(0, 4);
      d.actionLabels = actions.map(a => ({
        tag: a.tagName.toLowerCase(),
        title: String(a.getAttribute("title") || "").slice(0, 60),
        aria: String(a.getAttribute("aria-label") || "").slice(0, 60)
      }));
      result.push(d);
    }
    return result;
  }
  function snapshot(requestId) {
    const names = entries();
    return {
      kind: "RR_SENSOR_REPORT",
      requestId,
      host: location.hostname,
      top: window === window.top,
      names: names.slice(0, 14).map(e => e.name),
      count: names.length,
      archiveMarker: Boolean(document.body && /Диск 2\.rar|1286 объектов/i.test(
        (document.body.innerText || "").slice(0, 4000))),
      frames: document.querySelectorAll("iframe").length,
      knownReadme: names.some(e => e.name.toUpperCase() === "README.TXT")
    };
  }
  function clickName(target) {
    const all = entries();
    let best = null;
    let closestDistance = 100;
    for (const item of all) {
      let cur = item.el;
      for (let level = 0; cur && level < 9; level++, cur = cur.parentElement) {
        if (cur === target || cur.contains(target)) {
          if (level < closestDistance) {
            best = item; closestDistance = level;
          }
          break;
        }
      }
    }
    return best;
  }
  function handlePick(event) {
    if (!pickerActive) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target || target.closest("#rr-recovery-panel")) return;
    pickerActive = false;
    clearTimeout(pickTimer);
    document.removeEventListener("click", handlePick, true);
    const item = clickName(target);
    const payload = item ?
      {
        kind: "RR_SENSOR_PICKED", host: location.hostname, found: true, name: item.name,
        ancestry: ancestry(item.el, 7),
        clickedTag: target.tagName.toLowerCase(),
        count: entries().length
      } : {
        kind: "RR_SENSOR_PICKED", host: location.hostname, found: false,
        clickedTag: target.tagName.toLowerCase(),
        count: entries().length,
        ancestry: ancestry(target, 3)
      };
    tell(payload);
    // Deliberately do not preventDefault: the Yandex viewer keeps working.
  }
  function startPick() {
    clearTimeout(pickTimer);
    pickerActive = true;
    document.removeEventListener("click", handlePick, true);
    document.addEventListener("click", handlePick, true);
    pickTimer = setTimeout(() => {
      pickerActive = false;
      document.removeEventListener("click", handlePick, true);
    }, 45000);
  }

  chrome.runtime.onMessage.addListener(message => {
    if (!message || !message.kind) return;
    if (message.kind === "RR_SENSOR_SCAN") {
      tell(snapshot(message.requestId));
      // Yandex renders the archive list asynchronously.
      setTimeout(() => tell(snapshot(message.requestId)), 1000);
    }
    if (message.kind === "RR_SENSOR_START_PICK") startPick();
    if (message.kind === "RR_SENSOR_STOP_PICK") {
      pickerActive = false;
      clearTimeout(pickTimer);
      document.removeEventListener("click", handlePick, true);
    }
  });
})();
