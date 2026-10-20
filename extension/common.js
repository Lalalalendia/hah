/* Shared path safety helpers; no network requests or user data collection. */
(function (root) {
  "use strict";
  function component(value) {
    let s = String(value == null ? "" : value).normalize("NFC");
    s = s.replace(/[<>:"\\|?*\u0000-\u001f]/g, "_").trim();
    s = s.replace(/[. ]+$/g, "_");
    if (!s || s === "." || s === "..") return "_";
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s)) s = "_" + s;
    return s.slice(0, 120);
  }
  function relative(folder, filename) {
    const raw = String(folder || "").replace(/\\/g, "/").split("/");
    if (raw.some(x => x === "..")) throw new Error("Path traversal rejected");
    const safeFolder = raw.filter(x => x && x !== ".").map(component);
    const rawFile = String(filename || "");
    if (!rawFile || /[/\\]/.test(rawFile) || rawFile === "." || rawFile === "..") {
      throw new Error("Invalid filename");
    }
    return ["YandexRARRecovery", "Disk-2.rar"].concat(safeFolder, component(rawFile)).join("/");
  }
  function isDownloadHost(url) {
    try {
      const u = new URL(url);
      if (u.protocol === "blob:") return [
        "https://disk.yandex.ru", "https://docviewer.yandex.ru", "https://docviewer.360.yandex.ru"
      ].includes(u.origin);
      return u.protocol === "https:" && (
        u.hostname === "disk.yandex.ru" ||
        u.hostname === "docviewer.yandex.ru" ||
        u.hostname === "docviewer.360.yandex.ru" ||
        u.hostname.endsWith(".disk.yandex.ru") ||
        u.hostname.endsWith(".disk.yandex.net") ||
        u.hostname === "downloader.yandex.ru" ||
        u.hostname.endsWith(".downloader.yandex.ru")
      );
    } catch (_) {
      return false;
    }
  }
  root.RarRescueUtils = Object.freeze({ component, relative, isDownloadHost });
})(globalThis);
