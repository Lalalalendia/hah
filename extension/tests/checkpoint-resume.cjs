const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const ctx={};ctx.globalThis=ctx;
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,"../archive-crawler.js"),"utf8"),ctx);
const Crawler=ctx.RarRescueCrawler;
let current="",hint=true,visited=[];
const names={
  "":[{name:"done",kind:"folder"},{name:"pending",kind:"folder"}],
  done:[{name:"old.bin",kind:"file"}],
  pending:[{name:"new.bin",kind:"file"}]
};
const header={querySelector:()=>({textContent:"Example.rar"}),
  getAttribute:n=>n==="data-archive-path"&&hint?(current||"/"):null};
const doc={querySelector:n=>n.includes("archiveHeader_")?header:null};
function crawler(){
  const c=new Crawler(doc,{archiveRows:()=>[]},{delay:async()=>{}});
  c.enumerate=async()=>({ok:true,complete:true,items:names[current],duplicates:[]});
  c.snapshot=()=>current;
  c.locate=async name=>({querySelector:()=>null,click(){current=name;visited.push(name);}});
  c.waitForChange=async previous=>current!==previous;
  c.backButton=()=>({click(){current="";}});
  return c;
}
(async()=>{
  const cp={directories:{"":{path:"",entries:names[""]},
    done:{path:"done",entries:names.done}},completedSubtrees:["done"]};
  const c=crawler();
  assert((await c.begin("Example.rar",cp)).ok);
  const skipped=await c.step();
  assert.equal(skipped.event,"skipped");assert.equal(skipped.path,"done");
  assert.equal((await c.step()).path,"pending");
  assert.equal((await c.step()).completedPath,"pending");
  const result=await c.step();
  assert.equal(result.event,"complete");
  assert.equal(result.objects,4);assert.equal(result.paths,3);
  assert.deepEqual(visited,["pending"]);
  current="pending";hint=false;
  const uncertain=await crawler().begin("Example.rar",cp);
  assert.equal(uncertain.error,"archive-root-unverified-for-checkpoint-reset");
  current="";hint=true;
  names[""]=[...names[""],{name:"changed.txt",kind:"file"}];
  const changed=await crawler().begin("Example.rar",cp);
  assert.equal(changed.error,"checkpoint-directory-changed:");
  console.log("PASS: skip closed subtree, visit pending only, refuse ambiguous root reset");
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
