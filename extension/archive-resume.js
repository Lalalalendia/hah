/* Read-only recovery of an archive that already has an established capture.
 * Never create a new identity from a changing viewer title on resume.
 * New archives still go through the background collision-safe owner allocator.
 */
(function(root){
"use strict";
const REGISTRY_KEY="rr_active_scopes_v16";
const OWNERS_KEY="rr_output_owners_v15";
const normalizeRows=rows=>(rows||[]).map(x=>{
  if(!x||typeof x.name!=="string"||
     !["file","folder","unknown"].includes(x.kind))return null;
  return x.kind+"\0"+x.name.normalize("NFC");
}).filter(Boolean).sort();
function verifiedRoot(tree,frame){
  if(!tree||tree.schema!=="rar-rescue-tree-v2"||tree.complete!==true||
     !tree.scanned||!tree.directories||!tree.files||
     !Object.prototype.hasOwnProperty.call(tree.directories,""))return false;
  const known=normalizeRows(tree.directories[""]?.entries);
  const observed=normalizeRows(frame?.iconSamples);
  const count=Number(frame?.count)+Number(frame?.folders)+Number(frame?.unknown);
  // A partial or virtualized root is not sufficient identity evidence.
  if(!Number.isInteger(count)||count<1||count>16||
     observed.length!==count||known.length!==count)return false;
  return observed.every((value,i)=>value===known[i]);
}
function comparable(scope,detected){
  if(!scope||!detected||scope.sourceKind!==detected.sourceKind)return false;
  if(scope.sourceKind==="yandex-public")return scope.sourceKey===detected.sourceKey;
  if(scope.sourceKind!=="yandex-viewer")return false;
  const prefix=/^(yandex-viewer:[0-9a-f]{16}):[0-9a-f]{16}$/;
  const old=prefix.exec(scope.sourceKey),now=prefix.exec(detected.sourceKey);
  // The path remains fixed while the viewer title or icon samples may drift.
  // Root manifest comparison is still mandatory below.
  return !!old&&!!now&&old[1]===now[1];
}
async function find(storage,scopeApi,rawUrl,frame,detected){
  if(!storage||!scopeApi||!detected||!frame)return null;
  const meta=await storage.get([REGISTRY_KEY,OWNERS_KEY]);
  const registry=meta?.[REGISTRY_KEY];
  const owners=meta?.[OWNERS_KEY]||{};
  const rawScopes=Array.isArray(registry)?registry.slice(0,64):[];
  rawScopes.push(detected); // Recover exact old capture when registry is missing.
  const visited=new Set(),matches=[];
  for(const raw of rawScopes){
    const scope=scopeApi.restoreScope(raw);
    if(!scope||visited.has(scope.scopeId)||!comparable(scope,detected)||
       !scopeApi.matchesTab(scope,rawUrl))continue;
    visited.add(scope.scopeId);
    const state=await storage.get([scope.treeStorageKey,scope.harvestStorageKey]);
    const tree=state?.[scope.treeStorageKey],capture=state?.[scope.harvestStorageKey];
    if(!verifiedRoot(tree,frame)||tree.scopeId!==scope.scopeId||
       capture?.schema!=="rar-rescue-capture-v3"||
       capture.scopeId!==scope.scopeId||
       !Number.isInteger(capture.sourcePathsCount)||
       capture.sourcePathsCount!==Object.keys(tree.files).length||
       !capture.requests||typeof capture.requests!=="object")continue;
    const requests=Object.values(capture.requests);
    if(!requests.length||requests.length>capture.sourcePathsCount)continue;
    // A real historical click ledger, not a newly created empty scope.
    if(!requests.every(req=>
      typeof req?.sourcePath==="string"&&
      Object.prototype.hasOwnProperty.call(tree.files,req.sourcePath)&&
      req.expectedFullPath===scope.outputRoot+"/"+req.sourcePath))
      continue;
    const key=scope.outputRoot.normalize("NFC").toLowerCase();
    if(Object.prototype.hasOwnProperty.call(owners,key)&&
       owners[key]!==scope.scopeId)
      throw Error("Выходная папка сохранённого архива принадлежит другому заданию");
    matches.push({scope,tree,processed:requests.length});
  }
  if(matches.length>1)
    throw Error("Найдены несколько подходящих журналов одного RAR; автоматическое объединение запрещено");
  return matches[0]||null;
}
root.RarRescueResume=Object.freeze({find,verifiedRoot,comparable});
})(globalThis);
