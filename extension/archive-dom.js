/* Structural adapters for the Yandex Disk RAR viewer.
   Uses stable class prefixes and title attributes seen in the live screenshots.
   Never reads cookies, account details, URLs or document payloads. */
(function(root) {
  "use strict";
  const titleRE = /^[^\u0000-\u001f/\\]{1,200}$/;
  const actionRE = /скач|download|загруз|save\s*as/i;
  const previewRE = /просмотр|preview|открыть|open/i;
  const norm = s => String(s || "").trim();

  function archiveRows(doc) {
    return Array.from(doc.querySelectorAll('[title][class*="resourceItem_"]'))
      .filter(el => {
        const title = norm(el.getAttribute("title"));
        return Boolean(title && titleRE.test(title)) &&
          Boolean(el.closest('[class*="listing_"]') || el.closest('[class*="archive_"]'));
      }).slice(0, 5000);
  }

  function kindOf(row) {
    if (row.querySelector('[class*="file-icon"]')) return "file";
    if (row.querySelector('[class*="folder-icon"],[class*="folderIcon_"]')) return "folder";
    // Unknown icon must never be downloaded automatically.
    return "unknown";
  }

  function itemOf(row) {
    const bar = row.querySelector('[class*="actionBar_"]');
    const controls = bar ? controlsOf(bar) : [];
    return {
      name: norm(row.getAttribute("title")),
      kind: kindOf(row),
      hasActionBar: Boolean(bar),
      actionCount: controls.length,
      downloadHint: controls.some(c => actionRE.test(labelOf(c)))
    };
  }

  function labelOf(element) {
    return [
      element.getAttribute("aria-label"),element.getAttribute("title"),
      element.getAttribute("data-tooltip"),element.getAttribute("data-action"),
      element.getAttribute("data-testid"),
      element.textContent && element.textContent.length <= 40 ? element.textContent : ""
    ].filter(Boolean).join(" ").trim();
  }

  function controlsOf(bar) {
    const buttons = Array.from(bar.querySelectorAll("button,a,[role='button']"))
      .filter(e => !e.closest('[disabled]') && !e.hasAttribute("disabled"));
    // If clickable controls are nested, keep only the innermost element.
    return buttons.filter(button => !buttons.some(other => other !== button && button.contains(other)));
  }

  function actionOf(row, allowInferred) {
    const bar = row.querySelector('[class*="actionBar_"]');
    if (!bar) return {error:"no-action-bar",count:0};
    const controls = controlsOf(bar);
    const named = controls.filter(control => actionRE.test(labelOf(control)) &&
      !previewRE.test(labelOf(control)));
    if (named.length === 1) {
      return {element:named[0],mode:"label",slotCount:controls.length};
    }
    if (named.length > 1) return {error:"ambiguous-download-label",count:named.length};
    if (!allowInferred) return {error:"download-button-not-labeled",count:controls.length};
    // On the observed viewer, the last row action is the down-arrow. The
    // inferred path is *pilot only*, before any browser-confirmed success.
    if (controls.length >= 1 && controls.length <= 3) {
      return {element:controls[controls.length-1],mode:"last-control",slotCount:controls.length};
    }
    // On some builds the action bar uses click-handled DIV slots, not buttons.
    // Prefer one or two immediate slots; anything more is ambiguous.
    const slots = Array.from(bar.children).filter(el => el.nodeType === 1);
    if (slots.length >= 1 && slots.length <= 2) {
      return {element:slots[slots.length-1],mode:"last-slot",slotCount:slots.length};
    }
    return {error:"no-safe-download-control",count:controls.length};
  }

  function rowNamed(doc, name) {
    return archiveRows(doc).find(row =>
      norm(row.getAttribute("title")) === norm(name) && kindOf(row) === "file");
  }

  function scrollerOf(row, doc) {
    for (let el=row?.parentElement; el && el !== doc.documentElement; el=el.parentElement) {
      const style = doc.defaultView.getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20) return el;
    }
    return null;
  }

  root.RarRescueDOM = Object.freeze({
    archiveRows, kindOf, itemOf, labelOf, actionOf, rowNamed, scrollerOf
  });
})(globalThis);
