const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const source=fs.readFileSync(path.resolve(__dirname,"../content.js"),"utf8");
const first=source.indexOf("  async function harvestAll(){");
const last=source.indexOf("  async function recoverTree(){",first);
assert(first>0&&last>first,"Harvest startup function not found");
assert(source.includes('harvestStage==="collecting"?"Остановить после текущего файла"'),
  "UI must not claim a file is downloading during preflight");
const extracted=source.slice(first,last);
function harness(config){
  const context={Date,Math,Set,Map,Promise,Object,config};
  context.globalThis=context;context.events=[];context.calls=[];
  vm.createContext(context);
  const setup=[
    'let harvestLoopActive=false,harvestStage="idle",stopRequested=false,running=false,',
    ' harvestWaitingSource=null,treePhase="",treeFrame=null,progress="",notice="",',
    ' clicked=0,harvestSummary=null,',
    ' tree={complete:true,scopeId:"S",files:{"x.txt":{sourcePath:"x.txt",name:"x.txt",folder:""}}},',
    ' scope={scopeId:"S",archiveName:"Example.rar"};',
    'const show=x=>{globalThis.events.push(x);};',
    'const render=()=>{};',
    'const bestFrame=()=>({frameId:17,archiveName:"Example.rar",count:1,folders:0});',
    'let scopeRelease=null,planRelease=null;',
    'const ensureArchiveScope=()=>globalThis.config.scopeDelay ?',
    ' new Promise(resolve=>{scopeRelease=resolve;}) : Promise.resolve();',
    'const inventoryTree=async()=>{};',
    'const send=async message=>{',
    ' globalThis.calls.push(message.kind);',
    ' if(message.kind==="RR_HARVEST_PLAN"){',
    '  if(globalThis.config.planDelay)return new Promise(resolve=>{planRelease=resolve;});',
    '  return {ok:true,total:1,processedSourcePaths:[],retryableSourcePaths:[]};',
    ' }',
    ' return {ok:true};',
    '};',
    'const beginKnownPathNavigation=async()=>{};',
    'const exportAutomaticHarvestReport=async()=>{};'
  ].join("\n");
  vm.runInContext(setup+extracted+[
    'globalThis.test={harvestAll,',
    ' get active(){return harvestLoopActive;},',
    ' get phase(){return harvestStage;},',
    ' get notice(){return notice;},',
    ' stop(){stopRequested=true;},',
    ' completeScope(){if(scopeRelease)scopeRelease();},',
    ' completePlan(){if(planRelease)planRelease({',
    '  ok:true,processedSourcePaths:[],retryableSourcePaths:[]});}',
    '};'
  ].join("\n"),context);
  return {test:context.test,events:context.events,calls:context.calls};
}
(async()=>{
  const slowScope=harness({scopeDelay:true});
  const firstRun=slowScope.test.harvestAll();
  assert.equal(slowScope.test.phase,"preparing");
  assert(slowScope.events[0].includes("Скачивание ещё не началось"));
  assert(slowScope.events.some(x=>x.includes("подтверждаю архив")));
  slowScope.test.stop();slowScope.test.completeScope();
  await firstRun;
  assert.equal(slowScope.test.active,false);
  assert.equal(slowScope.test.phase,"idle");
  assert(slowScope.test.notice.includes("Подготовка отменена"));
  assert(!slowScope.calls.includes("RR_HARVEST_BEGIN"));
  assert(!slowScope.calls.includes("RR_HARVEST_DISPATCH"));
  assert(!slowScope.calls.includes("RR_HARVEST_STOP"));

  const slowPlan=harness({planDelay:true});
  const secondRun=slowPlan.test.harvestAll();
  await Promise.resolve();await Promise.resolve();
  assert(slowPlan.calls.includes("RR_HARVEST_PLAN"));
  assert.equal(slowPlan.test.phase,"preparing");
  assert(slowPlan.events.some(x=>x.includes("журнал")));
  slowPlan.test.stop();slowPlan.test.completePlan();
  await secondRun;
  assert(!slowPlan.calls.includes("RR_HARVEST_BEGIN"));
  assert(!slowPlan.calls.includes("RR_HARVEST_DISPATCH"));
  console.log("PASS: stuck startup visible and cancellable, no file clicked");
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
