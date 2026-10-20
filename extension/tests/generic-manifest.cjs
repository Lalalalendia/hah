const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const c={Date,URL};c.globalThis=c;
for(const f of ["common.js","archive-scope.js","manifest-model.js"])
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,"../"+f),"utf8"),c);
const scope=c.RarRescueArchiveScope.fromYandexPublicLink("https://disk.yandex.ru/d/Xxx","Другой архив.rar");
function makeTree(records){
  const directories=Object.create(null),files=Object.create(null);
  let objects=0;
  for(const [dir,items]of Object.entries(records)){
    directories[dir]={path:dir,entries:items.map(([name,kind])=>({name,kind}))};
    objects+=items.length;
    for(const [name,kind]of items){
      if(kind!=="file")continue;
      const sourcePath=(dir?dir+"/":"")+name;
      files[sourcePath]={sourcePath,folder:dir,name,
        destination:c.RarRescueUtils.relative(dir,name,scope.outputRoot),
        status:"downloaded",bytes:900};
    }
  }
  return {schema:"rar-rescue-tree-v2",scopeId:scope.scopeId,archive:scope.archiveName,
    scanned:true,complete:true,observedObjects:objects,expectedObjects:objects,
    directories,files,issues:[],unknown:[]};
}
const validate=x=>c.RarRescueManifest.importManifest(x,c.RarRescueUtils,scope);
const empty=validate(makeTree({"":[]}));
assert.equal(empty.observedObjects,0);
assert.equal(Object.keys(empty.directories).length,1);
assert.equal(Object.keys(empty.files).length,0);
const tiny=validate(makeTree({"":[["unknown.xyz","file"]]}));
assert.equal(tiny.observedObjects,1);
assert.equal(tiny.files["unknown.xyz"].status,"pending");
assert.equal(tiny.files["unknown.xyz"].destination,"Другой архив.rar/unknown.xyz");
const many=Array.from({length:5010},(_,i)=>["f"+String(i).padStart(5,"0")+".bin","file"]);
const bulk=makeTree({"":[["no-magic-directory","folder"]],
  "no-magic-directory":[["deeper","folder"]],
  "no-magic-directory/deeper":many});
const safe=validate(bulk);
assert.equal(Object.keys(safe.files).length,5010);
assert.equal(Object.keys(safe.directories).length,3);
assert.equal(safe.observedObjects,5012);
assert.equal(safe.files["no-magic-directory/deeper/f00000.bin"].status,"pending");
assert.throws(()=>c.RarRescueManifest.importManifest(bulk,c.RarRescueUtils,
  c.RarRescueArchiveScope.fromYandexPublicLink("https://disk.yandex.ru/d/Other","Другой архив.rar")),
  /belong/);
const wrongCount=makeTree({"":[["random.exe","file"]]});
wrongCount.observedObjects=99;assert.throws(()=>validate(wrongCount),/count/);
const missingFolder=makeTree({"":[["not-scanned","folder"]]});
assert.throws(()=>validate(missingFolder),/graph/);
const clash=makeTree({"":[["a:b","file"],["a_b","file"]]});
assert.throws(()=>validate(clash),/collision/i);
const duplicate=makeTree({"":[["a.TXT","file"],["A.txt","file"]]});
assert.throws(()=>validate(duplicate),/Duplicate/i);
const traversal=makeTree({"":[["normal.exe","file"]]});
traversal.directories[""].entries[0].name="../bad.exe";
assert.throws(()=>validate(traversal),/Invalid|Unsafe/i);
const unknown=makeTree({"":[]});unknown.unknown=[{name:"opaque"}];
assert.throws(()=>validate(unknown),/unknown|erroneous/i);
console.log("PASS: markerless, empty, single-file, 5010-member nested archives, scope isolation and integrity guards");
