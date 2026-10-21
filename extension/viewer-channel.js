/* Restore a missing MV3 sensor in a replaced Yandex archive iframe.
 * Only read/start commands may be reissued after a disconnection.
 * Download clicks or navigation steps MUST NOT be replayed blindly.
 */
(function(root){
"use strict";
const RECOVERABLE=new Set(["RR_SENSOR_LIST","RR_SENSOR_CRAWL_BEGIN","RR_SENSOR_CRAWL_STATUS","RR_SENSOR_NAV_STATUS"]);
const SENSOR_FILES=["archive-dom.js","archive-crawler.js","archive-navigator.js","frame-sensor.js"];
function disconnected(error){
  const message=String(error?.message||error||"");
  return /Receiving end does not exist|Could not establish connection|No frame with id|frame was removed/i.test(message);
}
class ViewerChannel{
  constructor(api){this.api=api;}
  async invoke(tabId,requestedFrameId,payload){
    try{
      const result=await this.api.tabs.sendMessage(tabId,payload,{frameId:requestedFrameId});
      if(result&&typeof result==="object")
        return {result,frameId:requestedFrameId,reconnected:false};
      if(!RECOVERABLE.has(payload.kind))
        throw Error("Viewer stopped responding during an operation; no automatic replay");
    }catch(error){
      if(!disconnected(error)||!RECOVERABLE.has(payload.kind)){
        if(disconnected(error))
          throw Error("Archive viewer was replaced during the operation. No click was repeated. Restart the scan from the RAR root.");
        throw error;
      }
    }
    if(!this.api.scripting?.executeScript)
      throw Error("Viewer is disconnected and script recovery is unavailable");
    const frames=await this.api.scripting.executeScript({
      target:{tabId,allFrames:true},
      func:()=>{
        const header=document.querySelector('[class*="archiveHeader_"]');
        const rows=document.querySelectorAll('[title][class*="resourceItem_"]');
        return {hasViewer:Boolean(header&&(document.querySelector('[class*="archive_"]')||rows.length)),
          visibleRows:rows.length,
          title:String(header?.querySelector("strong")?.textContent||"").trim().slice(0,160)};
      }
    });
    const candidates=(frames||[]).filter(x=>
      Number.isInteger(x.frameId)&&x.result?.hasViewer);
    const expected=String(payload.archiveName||"").normalize("NFC").trim();
    const titled=expected?candidates.filter(x=>
      String(x.result.title||"").normalize("NFC")===expected):candidates;
    const options=titled.length?titled:candidates;
    if(expected&&!titled.length&&candidates.some(x=>x.result.title))
      throw Error("Viewer frame title changed; refusing to mix two archives");
    const same=options.find(x=>x.frameId===requestedFrameId);
    const chosen=same||(options.length===1?options[0]:null);
    if(!chosen)
      throw Error(options.length?"Several archive viewer frames found; refresh the selected RAR tab":
        "Archive viewer frame is not currently available; reopen the RAR preview");
    await this.api.scripting.executeScript({
      target:{tabId,frameIds:[chosen.frameId]},files:SENSOR_FILES
    });
    try{
      const result=await this.api.tabs.sendMessage(tabId,payload,{frameId:chosen.frameId});
      if(!result||typeof result!=="object")throw Error("Viewer did not respond after sensor restoration");
      return {result,frameId:chosen.frameId,reconnected:true};
    }catch(error){
      throw Error("Archive viewer disconnected again during reconnect; reload the RAR preview: "+
        String(error?.message||error).slice(0,130));
    }
  }
}
root.RarRescueViewerChannel=ViewerChannel;
})(globalThis);
