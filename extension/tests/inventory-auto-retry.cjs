const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const source=fs.readFileSync(path.resolve(__dirname,"../content.js"),"utf8");
const start=source.indexOf("  function canResumeTree(){");
const end=source.indexOf("  /* Bounded acceptance:",start);
assert(start>0&&end>start);
const setup=String.raw`
let tree=null,running=false,stopRequested=false,treePhase="",treeFrame=null;
const scope={scopeId:"S",archiveName:"Example.rar"},logs=[],passes=[];
const sleep=async()=>{},render=()=>{},bestFrame=()=>({frameId:2}),show=s=>logs.push(s);
const newTree=()=>({schema:"rar-rescue-tree-v2",scopeId:"S",scanned:false,complete:false,
  directories:Object.create(null),files:Object.create(null),
  completedSubtrees:[],issues:[],unknown:[]});
const saveTree=async()=>{};
let transient=true;
const inventoryPass=async(_frame,checkpoint)=>{
  passes.push(checkpoint);
  if(transient&&passes.length===1){
    tree.directories[""]={path:"",entries:[{name:"done",kind:"folder"}]};
    tree.directories.done={path:"done",entries:[{name:"ok.bin",kind:"file"}]};
    tree.completedSubtrees.push("done");
    throw Error("Could not establish connection. Receiving end does not exist.");
  }
  if(!transient)throw Error("archive-root-unverified-for-checkpoint-reset");
  tree.complete=true;tree.scanned=true;
};
`;
(async()=>{
  const c={};c.globalThis=c;
  vm.runInNewContext(setup+source.slice(start,end)+
    "globalThis.test={inventoryTree,logs,passes,getTree:()=>tree,setUnverified:()=>{transient=false;tree.complete=false;tree.scanned=false;}};",c);
  await c.test.inventoryTree();
  assert.equal(c.test.passes.length,2);
  assert.deepEqual(Array.from(c.test.passes[1].completedSubtrees),["done"]);
  assert(c.test.getTree().complete);
  c.test.setUnverified();c.test.passes.length=0;
  await c.test.inventoryTree();
  assert.equal(c.test.passes.length,1);
  assert(c.test.getTree().issues.some(x=>x.reason==="crawl-interrupted"));
  assert(c.test.logs.some(x=>x.includes("Не удалось подтвердить корень")));
  console.log("PASS: transient iframe loss auto resumes saved map; uncertain root stops safely");
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
