const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const ctx={URL};ctx.globalThis=ctx;
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,"../archive-scope.js"),"utf8"),ctx);
const api=ctx.RarRescueArchiveScope;
const a=api.fromYandexPublicLink("https://disk.yandex.ru/d/_RSlWomRWmty1w","Disk-2.rar");
assert.equal(a.outputRoot,"Disk-2.rar");
assert.equal(a.reportName,"Disk-2.rar-download-log.json");
assert(a.treeStorageKey!==a.harvestStorageKey);
assert(a.harvestStorageKey!==a.ledgerStorageKey);
assert(!JSON.stringify(a).includes("session_token"));
const query=api.fromYandexPublicLink(
  "https://disk.yandex.ru/d/_RSlWomRWmty1w?session_token=PRIVATE#fragment",
  "Disk-2.rar");
assert(api.sameScope(a,query),"Transient query/hash must not split or leak archive state");
assert(!JSON.stringify(query).includes("PRIVATE"));
const b=api.fromYandexPublicLink("https://disk.yandex.ru/d/OTHER_SOURCE","Disk-2.rar");
assert(!api.sameScope(a,b));
assert.notEqual(a.scopeId,b.scopeId);
assert.notEqual(a.treeStorageKey,b.treeStorageKey);
assert.notEqual(a.harvestStorageKey,b.harvestStorageKey);
assert(api.outputRootConflict(a,b),"Same output folder needs an explicit collision decision");
const c=api.fromYandexPublicLink("https://disk.yandex.ru/d/_RSlWomRWmty1w","Новая книга.part001.RAR");
assert(!api.outputRootConflict(a,c));
assert.equal(c.outputRoot,"Новая книга.part001.RAR");
assert.notEqual(c.scopeId,a.scopeId);
const bad=[
  ["http://disk.yandex.ru/d/id","File.rar"],
  ["https://evil.example.com/d/id","File.rar"],
  ["https://disk.yandex.ru/client/disk","File.rar"],
  ["https://disk.yandex.ru/d/abc/evil","File.rar"],
  ["https://disk.yandex.ru/d/abc","../File.rar"],
  ["https://disk.yandex.ru/d/abc","CON.rar"],
  ["https://disk.yandex.ru/d/abc","bad\\name.rar"],
  ["https://disk.yandex.ru/d/abc","bad:name.rar"],
  ["https://disk.yandex.ru/d/abc","missing.zip"],
  ["https://disk.yandex.ru/d/abc"," File.rar"],
  ["https://disk.yandex.ru/d/abc","File.rar "],
  ["https://disk.yandex.ru/d/abc",""]
];
for(const [url,name] of bad)assert.throws(()=>api.fromYandexPublicLink(url,name),undefined,url+" "+name);
assert(!api.outputRootConflict(a,query),"Identical scope is not an output collision");
assert(api.outputRootConflict(a,api.fromYandexPublicLink(
  "https://disk.yandex.ru/d/OTHER_SOURCE","disk-2.RAR"
)),"Windows case-insensitive output collision must be visible");
console.log("PASS: generic archive identity, distinct ledgers, private query omission, unsafe names, same-folder collision gate");
