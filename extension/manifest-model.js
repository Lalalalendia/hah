/* Validate a discovered archive tree by structure, not by any known
 * filename or object count. Legacy v1 import remains read-only compatible
 * with the historical Disk-2 fixture; new archives require a bound scope.
 */
(function(root){
"use strict";
const MAX_ITEMS=100000;
const MAX_FOLDERS=100000;
const SCHEMA_V2="rar-rescue-tree-v2";
function importManifest(raw,utils,scope=null){
  const generic=Boolean(scope);
  if(!raw||typeof raw!=="object"||!raw.scanned||!raw.complete)
    throw Error("Archive tree is not fully inventoried");
  if(generic){
    if(raw.schema!==SCHEMA_V2||raw.scopeId!==scope.scopeId||
       raw.archive!==scope.archiveName||!scope.outputRoot)
      throw Error("Manifest does not belong to this archive");
  }else if(raw.schema!=="rar-rescue-tree-v1"||
           raw.archive!=="Диск 2.rar"||raw.expectedObjects!==1286)
    throw Error("Legacy manifest can only be used for the original Disk-2 fixture");
  const srcDirs=raw.directories,srcFiles=raw.files;
  if(!srcDirs||typeof srcDirs!=="object"||Array.isArray(srcDirs)||
     !srcFiles||typeof srcFiles!=="object"||Array.isArray(srcFiles))
    throw Error("Missing directory or file registry");
  if(!Array.isArray(raw.issues)||raw.issues.length||
     !Array.isArray(raw.unknown)||raw.unknown.length)
    throw Error("The inventory contains unknown or erroneous entries");
  const srcKeys=Object.keys(srcDirs),srcFileKeys=Object.keys(srcFiles);
  if(srcKeys.length<1||srcKeys.length>MAX_FOLDERS||!srcKeys.includes("")||
     srcFileKeys.length>MAX_ITEMS)
    throw Error("Archive root missing or safety budget exceeded");
  const validPart=value=>typeof value==="string"&&value.length>0&&
    value.length<=200&&![".","..","__proto__","prototype","constructor"].includes(value.toLowerCase())&&
    !/[/\\\u0000-\u001f]/.test(value);
  function partsOf(path){
    if(typeof path!=="string")throw Error("Invalid archive path");
    if(!path)return [];
    const parts=path.split("/");
    if(parts.length>32||!parts.every(validPart))throw Error("Unsafe archive path");
    return parts;
  }
  const rootEntries=srcDirs[""]?.entries||[];
  if(!generic){
    const rootNames=new Set(rootEntries.map(x=>x.name));
    if(!rootNames.has("README.TXT")||!rootNames.has("HELP"))
      throw Error("Invalid legacy source root");
  }
  const outputRoot=generic?scope.outputRoot:undefined;
  const dirs=Object.create(null),files=Object.create(null),expectedDirs=new Set([""]);
  const outputPaths=new Map();
  let observed=0;
  function uniqueOutput(path,source){
    const key=path.normalize("NFC").toLowerCase();
    const prior=outputPaths.get(key);
    if(prior&&prior!==source)throw Error("Windows output path collision: "+source);
    outputPaths.set(key,source);
  }
  for(const path of srcKeys){
    const parts=partsOf(path);
    const info=srcDirs[path];
    if(!info||info.path!==path||!Array.isArray(info.entries)||
       info.entries.length>MAX_ITEMS)throw Error("Invalid folder entry: "+path);
    const seen=new Set(),entries=[];
    for(const item of info.entries){
      if(!item||!validPart(item.name)||!["file","folder"].includes(item.kind))
        throw Error("Invalid archive member in: "+path);
      const sourcePath=(path?path+"/":"")+item.name;
      if(partsOf(sourcePath).length!==parts.length+1)
        throw Error("Archive member escapes parent");
      const normalized=item.name.normalize("NFC").toLowerCase();
      if(seen.has(normalized))throw Error("Duplicate name in folder: "+sourcePath);
      seen.add(normalized);
      const destination=utils.relative(path,item.name,outputRoot);
      uniqueOutput(destination,sourcePath);
      if(item.kind==="folder")expectedDirs.add(sourcePath);
      else{
        if(!Object.prototype.hasOwnProperty.call(srcFiles,sourcePath))
          throw Error("File missing from registry: "+sourcePath);
        const original=srcFiles[sourcePath];
        if(!original||original.sourcePath!==sourcePath||original.folder!==path||
           original.name!==item.name||original.destination!==destination)
          throw Error("Manifest file path mismatch: "+sourcePath);
        files[sourcePath]={sourcePath,folder:path,name:item.name,destination,
          status:"pending",attempts:0,bytes:0,error:""};
      }
      observed++;
      if(observed>MAX_ITEMS)throw Error("Archive member safety budget exceeded");
      entries.push({name:item.name,kind:item.kind});
    }
    dirs[path]={path,entries,empty:entries.length===0,
      scannedAt:typeof info.scannedAt==="string"?info.scannedAt:null};
  }
  if(expectedDirs.size!==srcKeys.length||srcKeys.some(k=>!expectedDirs.has(k)))
    throw Error("Directory graph is inconsistent");
  if(Object.keys(files).length!==srcFileKeys.length)
    throw Error("Unowned files remain in the manifest");
  if(Number(raw.observedObjects)!==observed||
     (raw.expectedObjects!=null&&Number(raw.expectedObjects)!==observed))
    throw Error("Observed object count is inconsistent with the tree");
  if(!generic&&(observed!==1286||srcFileKeys.length!==1199||
                srcKeys.length!==88))
    throw Error("Legacy Disk-2 fixture size mismatch");
  return {schema:generic?SCHEMA_V2:"rar-rescue-tree-v1",
    scopeId:generic?scope.scopeId:null,archive:generic?scope.archiveName:"Диск 2.rar",
    expectedObjects:observed,observedObjects:observed,
    createdAt:typeof raw.createdAt==="string"?raw.createdAt:new Date().toISOString(),
    scanned:true,complete:true,importedAt:new Date().toISOString(),
    directories:dirs,files,unknown:[],issues:[]};
}
root.RarRescueManifest=Object.freeze({importManifest,MAX_ITEMS,MAX_FOLDERS});
})(globalThis);
