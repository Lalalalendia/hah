/* Stable per-archive identity for public Yandex RAR viewers.
 * This is pure metadata: never retain query strings, hashes, cookies,
 * signed download links, passwords or file content.
 */
(function(root){
"use strict";
const SCHEMA="rar-rescue-archive-scope-v1";
function archiveName(value){
  if(typeof value!=="string")throw Error("Archive name is missing");
  const name=value.normalize("NFC");
  if(name.length<5||name.length>120||name!==name.trim()||
     !/\.rar$/i.test(name)||/[<>:"\\/|?*\u0000-\u001f]/.test(name)||
     /[. ]$/.test(name)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\./i.test(name))
    throw Error("Archive filename cannot be represented losslessly on Windows");
  return name;
}
function fromYandexPublicLink(rawUrl,rawName){
  let url;
  try{url=new URL(rawUrl);}catch(_){throw Error("Invalid Yandex public link");}
  if(url.protocol!=="https:"||url.hostname!=="disk.yandex.ru"||
     url.username||url.password||url.port)
    throw Error("Unsupported Yandex public link origin");
  const match=/^\/d\/([A-Za-z0-9_-]{1,150})\/?$/.exec(url.pathname);
  if(!match)throw Error("Open a supported public /d/ archive link");
  const name=archiveName(rawName);
  const sourceKey="yandex-public:/d/"+match[1];
  const scopeId=encodeURIComponent(sourceKey)+"|"+encodeURIComponent(name);
  const outputRoot=name;
  return Object.freeze({schema:SCHEMA,sourceKind:"yandex-public",
    sourceKey,archiveName:name,outputRoot,scopeId,
    treeStorageKey:"rr_tree_v15:"+scopeId,
    harvestStorageKey:"rr_harvest_v15:"+scopeId,
    ledgerStorageKey:"rr_ledger_v15:"+scopeId,
    reportName:name+"-download-log.json"});
}
function sameScope(a,b){
  return Boolean(a&&b&&a.schema===SCHEMA&&b.schema===SCHEMA&&
    a.sourceKey===b.sourceKey&&a.archiveName===b.archiveName);
}
function outputRootConflict(a,b){
  return Boolean(a&&b&&!sameScope(a,b)&&
    String(a.outputRoot||"").normalize("NFC").toLowerCase()===
    String(b.outputRoot||"").normalize("NFC").toLowerCase());
}
root.RarRescueArchiveScope=Object.freeze({
  schema:SCHEMA,archiveName,fromYandexPublicLink,sameScope,outputRootConflict
});
})(globalThis);
