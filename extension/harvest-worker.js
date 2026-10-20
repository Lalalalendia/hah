/* Best-effort capture of files actually returned by Yandex.
 *
 * Crucial invariant: NEVER rename an unexpected server filename to the
 * viewer's requested filename. Store the browser-reported basename and
 * separately log source-path attribution as evidence, not verified identity.
 * Preserve known archive directory paths; no extra staging or unknown folders.
 */
(function(root){
"use strict";
const KEY="rr_harvest_v12"; // fresh scope so flat v0.11 records cannot hide hierarchy
const MAX_AGE_MS=60*60*1000;
const ACTIVE_ASSOCIATION_MS=5500; // tentative timing, not verified content identity
const SCHEMA="yandex-archive-raw-harvest-v2";
function basename(filename){
  return String(filename||"").replace(/\\/g,"/").split("/").pop().slice(0,220);
}
function validSource(name){
  return typeof name==="string" && !!name &&
    name.length<=200 && name!=="." && name!==".." &&
    !/[/\\\u0000-\u001f]/.test(name);
}
function sourceKey(folder,name){
  return (folder?folder+"/":"")+name;
}
function newState(){
  return {schema:SCHEMA,phase:"idle",batchId:null,tabId:null,createdAt:null,
    startedAt:0,tailDeadline:0,requests:{},downloads:{},lastClick:null,
    audit:[],sourcePathsCount:0};
}
class RawHarvest {
  constructor(api,utils){
    this.api=api;
    this.utils=utils;
    this.state=newState();
    this.ready=api.storage.local.get(KEY).then(result=>{
      const value=result?.[KEY];
      if(value?.schema===SCHEMA && value.requests && value.downloads)
        this.state=value;
    }).catch(()=>{});
    this.lock=Promise.resolve();
  }
  async transaction(callback){
    const operation=this.lock.then(async()=>{
      await this.ready;
      const answer=await callback();
      await this.api.storage.local.set({[KEY]:this.state});
      return answer;
    });
    this.lock=operation.catch(()=>{});
    return operation;
  }
  recording(now=Date.now()){
    const s=this.state;
    return s.phase==="collecting" || (s.phase==="tail" && now<s.tailDeadline);
  }
  sourceAllowed(item){
    if(!this.recording() || !item ||
       !this.utils.isDownloadHost(item.url||item.finalUrl||""))
      return false;
    // A document viewer's detached download can have a different tab ID.
    // Other Yandex services are not captured unless they are in our parent tab.
    if(Number.isInteger(item.tabId) && item.tabId>=0 &&
      item.tabId!==this.state.tabId){
      let host="";
      try{host=new URL(item.url||item.finalUrl||"").hostname;}catch(_){}
      if(!(/(^|\.)docviewer\./.test(host) ||
           /(^|\.)downloader\./.test(host)))return false;
    }
    return true;
  }
  audit(type,path,detail){
    this.state.audit.push({at:new Date().toISOString(),type,
      path:String(path||"").slice(0,400),detail:String(detail||"").slice(0,200)});
    if(this.state.audit.length>250)this.state.audit.splice(0,this.state.audit.length-250);
  }
  async begin(tabId,total){
    return this.transaction(()=>{
      if(!Number.isInteger(tabId) || tabId<0 || total!==1199)
        throw Error("Invalid archive scope");
      const s=this.state;
      if(s.phase==="collecting" && s.tabId!==tabId)
        throw Error("Another archive tab owns the active raw capture");
      if(!s.batchId){
        s.batchId="capture-"+new Date().toISOString().replace(/[^0-9]/g,"").slice(0,14);
        s.createdAt=new Date().toISOString();
      }
      s.phase="collecting";s.tabId=tabId;s.startedAt=Date.now();
      s.tailDeadline=0;s.sourcePathsCount=1199;
      this.audit("begin","","Raw Yandex names preserved; no content identity promises");
      return this.summarize();
    });
  }
  async stop(){
    return this.transaction(()=>{
      if(this.state.phase==="collecting"){
        this.state.phase="tail";
        this.state.tailDeadline=Date.now()+MAX_AGE_MS;
        this.audit("stop","","Late Yandex responses collected for another hour");
      }
      return this.summarize();
    });
  }
  async arm(folder,name){
    return this.transaction(()=>{
      if(this.state.phase!=="collecting")throw Error("Raw capture is not active");
      if(!validSource(name))throw Error("Invalid source basename");
      const destination=this.utils.relative(folder,name);
      const path=sourceKey(folder,name);
      if(!destination.endsWith("/"+this.utils.component(name)))
        throw Error("Invalid output path");
      if(this.state.requests[path])
        return {ok:true,skipped:true,reason:"Source was already attempted",path};
      this.state.requests[path]={
        sourcePath:path,folder,name,createdAt:Date.now(),clickedAt:0,
        state:"armed",assignedDownloadIds:[],observedNames:[],
        note:"Browser filenames must be recorded independently of viewer names"
      };
      this.audit("arm",path,"Source click reserved");
      return {ok:true,skipped:false,path};
    });
  }
  async sent(folder,name,clicked,reason){
    return this.transaction(()=>{
      const path=sourceKey(folder,name),entry=this.state.requests[path];
      if(!entry)throw Error("Raw capture source was never armed");
      if(clicked && entry.state!=="armed")
        throw Error("This source has already been clicked");
      if(clicked){
        entry.clickedAt=Date.now();
        entry.state="sent-unconfirmed";
        this.state.lastClick=path;
        this.audit("clicked",path,"Synthetic Yandex file-row action");
      }else{
        // A frame communication error does not prove the browser click failed.
        if(!entry.assignedDownloadIds.length){
          entry.state="click-unknown";
          entry.reason=String(reason||"Action not confirmed").slice(0,160);
        }
        this.audit("click-not-confirmed",path,String(reason||"unknown").slice(0,120));
      }
      return {ok:true,path,state:entry.state};
    });
  }
  choose(item){
    const now=Date.now();
    const reported=basename(item.filename);
    const recent=Object.values(this.state.requests)
      .filter(x=>x.clickedAt && !x.assignedDownloadIds.length &&
        now-x.clickedAt>=0 && now-x.clickedAt<MAX_AGE_MS);
    // When Yandex returns a different filename, associate tentatively
    // with the most recent click; clearly record uncertainty in the journal.
    const fresh=recent.filter(x=>now-x.clickedAt<=ACTIVE_ASSOCIATION_MS)
      .sort((a,b)=>b.clickedAt-a.clickedAt);
    if(fresh.length && (fresh.length===1 || fresh[0].clickedAt>fresh[1].clickedAt)){
      return {request:fresh[0],confidence:
        reported.toLowerCase()===fresh[0].name.toLowerCase()?
          "recent-click-name-match-unverified":"recent-click-name-mismatch-unverified"};
    }
    const exact=recent.filter(x=>
      reported && x.name.toLowerCase()===reported.toLowerCase());
    if(exact.length===1){
      return {request:exact[0],confidence:"delayed-name-match-unverified"};
    }
    return {request:null,confidence:recent.length?"ambiguous-delayed-response":"unattributed"};
  }
  async created(item){
    return this.transaction(()=>{
      if(!this.sourceAllowed(item))return false;
      const id=String(item.id);
      if(this.state.downloads[id])return true;
      this.state.downloads[id]={
        id:item.id,browserName:basename(item.filename),originalNameReported:!!basename(item.filename),
        sourcePath:null,matchConfidence:"pending-filename",
        state:item.state||"in_progress",createdAt:new Date().toISOString(),
        bytes:Number(item.bytesReceived)||0,
        browserTabMatched:item.tabId===this.state.tabId,
        outputRelative:null
      };
      return true;
    });
  }
  async determine(item){
    return this.transaction(()=>{
      if(!this.sourceAllowed(item))return {handled:false};
      const id=String(item.id);
      const observed=basename(item.filename);
      const safeName=this.utils.component(observed||"_unnamed_download_"+id+".bin");
      const existing=this.state.downloads[id];
      if(existing?.outputRelative){
        return {handled:true,filename:existing.outputRelative,conflictAction:"uniquify"};
      }
      const matched=this.choose(item);
      // Preserve original archive folder path but use the filename that
      // Yandex actually returned. Unattributed responses go to archive ROOT.
      const sourceParts=(matched.request?.folder||"").split("/").filter(Boolean);
      if(sourceParts.some(x=>x===".."))throw Error("Unsafe archive directory");
      const route=["Disk-2.rar",...sourceParts.map(this.utils.component),safeName].join("/");
      const record={
        ...(existing||{}),id:item.id,
        browserName:observed||"(browser did not report a name)",
        originalNameReported:!!observed,
        sourcePath:matched.request?.sourcePath||null,
        requestedName:matched.request?.name||null,
        sourceFolder:matched.request?.folder||null,
        nameMismatch:Boolean(matched.request && observed &&
          observed.toLowerCase()!==matched.request.name.toLowerCase()),
        matchConfidence:matched.confidence,
        state:item.state||"in_progress",createdAt:existing?.createdAt||new Date().toISOString(),
        bytes:Number(item.bytesReceived)||0,
        outputRelative:route,browserTabMatched:item.tabId===this.state.tabId
      };
      this.state.downloads[id]=record;
      if(matched.request){
        matched.request.assignedDownloadIds.push(item.id);
        matched.request.observedNames.push(observed||"(unknown)");
        matched.request.state=record.nameMismatch?"observed-different-name":"observed";
      }
      this.audit("browser-filename",matched.request?.sourcePath||"",
        (observed||"unknown")+" -> "+route);
      return {handled:true,filename:route,conflictAction:"uniquify"};
    });
  }
  async changed(id,item){
    return this.transaction(()=>{
      const record=this.state.downloads[String(id)];
      if(!record)return false;
      const state=item?.state||record.state;
      record.state=state;
      record.bytes=Number(item?.bytesReceived)||0;
      record.totalBytes=Number(item?.totalBytes)||0;
      record.completedAt=state==="complete"||state==="interrupted"?
        new Date().toISOString():null;
      // Record an archive-relative path without exposing a local OS path.
      const full=String(item?.filename||"").replace(/\\/g,"/");
      const marker="/Disk-2.rar/";
      const markerAt=full.toLowerCase().lastIndexOf(marker.toLowerCase());
      record.actualOutputRelative=markerAt>=0 ?
        full.slice(markerAt+1,markerAt+1+1300) :
        basename(item?.filename)||"(unknown)";
      record.actualBrowserName=basename(item?.filename)||record.browserName;
      record.exists=item?.exists!==false;
      if(state==="interrupted")record.error=String(item?.error||"interrupted").slice(0,100);
      if(record.sourcePath){
        const request=this.state.requests[record.sourcePath];
        if(request){
          if(state==="complete"){
            request.state=record.nameMismatch?"captured-different-name":"captured";
            request.bytes=record.bytes;
          }else if(state==="interrupted"){
            request.state="interrupted";
          }
        }
      }
      this.audit("transfer-"+state,record.sourcePath||"",
        record.browserName+" "+record.bytes+" bytes");
      return true;
    });
  }
  async status(){await this.ready;await this.lock;return this.summarize();}
  summarize(){
    const req=Object.values(this.state.requests);
    const got=Object.values(this.state.downloads);
    return {ok:true,phase:this.state.phase,batchId:this.state.batchId,
      requested:req.length,completed:got.filter(x=>x.state==="complete").length,
      differentNames:got.filter(x=>x.nameMismatch).length,
      unattributed:got.filter(x=>!x.sourcePath).length,
      unresolved:req.filter(x=>["armed","sent-unconfirmed","observed","observed-different-name"].includes(x.state)).length,
      failedClicks:req.filter(x=>x.state==="click-failed").length,
      bytes:got.filter(x=>x.state==="complete").reduce((n,x)=>n+(x.bytes||0),0),
      lastEvents:this.state.audit.slice(-8)};
  }
  async report(){await this.ready;await this.lock;return {ok:true,schema:SCHEMA,
    ...this.state,summary:this.summarize(),exportedAt:new Date().toISOString(),
    disclaimer:"File source associations based on timing or filenames are hypotheses, not verified content identities."};}
}
root.RarRescueHarvestWorker=RawHarvest;
})(globalThis);
