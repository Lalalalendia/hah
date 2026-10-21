const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const source=fs.readFileSync(path.resolve(__dirname,"../content.js"),"utf8");
const from=source.indexOf("  async function scan() {");
const to=source.indexOf("  async function choosePilot(",from);
assert(from>0 && to>from,"Cannot find Yandex frame scan function");
assert(source.includes('else if(scanning||!bestFrame())void scan();'),
  "Main button must allow manual frame rescan instead of disabled waiting");
assert(source.includes('el("rr-harvest").disabled=running&&!harvestLoopActive;'),
  "Read-only scan must not disable only accessible button");
assert(!source.includes("Ожидаю проверки."),"Unhelpful waiting placeholder returned");
assert(!source.includes("Используем названия файлов и кнопки на скриншотах DevTools."),
  "Obsolete DevTools placeholder returned");
function harness(){
  let timers=[],tasks=[],updates=[];
  const ctx={Math,Date,Promise,
    setTimeout(fn,ms){const row={fn,ms,cancelled:false};timers.push(row);return row;},
    clearTimeout(row){row.cancelled=true;}};
  ctx.globalThis=ctx;vm.createContext(ctx);
  const setup=`let viewerFrameAlias=null,running=false,frames=new Map(),scanId="",scanning=false,
    approved=null,notice="",sendImpl=async()=>({ok:true});
    const sleep=async()=>{};
    const bestFrame=()=>frames.values().next().value||null;
    const send=(payload)=>sendImpl(payload);
    const show=(value)=>{notice=value;globalThis.updates.push(value);};
    `;
  ctx.updates=updates;
  vm.runInContext(setup+source.slice(from,to)+`
    globalThis.test={
      scan,frames,changeSend(fn){sendImpl=fn;},
      get scanning(){return scanning;},get notice(){return notice;},
      get scanId(){return scanId;},get viewerFrameAlias(){return viewerFrameAlias;}
    };
  `,ctx);
  return {test:ctx.test,timers,updates};
}
(async()=>{
  // Lost background acknowledgement: the UI recovers in bounded time,
  // without touching the tree or issuing a file download.
  const h=harness();
  h.test.changeSend(()=>new Promise(()=>{}));
  const inProgress=h.test.scan();
  assert.equal(h.test.scanning,true);
  assert(h.updates.at(-1).includes("Ищу файлы"));
  assert.equal(h.timers.length,1);
  assert.equal(h.timers[0].ms,6000);
  h.timers[0].fn();
  await inProgress;
  assert.equal(h.test.scanning,false);
  assert(h.test.notice.includes("не ответил за 6 секунд"));
  assert(h.test.notice.includes("Журнал предыдущих загрузок сохранён"));

  // Receiving a frame report is independent from a lost RR_SCAN_FRAMES ACK.
  const ok=harness();
  ok.test.changeSend(()=>new Promise(()=>{}));
  const pending=ok.test.scan();
  ok.test.frames.set("7",{frameId:7,count:8,folders:7});
  ok.timers[0].fn();await pending;
  assert(ok.test.notice.includes("Найден веб-просмотрщик RAR: 8 файлов, 7 папок"));

  // A new user rescan must win over a delayed older scan completion.
  const race=harness();
  const resolvers=[];
  race.test.changeSend(()=>new Promise(resolve=>resolvers.push(resolve)));
  const older=race.test.scan();
  const newer=race.test.scan();
  assert.equal(race.test.scanning,true);
  assert.equal(resolvers.length,2);
  resolvers[0]({ok:true});await older;
  assert.equal(race.test.scanning,true,"Old scan may not unlock a newer pending scan");
  resolvers[1]({ok:true});await newer;
  assert.equal(race.test.scanning,false);
  console.log("PASS: no phantom verification, bounded frame scan, manual retry, late results ignored");
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
