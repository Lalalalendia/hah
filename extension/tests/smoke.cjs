const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.host_permissions, [
  "https://disk.yandex.ru/*",
  "https://docviewer.yandex.ru/*",
  "https://docviewer.360.yandex.ru/*"
]);
assert(manifest.content_scripts.some(item =>
  item.all_frames && item.js.includes("frame-sensor.js") &&
  item.matches.includes("https://docviewer.360.yandex.ru/*")
));
assert(manifest.content_scripts.some(item =>
  !item.all_frames && item.js.includes("content.js") &&
  item.matches.length === 1 && item.matches[0] === "https://disk.yandex.ru/*"
));
assert(!manifest.permissions.includes("cookies"));
assert(!manifest.permissions.includes("debugger"));

const scope = { URL };
scope.globalThis = scope;
vm.runInNewContext(fs.readFileSync(path.join(root, "common.js"), "utf8"), scope);
const utils = scope.RarRescueUtils;
assert.equal(utils.relative("1000005A/sub", "README.TXT"),
  "YandexRARRecovery/Disk-2.rar/1000005A/sub/README.TXT");
assert.equal(utils.relative("", "CDVIEWER.EXE"),
  "YandexRARRecovery/Disk-2.rar/CDVIEWER.EXE");
assert.equal(utils.relative("temp", "CON.txt"),
  "YandexRARRecovery/Disk-2.rar/temp/_CON.txt");
assert.throws(() => utils.relative("../evil", "README.TXT"), /traversal/);
assert.throws(() => utils.relative("abc", "../README.TXT"), /Invalid filename/);
assert.throws(() => utils.relative("abc", "foo/bar"), /Invalid filename/);
assert(utils.isDownloadHost("https://2.downloader.disk.yandex.ru/disk/x?hash=secret"));
assert(utils.isDownloadHost("https://disk.yandex.ru/x"));
assert(utils.isDownloadHost("https://docviewer.360.yandex.ru/download/part"));
assert(utils.isDownloadHost("https://docviewer.yandex.ru/download/part"));
assert(!utils.isDownloadHost("http://disk.yandex.ru/x"));
assert(utils.isDownloadHost("blob:https://docviewer.360.yandex.ru/0000-ffff"));
assert(!utils.isDownloadHost("blob:https://evil.example.com/0000-ffff"));
assert(!utils.isDownloadHost("https://disk.yandex.ru.attacker.invalid/x"));
assert(!utils.isDownloadHost("https://example.net/"));

console.log("OK: cross-frame manifest, minimal permissions, local path safety and Yandex host matching");
