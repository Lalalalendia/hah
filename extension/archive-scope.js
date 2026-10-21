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
function stableHash(value){
  let a=2166136261,b=2166136261^0x9e3779b9;
  for(const code of String(value)){
    const n=code.codePointAt(0);
    a=Math.imul(a^(n&65535),16777619)>>>0;
    b=Math.imul(b^n,2246822519)>>>0;
  }
  return a.toString(16).padStart(8,"0")+b.toString(16).padStart(8,"0");
}
function yandexUrl(rawUrl){
  let u;try{u=new URL(rawUrl);}catch(_){throw Error("Invalid Yandex web URL");}
  if(u.protocol!=="https:"||u.hostname!=="disk.yandex.ru"||
     u.username||u.password||u.port)throw Error("Open the archive in the Yandex Disk web viewer");
  return u;
}
function viewerFingerprint(frame){
  if(!frame||typeof frame!=="object")return null;
  const rows=Array.isArray(frame.iconSamples)?frame.iconSamples:[];
  const title=String(frame.archiveName||"").normalize("NFC").trim();
  if(!rows.length&&!title)return null;
  const normalized=rows.slice(0,32).filter(x=>x&&
    typeof x.name==="string"&&["file","folder","unknown"].includes(x.kind))
    .map(x=>x.kind+":"+x.name.normalize("NFC")).sort();
  if(!normalized.length&&!title)return null;
  const counters=[frame.count,frame.folders,frame.unknown]
    .map(x=>Number.isInteger(x)&&x>=0?x:"?");
  return stableHash(JSON.stringify({title,rows:normalized,counters}));
}
function resolveName(rawUrl,candidates=[],viewerKey=null){
  const u=yandexUrl(rawUrl);
  const publicId=/^\/d\/([A-Za-z0-9_-]{1,150})\/?$/.exec(u.pathname)?.[1];
  if(!publicId&&!/^[0-9a-f]{16}$/.test(String(viewerKey||"")))
    throw Error("Cannot identify current RAR viewer. Reopen the archive preview, then retry");
  for(const row of candidates){
    const entry=typeof row==="string"?{value:row,source:"page"}:row;
    const valid=parseTitle(entry?.value);
    if(valid)return Object.freeze({archiveName:valid,source:entry?.source||"page",
      fallback:false,viewerExpectedTitle:entry?.source==="viewer"?String(entry.value).trim():null});
  }
  const fallback=publicId
    ?"Yandex-RAR-"+publicId.slice(0,90)+(publicId.length>90?"-"+stableHash(publicId).slice(0,8):"")+".rar"
    :"Yandex-RAR-"+stableHash(u.pathname+":"+viewerKey)+".rar";
  return Object.freeze({archiveName:archiveName(fallback),source:publicId?"public-link":"web-viewer",
    fallback:true,viewerExpectedTitle:null});
}
function scopeRecord(sourceKey,sourceKind,name,viewerKey=null){
  const scopeId=encodeURIComponent(sourceKey)+"|"+encodeURIComponent(name);
  return Object.freeze({schema:SCHEMA,sourceKind,sourceKey,archiveName:name,
    outputRoot:name,scopeId,viewerFingerprint:viewerKey,
    treeStorageKey:"rr_tree_v15:"+scopeId,
    harvestStorageKey:"rr_harvest_v15:"+scopeId,
    ledgerStorageKey:"rr_ledger_v15:"+scopeId,
    reportName:name+"-download-log.json"});
}
function fromYandexViewer(rawUrl,rawName,viewerKey=null){
  const u=yandexUrl(rawUrl);
  const publicId=/^\/d\/([A-Za-z0-9_-]{1,150})\/?$/.exec(u.pathname)?.[1];
  if(publicId)return fromYandexPublicLink(rawUrl,rawName);
  if(!/^[0-9a-f]{16}$/.test(String(viewerKey||"")))
    throw Error("Cannot identify active web archive; viewer listing is missing");
  const key="yandex-viewer:"+stableHash(u.pathname)+":"+viewerKey;
  return scopeRecord(key,"yandex-viewer",archiveName(rawName),viewerKey);
}
function restoreScope(raw){
  if(!raw||typeof raw.sourceKey!=="string"||typeof raw.archiveName!=="string")return null;
  let fresh;
  try{
    const m=/^yandex-public:\/d\/([A-Za-z0-9_-]{1,150})$/.exec(raw.sourceKey);
    const w=/^yandex-viewer:([0-9a-f]{16}):([0-9a-f]{16})$/.exec(raw.sourceKey);
    if(m)fresh=fromYandexPublicLink("https://disk.yandex.ru/d/"+m[1],raw.archiveName);
    else if(w&&raw.viewerFingerprint===w[2])
      fresh=scopeRecord(raw.sourceKey,"yandex-viewer",archiveName(raw.archiveName),w[2]);
    else return null;
  }catch(_){return null;}
  return fresh.scopeId===raw.scopeId&&fresh.outputRoot===raw.outputRoot?fresh:null;
}
function matchesTab(scope,rawUrl){
  const canonical=restoreScope(scope);
  if(!canonical)return false;
  try{
    const actual=fromYandexViewer(rawUrl,canonical.archiveName,canonical.viewerFingerprint);
    return actual.scopeId===canonical.scopeId;
  }catch(_){return false;}
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
  return scopeRecord(sourceKey,"yandex-public",name);
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
  schema:SCHEMA,archiveName,parseTitle,viewerFingerprint,stableHash,resolveName,
  fromYandexPublicLink,fromYandexViewer,restoreScope,matchesTab,sameScope,outputRootConflict
});
})(globalThis);
