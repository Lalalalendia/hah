/* Route Yandex browser downloads to their original archive capture.
 * Never classify a detached download into a second archive while there
 * are multiple plausible live or tail captures.
 */
(function(root){
"use strict";
const REGISTRY_KEY="rr_active_scopes_v16";
const PREVIOUS_KEY="rr_active_archive_v15";
const QUARANTINE_KEY="rr_ambiguous_downloads_v16";
const MAX_ARCHIVES=64;
class HarvestRouter {
  constructor(api,utils,scopeApi,Worker){
    this.api=api;this.utils=utils;this.scopeApi=scopeApi;this.Worker=Worker;
    this.legacy=new Worker(api,utils);
    this.workers=new Map();
    this.ready=this.restore();
  }
  canonical(raw){
    if(!raw || typeof raw.archiveName!=="string" ||
       typeof raw.sourceKey!=="string" ||
       !/^yandex-public:\/d\/[A-Za-z0-9_-]{1,150}$/.test(raw.sourceKey))
      return null;
    try{
      const url="https://disk.yandex.ru"+
        raw.sourceKey.slice("yandex-public:".length);
      const scope=this.scopeApi.fromYandexPublicLink(url,raw.archiveName);
      return scope.scopeId===raw.scopeId?scope:null;
    }catch(_){return null;}
  }
  async restore(){
    // Separate gets also work with minimal extension/CI storage mocks.
    const current=(await this.api.storage.local.get(REGISTRY_KEY))[REGISTRY_KEY];
    const previous=(await this.api.storage.local.get(PREVIOUS_KEY))[PREVIOUS_KEY];
    const list=[...(Array.isArray(current)?current:[]),previous].filter(Boolean);
    for(const item of list.slice(-MAX_ARCHIVES)){
      const scope=this.canonical(item);
      if(!scope||this.workers.has(scope.scopeId))continue;
      const worker=new this.Worker(this.api,this.utils,scope);
      await worker.ready;
      // A tab ID from an earlier browser session is not ownership evidence.
      // If Chrome cannot confirm the original tab, retain its work in tail
      // state but do not keep the old capture collecting indefinitely.
      if(worker.recording()&&typeof this.api.tabs?.get==="function"){
        let valid=false;
        try{
          const tab=await this.api.tabs.get(worker.state.tabId);
          const url=new URL(String(tab?.url||""));
          valid=url.protocol==="https:"&&url.hostname==="disk.yandex.ru"&&
            "yandex-public:"+url.pathname.replace(/\/$/,"")===scope.sourceKey;
        }catch(_){}
        if(!valid){
          worker.invalidTab=true;
          if(worker.state.phase==="collecting")await worker.stop();
        }
      }
      this.workers.set(scope.scopeId,worker);
    }
  }
  async bind(sender,raw){
    await this.ready;
    if(!raw)return this.forSender(sender);
    const scope=this.canonical(raw);
    if(!scope)throw Error("Invalid archive identity");
    const url=String(sender?.tab?.url||"");
    const actual=this.scopeApi.fromYandexPublicLink(url,scope.archiveName);
    if(actual.scopeId!==scope.scopeId)
      throw Error("Archive identity does not match the current tab");
    let worker=this.workers.get(scope.scopeId);
    if(worker)return worker;
    if(this.workers.size>=MAX_ARCHIVES)
      throw Error("Too many stored archive sessions; export logs before starting more");
    worker=new this.Worker(this.api,this.utils,scope);
    await worker.ready;
    this.workers.set(scope.scopeId,worker);
    const scopes=[...this.workers.values()].map(w=>w.scope);
    await this.api.storage.local.set({[REGISTRY_KEY]:scopes});
    return worker;
  }
  forSender(sender){
    const url=new URL(String(sender?.tab?.url||""));
    if(url.protocol!=="https:"||url.hostname!=="disk.yandex.ru")
      throw Error("Not a Yandex public archive tab");
    const sourceKey="yandex-public:"+url.pathname.replace(/\/$/,"");
    const candidates=[...this.workers.values()].filter(w=>
      w.scope.sourceKey===sourceKey);
    if(candidates.length>1)throw Error("Ambiguous archive names at this public link");
    if(candidates.length===1)return candidates[0];
    // Keep the pre-v15 fixture and old strict UI accessible on the original
    // link, without ever reusing its global capture for arbitrary archives.
    if(this.workers.size===0&&sourceKey==="yandex-public:/d/_RSlWomRWmty1w")
      return this.legacy;
    throw Error("Start this archive with its own verified scope");
  }
  async start(sender,raw,total){
    const worker=await this.bind(sender,raw);
    if(worker.scope){
      for(const old of this.workers.values()){
        if(old===worker)continue;
        if(old.state.tabId===sender.tab.id&&old.recording()&&
           old.summary().unresolvedCount>0)
          throw Error("Previous archive has pending downloads in this tab; use a separate tab");
        if(old.state.tabId===sender.tab.id&&old.state.phase==="collecting"){
          old.invalidTab=true;
          await old.stop();
        }
      }
    }
    // A prior tab ID is no longer an ownership witness after the operator
    // explicitly starts a new capture bound to a verified public link.
    worker.invalidTab=false;
    return worker.begin(sender.tab.id,total);
  }
  async forEvent(item){
    await this.ready;
    if(!item||!this.utils.isDownloadHost(item.url||item.finalUrl||""))
      return null;
    const id=String(item.id);
    const all=[...this.workers.values()];
    const owned=all.filter(w=>Object.prototype.hasOwnProperty.call(w.state.downloads,id));
    if(owned.length===1)return owned[0];
    if(owned.length>1)return null;
    if(this.legacy.state.downloads[id])return this.legacy;
    // A provider hostname or tab ID alone does not identify a browser
    // download as belonging to this extension. Require at least one click
    // dispatch without an assigned download ID; otherwise Chrome keeps its
    // own default filename and we record the event as unattributed.
    const now=Date.now();
    const hasUnassignedClick=w=>Object.values(w.state.requests).some(r=>
      Number(r.dispatchAt)>0&&(!r.downloadIds||r.downloadIds.length===0)&&
      now-Number(r.dispatchAt)>=-2000&&now-Number(r.dispatchAt)<=60*60*1000);
    const active=all.filter(w=>!w.invalidTab&&w.recording()&&w.sourceAllowed(item)&&
      hasUnassignedClick(w));
    const sameTab=active.filter(w=>w.state.tabId===item.tabId);
    if(sameTab.length===1)return sameTab[0];
    if(sameTab.length>1)return null;
    // A download from another known archive/tab cannot be relabelled as
    // belonging to the currently active tab, even if the host is identical.
    const knownOther=all.some(w=>w.state.tabId===item.tabId);
    if(knownOther)return null;
    if(active.length===1)return active[0]; // detached Yandex download, one candidate
    if(active.length===0&&this.workers.size===0&&this.legacy.sourceAllowed(item))
      return this.legacy;
    return null;
  }
  async quarantine(item,reason){
    if(!this.utils.isDownloadHost(item?.url||item?.finalUrl||""))return;
    const data=await this.api.storage.local.get(QUARANTINE_KEY);
    const rows=Array.isArray(data[QUARANTINE_KEY])?data[QUARANTINE_KEY]:[];
    if(rows.some(row=>row.id===item.id))return;
    rows.push({id:item.id,at:new Date().toISOString(),
      tabId:Number.isInteger(item.tabId)?item.tabId:null,
      name:String(item.filename||"").replace(/\\/g,"/").split("/").pop().slice(0,220),
      reason});
    if(rows.length>300)rows.splice(0,rows.length-300);
    await this.api.storage.local.set({[QUARANTINE_KEY]:rows});
  }
  hasLiveScopes(){
    return [...this.workers.values()].some(worker=>worker.recording());
  }
  async created(item){
    const worker=await this.forEvent(item);
    if(!worker){
      // Do not log unrelated Yandex downloads when every archive session
      // has finished its capture and late-event tail.
      if(this.hasLiveScopes())await this.quarantine(item,"no-unambiguous-archive-owner");
      return false;
    }
    return worker.created(item);
  }
  async determine(item){
    const worker=await this.forEvent(item);
    if(!worker){
      if(this.hasLiveScopes())await this.quarantine(item,"filename-not-owned");
      return {handled:false};
    }
    return worker.determine(item);
  }
  async changed(id,item){
    await this.ready;
    const owners=[...this.workers.values(),this.legacy].filter(w=>
      Object.prototype.hasOwnProperty.call(w.state.downloads,String(id)));
    if(owners.length===1)return owners[0].changed(id,item);
    if(owners.length>1)return false;
    const data=await this.api.storage.local.get(QUARANTINE_KEY);
    const rows=Array.isArray(data[QUARANTINE_KEY])?data[QUARANTINE_KEY]:[];
    const entry=rows.find(row=>row.id===id);
    if(!entry)return false;
    entry.state=String(item?.state||"unknown");
    entry.bytes=Number(item?.bytesReceived)||0;
    entry.actualSavedFullPath=String(item?.filename||"");
    entry.error=String(item?.error||"").slice(0,160);
    await this.api.storage.local.set({[QUARANTINE_KEY]:rows});
    return true;
  }
  async report(sender,raw){
    const worker=await this.bind(sender,raw);
    const result=await worker.report();
    const data=await this.api.storage.local.get(QUARANTINE_KEY);
    return {...result,unattributedBrowserDownloads:Array.isArray(data[QUARANTINE_KEY])
      ?data[QUARANTINE_KEY].slice(-300):[]};
  }
  recording(){return [...this.workers.values(),this.legacy].some(w=>w.recording());}
  async removedTab(tabId){
    await this.ready;
    for(const worker of this.workers.values()){
      if(worker.state.tabId===tabId){
        worker.invalidTab=true;
        if(worker.state.phase==="collecting")
          await worker.stop(); // Existing download IDs remain bound to this worker.
      }
    }
  }
}
root.RarRescueHarvestRouter=HarvestRouter;
})(globalThis);
