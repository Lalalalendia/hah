/* Pure, reusable RAR recovery manifest validation.
 * Imported user files are untrusted; recompute all paths and statuses.
 */
(function(root){
"use strict";
function importManifest(raw,utils){
  if(!raw || raw.schema!=="rar-rescue-tree-v1" || raw.archive!=="Диск 2.rar" ||
    raw.expectedObjects!==1286 || !raw.scanned || !raw.complete)
    throw new Error("Нужен полный JSON-манифест Диск 2.rar из RAR Rescue v0.5");
  const srcDirs=raw.directories;
  if(!srcDirs || typeof srcDirs!=="object" || Array.isArray(srcDirs))throw new Error("Нет дерева папок");
  if(!raw.files || typeof raw.files!=="object" || Array.isArray(raw.files))throw new Error("Нет списка файлов");
  if((raw.issues||[]).length || (raw.unknown||[]).length)throw new Error("В исходной карте есть проблемы");
  const srcKeys=Object.keys(srcDirs);
  if(srcKeys.length>1400 || !srcKeys.includes(""))throw new Error("Не найден корень");
  const validSegment=s=>typeof s==="string" && s.length>0 && s.length<=200 &&
    ![".","..","__proto__","prototype","constructor"].includes(s.toLowerCase()) &&
    !/[/\\\u0000-\u001f]/.test(s);
  function pathToParts(path){
    if(typeof path!=="string")throw new Error("Недопустимый путь");
    if(!path)return [];
    const parts=path.split("/");
    if(!parts.every(validSegment) || parts.length>32)throw new Error("Небезопасный путь");
    return parts;
  }
  const rootList=srcDirs[""].entries||[];
  const rootNames=new Set(rootList.map(e=>e.name));
  if(!rootNames.has("README.TXT") || !rootNames.has("HELP"))
    throw new Error("Похоже, это карта другого архива");
  const directories=Object.create(null);
  const files=Object.create(null);
  const expectedDirs=new Set([""]);
  const mappedWindows=new Map();
  let observed=0;
  function uniqueOutput(path,source){
    const key=path.normalize("NFC").toLowerCase();
    const prior=mappedWindows.get(key);
    if(prior && prior!==source)throw new Error("Коллизия Windows-путей: "+source);
    mappedWindows.set(key,source);
  }
  for(const path of srcKeys){
    pathToParts(path);
    const info=srcDirs[path];
    if(!info || info.path!==path || !Array.isArray(info.entries) || info.entries.length>3500)
      throw new Error("Неверный каталог: "+path);
    const seen=new Set(),entries=[];
    for(const entry of info.entries){
      if(!entry || !validSegment(entry.name) || !["file","folder"].includes(entry.kind))
        throw new Error("Недопустимый объект в каталоге: "+path);
      const pathOf=(path?path+"/":"")+entry.name;
      if(seen.has(entry.name.toLowerCase()))throw new Error("Повторное имя: "+pathOf);
      seen.add(entry.name.toLowerCase());
      const target=utils.relative(path,entry.name);
      uniqueOutput(target,pathOf);
      if(entry.kind==="folder")expectedDirs.add(pathOf);
      else {
        const original=raw.files[pathOf];
        if(!original || original.sourcePath!==pathOf ||
            original.folder!==path || original.name!==entry.name ||
            original.destination!==target)
          throw new Error("Несовпадение пути файла: "+pathOf);
        files[pathOf]={
          sourcePath:pathOf,folder:path,name:entry.name,destination:target,
          status:"pending",attempts:0,bytes:0,error:""
        };
      }
      entries.push({name:entry.name,kind:entry.kind});
      observed++;
    }
    directories[path]={path,entries,empty:entries.length===0,
      scannedAt:typeof info.scannedAt==="string"?info.scannedAt:null};
  }
  if(expectedDirs.size!==srcKeys.length ||
     srcKeys.some(k=>!expectedDirs.has(k)))
    throw new Error("Нарушены родительские связи папок");
  if(Object.keys(files).length!==Object.keys(raw.files).length)
    throw new Error("Часть файлов не принадлежит дереву");
  if(observed!==1286 || Number(raw.observedObjects)!==1286 ||
     Object.keys(files).length!==1199 || srcKeys.length!==88)
    throw new Error("Количество объектов не соответствует исходному архиву");
  return {
    schema:"rar-rescue-tree-v1",archive:"Диск 2.rar",expectedObjects:1286,
    createdAt:typeof raw.createdAt==="string"?raw.createdAt:new Date().toISOString(),
    scanned:true,complete:true,observedObjects:1286,importedAt:new Date().toISOString(),
    directories,files,unknown:[],issues:[]
  };
}
root.RarRescueManifest=Object.freeze({importManifest});
})(globalThis);
