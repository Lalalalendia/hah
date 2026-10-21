const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const ctx={};ctx.globalThis=ctx;
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,"../viewer-channel.js"),"utf8"),ctx);
const Channel=ctx.RarRescueViewerChannel;
const lost=()=>{throw Error("Could not establish connection. Receiving end does not exist.");};
(async()=>{
  const calls=[];
  const api={tabs:{async sendMessage(_tab,payload,{frameId}){
    calls.push(["send",frameId]);
    if(frameId===8)lost();
    assert.equal(frameId,19);
    return {ok:true,event:"directory",path:"",items:[{name:"10000000",kind:"folder"}]};
  }},scripting:{async executeScript({target,files}){
    if(files){calls.push(["inject",target.frameIds[0]]);assert.equal(target.frameIds[0],19);
      assert.equal(files[3],"frame-sensor.js");return [];}
    assert(target.allFrames);calls.push(["probe"]);
    return [{frameId:0,result:{hasViewer:false,title:""}},
      {frameId:19,result:{hasViewer:true,visibleRows:15,title:"Диск 1.rar"}}];
  }}};
  const channel=new Channel(api),begin={kind:"RR_SENSOR_CRAWL_BEGIN",archiveName:"Диск 1.rar"};
  const recovered=await channel.invoke(42,8,begin);
  assert.equal(recovered.frameId,19);assert(recovered.reconnected&&recovered.result.ok);
  assert.deepEqual(calls.map(x=>x[0]),["send","probe","inject","send"]);
  calls.length=0;
  await assert.rejects(()=>channel.invoke(42,8,{kind:"RR_SENSOR_TRIGGER",name:"README.TXT"}),/No click was repeated/);
  await assert.rejects(()=>channel.invoke(42,8,{kind:"RR_SENSOR_CRAWL_STEP"}),/No click was repeated/);
  assert.deepEqual(calls.map(x=>x[0]),["send","send"]);
  const ambiguous={tabs:{async sendMessage(){lost();}},scripting:{async executeScript(){return [
    {frameId:12,result:{hasViewer:true,title:"Диск 1.rar"}},
    {frameId:13,result:{hasViewer:true,title:"Диск 1.rar"}}];}}};
  await assert.rejects(()=>new Channel(ambiguous).invoke(42,8,begin),/Several archive viewer frames/);
  console.log("PASS: reconnect missing viewer sensor, idempotent scan and no repeat file click");
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
