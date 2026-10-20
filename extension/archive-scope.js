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
// The Yandex page title is often just "Яндекс Диск" even if the iframe
// lists RAR files. Resolve a lossless filename if provided; otherwise use a
// deterministic, Windows-safe folder name derived from the public share ID.
function parseTitle(value){
  if(typeof value!=="string"||!value)return null;
  const raw=value.normalize("NFC").trim();
  if(raw.length>1000)return null;
  const options=[raw];
  for(const segment of raw.split(/\s+[—–|·]\s+/u))options.push(segment);
  const quoted=/[«“"']([^«»“”"']{1,160}\.rar)[»”"']/giu;
  for(const match of raw.matchAll(quoted))options.push(match[1]);
  const token=/(?:^|\s)([^<>:"\\/|?*\u0000-\u001f]{1,120}\.rar)(?=\s|$|[»”"'])/giu;
  for(const match of raw.matchAll(token))options.push(match[1]);
  for(const option of options){
    const label=String(option||"").trim().replace(/^[«“"']+|[»”"']+$/gu,"").trim();
    if(!label)continue;
    try{return archiveName(label);}catch(_){}
  }
  return null;
}
function resolveName(rawUrl,candidates=[]){
  const u=new URL(rawUrl);
  if(u.protocol!=="https:"||u.hostname!=="disk.yandex.ru"||
     u.username||u.password||u.port)
    throw Error("Unsupported Yandex public link origin");
  const id=/^\/d\/([A-Za-z0-9_-]{1,150})\/?$/.exec(u.pathname)?.[1];
  if(!id)throw Error("Open a supported public /d/ archive link");
  for(const row of candidates){
    const entry=typeof row==="string"?{value:row,source:"page"}:row;
    const valid=parseTitle(entry?.value);
    if(valid)return Object.freeze({archiveName:valid,source:entry?.source||"page",
      fallback:false,
      viewerExpectedTitle:entry?.source==="viewer"?String(entry.value).trim():null});
  }
  const hash=Array.from(id).reduce((h,ch)=>Math.imul(h^ch.charCodeAt(0),16777619)>>>0,2166136261);
  const fallback="Yandex-RAR-"+id.slice(0,90)+
    (id.length>90?"-"+hash.toString(16).padStart(8,"0"):"")+".rar";
  return Object.freeze({archiveName:archiveName(fallback),source:"public-link",
    fallback:true,viewerExpectedTitle:null});
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
  schema:SCHEMA,archiveName,parseTitle,resolveName,fromYandexPublicLink,sameScope,outputRootConflict
});
})(globalThis);
