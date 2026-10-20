/* RAR Rescue v0.13: one click per archive member, up to 120 seconds of
 * waiting, full-fidelity audit of separately identified browser downloads.
 * No signed URLs, cookies or file contents are stored or uploaded.
 */
(function(root){
"use strict";
const KEY="rr_harvest_v13";
const OLD_KEY="rr_harvest_v12";
const SCHEMA="rar-rescue-capture-v3";
const WAIT_MS=120000;
const TAIL_MS=60*60*1000;
const SAFE_ROOT="Disk-2.rar";
const VALID_STATES=new Set(["complete","interrupted","in_progress"]);
const normPath=value=>String(value||"").replace(/\\/g,"/");
const basename=value=>normPath(value).split("/").pop().slice(0,220);
const ownReport=item=>/^Disk-2\.rar-download-log(?: \([0-9]+\))?\.json$/i.test(basename(item?.filename));
const sourcePath=(folder,name)=>(folder?folder+"/":"")+name;
const iso=()=>new Date().toISOString();
const empty=()=>({schema:SCHEMA,phase:"idle",batchId:null,tabId:null,
  createdAt:null,startedAt:0,tailDeadline:0,requests:{},downloads:{},audit:[],
  sourcePathsCount:1199,migratedFrom:null});
function safeSource(value){
  if(typeof value!=="string"||!value||value.length>2500||value.startsWith("/")||
     value.split("/").some(part=>!part||part==="."||part===".."||part.length>200||
       /[\\\u0000-\u001f]/.test(part)))throw Error("Unsafe archive source path");
  return value;
}
class HarvestWorker {
  constructor(api,utils){
    this.api=api;this.utils=utils;this.state=empty();this.serial=Promise.resolve();this.lastPolled={};
    this.ready=api.storage.local.get([KEY,OLD_KEY]).then(data=>{
      const newer=data?.[KEY];
      if(newer?.schema===SCHEMA){this.state=newer;return;}
      const old=data?.[OLD_KEY];
      if(!old?.requests||!old?.downloads)return;
      const migrated=empty();
      migrated.batchId=old.batchId||null;
      migrated.createdAt=old.createdAt||null;
      migrated.migratedFrom=OLD_KEY;
      for(const [path,source] of Object.entries(old.requests)){
        if(!source||!source.name)continue;
        migrated.requests[path]={
          ...source,clickId:source.clickId||"legacy:"+path,
          expectedFullPath:SAFE_ROOT+"/"+path,
          dispatchAt:Number(source.clickedAt)||Number(source.createdAt)||0,
          clickedAt:Number(source.clickedAt)||0,
          clickConfirmedAt:Number(source.clickedAt)||0,
          deadlineAt:0,
          state:source.state||"legacy-unconfirmed",
          downloadIds:[...(source.assignedDownloadIds||[])],
          assignedDownloadIds:undefined,legacy:true
        };
      }
      for(const [id,item] of Object.entries(old.downloads)){
        if(!item)continue;
        migrated.downloads[id]={...item,
          downloadId:Number(item.id)||Number(id),
          expectedFullPath:item.sourcePath?SAFE_ROOT+"/"+item.sourcePath:null,
          actualSavedFullPath:item.actualSavedPath||null,
          serverReportedName:item.browserName||null,
          associationConfidence:item.matchConfidence||"legacy-unverified",
          completedAt:item.completedAt||null,legacy:true};
      }
      migrated.audit=[{at:iso(),type:"migration",detail:"Imported v0.12 click/download evidence without automatic re-clicks"}];
      this.state=migrated;
    }).catch(()=>{});
  }
  async atomic(fn){
    const job=this.serial.then(async()=>{
      await this.ready;
      const result=await fn(this.state);
      await this.api.storage.local.set({[KEY]:this.state});
      return result;
    });
    this.serial=job.catch(()=>{});
    return job;
  }
  log(type,path,details){
    this.state.audit.push({at:iso(),type,sourcePath:path||null,detail:String(details||"").slice(0,220)});
    if(this.state.audit.length>300)this.state.audit.splice(0,this.state.audit.length-300);
  }
  recording(now=Date.now()){
    return this.state.phase==="collecting"||
      (this.state.phase==="tail"&&now<this.state.tailDeadline);
  }
  sourceAllowed(item){
    if(!this.recording()||!item||ownReport(item)||
       !this.utils.isDownloadHost(item.url||item.finalUrl||""))return false;
    if(Number.isInteger(item.tabId)&&item.tabId>=0&&item.tabId!==this.state.tabId){
      let host="";
      try{host=new URL(item.url||item.finalUrl||"").hostname;}catch(_){}
      // Detached viewer downloads may not have the parent tab ID.
      if(!/(^|\.)(docviewer|downloader)\./.test(host))return false;
    }
    return true;
  }
  async begin(tabId,total){
    if(!Number.isInteger(tabId)||tabId<0||total!==1199)throw Error("Wrong RAR scope");
    await this.ready;
    if(this.state.phase==="collecting"&&this.state.tabId!==tabId && this.api.tabs?.get){
      try{await this.api.tabs.get(this.state.tabId);throw Error("Another recovery tab is still active");}
      catch(e){if(e.message==="Another recovery tab is still active")throw e;}
    }
    return this.atomic(s=>{
      if(!s.batchId){s.batchId="harvest-"+Date.now();s.createdAt=iso();}
      s.tabId=tabId;s.phase="collecting";s.startedAt=Date.now();s.tailDeadline=0;
      this.log("begin",null,"Capture resumed; 120s per source, no automatic retries");
      return this.summary();
    });
  }
  async stop(){
    return this.atomic(s=>{
      s.phase="tail";s.tailDeadline=Date.now()+TAIL_MS;
      this.log("stop",null,"Late browser events kept for at least 60 minutes");
      return this.summary();
    });
  }
  async arm(folder,name){
    const path=safeSource(sourcePath(folder,name));
    if(!name||name.includes("/")||name.includes("\\"))throw Error("Bad basename");
    // Normalize Windows directory names through existing safe common helper.
    const checked=this.utils.relative(folder,name);
    if(!checked.endsWith("/"+this.utils.component(name)))throw Error("Unsafe filename");
    return this.atomic(s=>{
      if(s.phase!=="collecting")throw Error("Capture not active");
      if(s.requests[path])return {ok:true,skipped:true,sourcePath:path,state:s.requests[path].state};
      const id=s.batchId+":"+(Object.keys(s.requests).length+1);
      s.requests[path]={sourcePath:path,expectedFullPath:SAFE_ROOT+"/"+path,
        folder,name,clickId:id,armedAt:Date.now(),dispatchAt:0,clickedAt:0,
        clickConfirmedAt:0,deadlineAt:0,timedOutAt:0,state:"armed",downloadIds:[],
        observedNames:[],lastError:null};
      return {ok:true,skipped:false,sourcePath:path,clickId:id};
    });
  }
  async dispatch(folder,name){
    const path=sourcePath(folder,name);
    return this.atomic(s=>{
      if(s.phase!=="collecting")throw Error("Capture stopped");
      const r=s.requests[path];
      if(!r||r.dispatchAt)throw Error("Source already dispatched or not reserved");
      r.dispatchAt=Date.now();r.deadlineAt=r.dispatchAt+WAIT_MS;
      r.state="dispatched";
      this.log("click-dispatch",path,r.clickId);
      return {ok:true,sourcePath:path,clickId:r.clickId,deadlineAt:r.deadlineAt};
    });
  }
  async sent(folder,name,clicked,reason,definiteFailure=false){
    const path=sourcePath(folder,name);
    return this.atomic(s=>{
      const r=s.requests[path];if(!r||!r.dispatchAt)throw Error("Source not dispatched");
      if(clicked){
        if(!r.clickConfirmedAt)r.clickConfirmedAt=Date.now();
        r.clickedAt=r.clickConfirmedAt;
        if(!r.downloadIds.length&&r.state!=="timed_out")r.state="clicked";
        this.log("click-confirmed",path,r.clickId);
      }else{
        r.lastError=String(reason||"Viewer did not confirm a click").slice(0,180);
        if(!r.downloadIds.length&&r.state!=="timed_out")
          r.state=definiteFailure?"not-clicked":"click-unknown";
        this.log(definiteFailure?"no-click":"click-uncertain",path,r.lastError);
      }
      return {ok:true,state:r.state,sourcePath:path,clickId:r.clickId};
    });
  }
  choose(item){
    const filename=basename(item.filename).normalize("NFC").toLowerCase();
    const now=Date.now();
    const unassigned=Object.values(this.state.requests).filter(r=>
      Number(r.dispatchAt)>0 && r.downloadIds.length===0 &&
      now-r.dispatchAt>=-2000 && now-r.dispatchAt<=60*60*1000);
    const exact=unassigned.filter(r=>r.name.normalize("NFC").toLowerCase()===filename);
    if(filename && exact.length===1)return {r:exact[0],confidence:"unique-name-temporal-hypothesis"};
    const active=unassigned.filter(r=>!r.timedOutAt&&now<=r.deadlineAt)
      .sort((a,b)=>b.dispatchAt-a.dispatchAt);
    if(active.length===1)return {r:active[0],confidence:
      filename===active[0].name.toLowerCase()?"active-click-name-hypothesis":"active-click-name-mismatch-hypothesis"};
    // Late and mismatched response may belong to any timed-out request.
    return {r:null,confidence:unassigned.length?"ambiguous-late-download":"unattributed-download"};
  }
  async created(item){
    return this.atomic(s=>{
      if(!this.sourceAllowed(item))return false;
      const key=String(item.id);
      if(!s.downloads[key]){
        s.downloads[key]={downloadId:item.id,sourcePath:null,expectedFullPath:null,
          serverReportedName:basename(item.filename)||null,
          state:item.state||"in_progress",createdAt:iso(),createdTimeMs:Date.now(),
          startTime:item.startTime||null,completedAt:null,bytes:Number(item.bytesReceived)||0,
          actualSavedFullPath:null,actualSavedRelativePath:null,nameMismatch:false,
          pathMismatch:false,associationConfidence:"awaiting-browser-filename",browserTabMatched:item.tabId===s.tabId};
        this.log("download-started",null,"id="+item.id);
      }
      return true;
    });
  }
  async determine(item){
    return this.atomic(s=>{
      if(ownReport(item)){
        // The JSON report is also downloaded from a blob:disk.yandex.ru URL.
        // It is NOT an archive member, never count/relocate it.
        delete s.downloads[String(item.id)];
        return {handled:false};
      }
      if(!this.sourceAllowed(item))return {handled:false};
      const key=String(item.id);
      const old=s.downloads[key]||null;
      if(old?.outputRelative)return {handled:true,filename:old.outputRelative,conflictAction:"uniquify"};
      const actualName=basename(item.filename)||"unknown-"+key+".bin";
      const {r,confidence}=this.choose(item);
      // Archive root is the only fallback for genuinely unattributable data.
      // Never add a special subfolder or rename server-returned basenames.
      const parts=r?.folder?r.folder.split("/").map(this.utils.component):[];
      const relative=[SAFE_ROOT,...parts,this.utils.component(actualName)].join("/");
      const event={...(old||{}),downloadId:item.id,
        createdAt:old?.createdAt||iso(),createdTimeMs:old?.createdTimeMs||Date.now(),
        sourcePath:r?.sourcePath||null,expectedFullPath:r?.expectedFullPath||null,
        requestedName:r?.name||null,serverReportedName:actualName,
        associationConfidence:confidence,
        nameMismatch:!!r&&r.name.normalize("NFC").toLowerCase()!==actualName.normalize("NFC").toLowerCase(),
        state:item.state||"in_progress",bytes:Number(item.bytesReceived)||0,
        actualSavedFullPath:null,actualSavedRelativePath:null,pathMismatch:false,
        outputRelative:relative,browserTabMatched:item.tabId===s.tabId};
      s.downloads[key]=event;
      if(r){
        if(!r.downloadIds.includes(item.id))r.downloadIds.push(item.id);
        if(!r.observedNames.includes(actualName))r.observedNames.push(actualName);
        if(!["timed_out","complete","interrupted"].includes(r.state))r.state="downloading";
      }
      this.log(event.nameMismatch?"name-mismatch":"filename",r?.sourcePath||null,
        "expected="+(r?.expectedFullPath||"unknown")+"; returned="+relative+"; downloadId="+item.id);
      return {handled:true,filename:relative,conflictAction:"uniquify"};
    });
  }
  async changed(id,item){
    return this.atomic(s=>{
      const row=s.downloads[String(id)];if(!row)return false;
      if(!item||!VALID_STATES.has(item.state))return true;
      row.state=item.state;
      row.bytes=Number(item.bytesReceived)||0;
      row.totalBytes=Number(item.totalBytes)||0;
      row.exists=item.exists!==false;
      // Exact browser absolute path is intentionally kept locally and in the
      // user-requested JSON report (never sent to a remote endpoint).
      row.actualSavedFullPath=String(item.filename||"")||row.actualSavedFullPath;
      const full=normPath(row.actualSavedFullPath);
      const marker="/"+SAFE_ROOT+"/";
      const idx=full.toLowerCase().lastIndexOf(marker.toLowerCase());
      row.actualSavedRelativePath=idx>=0?full.slice(idx+1):basename(full);
      row.actualBrowserName=basename(item.filename)||row.serverReportedName;
      row.pathMismatch=!!row.outputRelative&&
        !full.toLowerCase().endsWith("/"+row.outputRelative.toLowerCase());
      if(item.error)row.error=String(item.error).slice(0,160);
      if(item.state==="complete"||item.state==="interrupted"){
        if(!row.completedAt)row.completedAt=iso();
        const r=row.sourcePath?s.requests[row.sourcePath]:null;
        if(r){
          r.state=item.state==="complete"?"complete":"interrupted";
          r.finalDownloadId=id;
          r.completedAt=row.completedAt;
        }
        this.log("download-"+item.state,row.sourcePath,
          "id="+id+" expected="+(row.expectedFullPath||"unknown")+
          " actual="+(row.actualSavedFullPath||"missing"));
      }
      return true;
    });
  }
  async check(folder,name){
    const path=sourcePath(folder,name);
    await this.ready;await this.serial;
    let req=this.state.requests[path];
    if(!req)return {ok:false,error:"Unknown source"};
    // Browser events normally update the journal immediately. Search exact
    // Chrome download IDs only every 4 seconds as fallback for worker restarts.
    if(req.downloadIds?.length &&
       Date.now()-(this.lastPolled[path]||0)>=4000){
      this.lastPolled[path]=Date.now();
      for(const id of [...req.downloadIds]){
        const rows=await this.api.downloads.search({id});
        if(rows?.[0]&&["complete","interrupted"].includes(rows[0].state))
          await this.changed(id,rows[0]);
      }
    }
    await this.serial;
    req=this.state.requests[path];
    const terminal=req.downloadIds?.map(id=>this.state.downloads[String(id)])
      .find(x=>x&&["complete","interrupted"].includes(x.state));
    if(terminal)return {ok:true,state:terminal.state,downloadId:terminal.downloadId,
      elapsedMs:Date.now()-req.dispatchAt,remainingMs:0};
    if(req.state==="not-clicked")return {ok:true,state:"not-clicked",remainingMs:0};
    if(req.dispatchAt&&Date.now()>=req.deadlineAt){
      if(!req.timedOutAt)await this.atomic(state=>{
        const row=state.requests[path];
        if(!row.timedOutAt){
          row.timedOutAt=Date.now();row.state="timed_out";
          this.log("timeout",path,"120 seconds exhausted; no second click");
        }
      });
      return {ok:true,state:"timed_out",remainingMs:0,
        downloadIds:[...req.downloadIds]};
    }
    return {ok:true,state:"waiting",remainingMs:Math.max(0,req.deadlineAt-Date.now()),
      downloadIds:[...req.downloadIds]};
  }
  async status(){await this.ready;await this.serial;return this.summary();}
  summary(){
    const requests=Object.values(this.state.requests),rows=Object.values(this.state.downloads);
    return {ok:true,phase:this.state.phase,batchId:this.state.batchId,
      total:1199,requested:requests.length,
      clickDispatchCount:requests.filter(r=>Number(r.dispatchAt)>0).length,
      clickCount:requests.filter(r=>Number(r.clickConfirmedAt)>0).length,
      downloadStartedCount:rows.length,
      downloadCompletedCount:rows.filter(r=>r.state==="complete").length,
      downloadInterruptedCount:rows.filter(r=>r.state==="interrupted").length,
      timedOutCount:requests.filter(r=>Number(r.timedOutAt)>0).length,
      mismatchCount:rows.filter(r=>r.nameMismatch||r.pathMismatch).length,
      unmatchedDownloadCount:rows.filter(r=>!r.sourcePath).length,
      unresolvedCount:requests.filter(r=>["dispatched","clicked","downloading","click-unknown","timed_out"].includes(r.state)).length,
      bytesCompleted:rows.filter(r=>r.state==="complete").reduce((a,r)=>a+(r.bytes||0),0),
      migratedFrom:this.state.migratedFrom,
      lastEvents:this.state.audit.slice(-5)};
  }
  async report(){await this.ready;await this.serial;
    return {ok:true,...JSON.parse(JSON.stringify(this.state)),
      exportedAt:iso(),summary:this.summary(),
      note:"Names and full paths are recorded as received. Source attribution for delayed downloads is probabilistic; timeout is not a failure or permission to re-click."};
  }
}
root.RarRescueHarvestWorker=HarvestWorker;
})(globalThis);
