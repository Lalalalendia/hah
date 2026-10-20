/* Pure, deterministic two-file acceptance selection for nested RAR paths.
 * Does not click files or trust network requests. Exactly two distinct
 * directories are required before the large recovery is allowed.
 */
(function(root){
"use strict";
const textLike=/\.(?:txt|xml|htm|html|md|json|ini|log|csv|cfg|conf|css|properties|rtf|dtd|xsl)$/i;
const unsafe=/\.(?:exe|com|dll|cmd|bat|sh|ps1|msi|msp|scr|vbs|js|jar|class|so|bin|iso|img)$/i;
function selectTwo(tree,ledger={}){
  if(!tree || !tree.complete || !tree.scanned || tree.observedObjects!==1286)
    return {ok:false,error:"Archive manifest is not complete"};
  if(!tree.files || !tree.directories) return {ok:false,error:"Manifest missing paths"};
  const candidates=[];
  for(const entry of Object.values(tree.files)){
    if(!entry || typeof entry.name!=="string" || typeof entry.folder!=="string" ||
       typeof entry.sourcePath!=="string" || !entry.folder)continue;
    if(entry.sourcePath!==entry.folder+"/"+entry.name || !tree.directories[entry.folder])continue;
    if(unsafe.test(entry.name) || !textLike.test(entry.name))continue;
    const current=ledger["Disk-2.rar/"+entry.sourcePath]?.state;
    if(["downloaded","armed","awaiting","needs-review"].includes(current))continue;
    if(["downloaded","needs-review"].includes(entry.status))continue;
    candidates.push({
      sourcePath:entry.sourcePath,folder:entry.folder,name:entry.name,
      depth:entry.folder.split("/").length
    });
  }
  candidates.sort((a,b)=>a.depth-b.depth || a.sourcePath.localeCompare(b.sourcePath));
  if(candidates.length<2)
    return {ok:false,error:"Not enough untried nested text files for a two-file safety test",eligible:candidates.length};
  const groups=new Map();
  for(const e of candidates){
    const key=e.name.normalize("NFC").toLowerCase();
    const arr=groups.get(key)||[];arr.push(e);groups.set(key,arr);
  }
  let pair;
  for(const arr of groups.values()){
    for(let i=0;i<arr.length && !pair;i++){
      const second=arr.find((x,j)=>j>i && x.folder!==arr[i].folder);
      if(second)pair=[arr[i],second];
    }
    if(pair)break;
  }
  if(!pair){
    const first=candidates[0];
    const second=candidates.find(e=>e.folder!==first.folder);
    if(second)pair=[first,second];
  }
  if(!pair)return {ok:false,error:"Only one distinct nested directory has untried text files",eligible:candidates.length};
  const byPath=new Set(pair.map(e=>e.sourcePath));
  if(byPath.size!==2 || pair[0].folder===pair[1].folder)
    return {ok:false,error:"Nested path pairing failed"};
  return {ok:true,files:pair.map(({sourcePath,folder,name})=>({sourcePath,folder,name})),
    sameBasename:pair[0].name.toLowerCase()===pair[1].name.toLowerCase(),
    candidates:candidates.length};
}
function collisionName(name){
  // The browser may append " (2)" to a late download filename. Blocking
  // related names is safer than accidentally assigning an old transfer to a
  // new file in another source directory.
  return String(name||"").normalize("NFC").toLowerCase()
    .replace(/ \([1-9][0-9]{0,3}\)(\.[^.]+)?$/,"$1");
}
function pendingDirectories(tree,ledger={}){
  if(!tree || !tree.scanned || !tree.complete || tree.observedObjects!==1286 ||
     !tree.directories || !tree.files)
    return {ok:false,error:"Archive manifest is not complete"};
  const all=Object.values(tree.files);
  if(all.length!==1199)return {ok:false,error:"Unexpected manifest file count"};
  const blocked=[];
  const blockedNames=new Set();
  let skipped=0;
  const unresolvedStates=new Set(["armed","awaiting","needs-review","failed"]);
  for(const file of all) {
    if(!file || typeof file.sourcePath!=="string" ||
       typeof file.folder!=="string" || typeof file.name!=="string" ||
       file.sourcePath!==(file.folder?file.folder+"/":"")+file.name ||
       !Object.prototype.hasOwnProperty.call(tree.directories,file.folder))
      return {ok:false,error:"Invalid source path in archive manifest"};
    const key="Disk-2.rar/"+file.sourcePath;
    const record=ledger[key];
    if(record?.state==="downloaded"){skipped++;continue;}
    // An imported or restored manifest may claim a completed file whose
    // browser-ledger proof has been lost. Do not silently re-download it.
    if(unresolvedStates.has(record?.state) ||
       unresolvedStates.has(file.status) || file.status==="downloaded"){
      blocked.push({sourcePath:file.sourcePath,filename:file.name,
        state:record?.state||file.status||"needs-review",
        reason:String(record?.reason||file.error||"Requires verification").slice(0,140)});
      blockedNames.add(collisionName(file.name));
    }
  }
  const blockedPaths=new Set(blocked.map(x=>x.sourcePath));
  const collisionBlocked=[];
  const byFolder=new Map();
  for(const file of all){
    if(ledger["Disk-2.rar/"+file.sourcePath]?.state==="downloaded" ||
       blockedPaths.has(file.sourcePath))continue;
    if(blockedNames.has(collisionName(file.name))){
      collisionBlocked.push(file.sourcePath);
      continue;
    }
    const files=byFolder.get(file.folder)||[];
    files.push({sourcePath:file.sourcePath,folder:file.folder,name:file.name});
    byFolder.set(file.folder,files);
  }
  const groups=[...byFolder].sort(([a],[b])=>a.localeCompare(b))
    .map(([path,files])=>({path,files}));
  const pending=groups.reduce((n,g)=>n+g.files.length,0);
  return {
    ok:true,groups,pending,skipped,
    blocked,blockedCount:blocked.length,
    collisionBlocked,
    collisionBlockedCount:collisionBlocked.length,
    held:blocked.length+collisionBlocked.length,
    visitedDirectoryCount:groups.length,
    accounted:pending+skipped+blocked.length+collisionBlocked.length
  };
}

root.RarRescuePlan=Object.freeze({selectTwo,pendingDirectories,collisionName});
})(globalThis);
