const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const ctx={setTimeout,clearTimeout};ctx.globalThis=ctx;
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,"../harvest-wakeup.js"),"utf8"),ctx);
(async()=>{
  const wake=new ctx.RarRescueHarvestWake();
  const first=wake.snapshot();
  const waiting=wake.wait(first,1000);
  wake.notify();
  assert.equal(await waiting,"download-event","Chrome completion must wake without polling timeout");
  assert.equal(wake.waiters.size,0);
  assert.equal(await wake.wait(first,1000),"download-event","No missed wake between check and waiting");
  const current=wake.snapshot();
  assert.equal(await wake.wait(current,5),"poll-timeout","Polling still works if a browser event was lost");
  assert.equal(wake.waiters.size,0,"No leaked resolver across 3k requests");
  let signaled=0;
  const pending=Array.from({length:3},()=>wake.wait(current,1000).then(v=>{
    assert.equal(v,"download-event");signaled++;
  }));
  wake.notify();await Promise.all(pending);
  assert.equal(signaled,3);assert.equal(wake.waiters.size,0);
  console.log("PASS: completed download wakes queue immediately; race-free and timeout fallback");
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
