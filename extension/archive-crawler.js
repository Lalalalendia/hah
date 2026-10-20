/* Iterative, fail-closed RAR directory traversal.
 * Walks the native Yandex viewer UI, not the broken full-RAR download endpoint.
 * Never reads network credentials, signed URLs, or file contents.
 */
(function(root) {
  "use strict";

  class ArchiveCrawler {
    constructor(doc, dom, config = {}) {
      this.doc=doc;
      this.dom=dom;
      this.delay=config.delay || (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
      this.maxDepth=32;
      this.maxObjects=100000;
      this.maxScrollSteps=400;
      this.frames=[];
      this.halted=false;
      this.seenPaths=new Set();
      this.objectCount=0;
    }

    currentRows() { return this.dom.archiveRows(this.doc); }

    snapshot() {
      return this.currentRows().map(row=>row.getAttribute("title")||"")
        .filter(Boolean).sort().join("\n");
    }

    async enumerate() {
      const doc=this.doc;
      const dom=this.dom;
      let rows=this.currentRows();
      const scroller=dom.scrollerOf(rows[0],doc);
      const items=new Map();
      const duplicates=new Set();
      let complete=true;
      let positions=0;
      if(scroller) {scroller.scrollTop=0;await this.delay(120);}
      for(let step=0;step<this.maxScrollSteps;step++){
        rows=this.currentRows();
        const namesInViewport=new Set();
        for(const row of rows) {
          const info=dom.itemOf(row);
          if(!info.name)continue;
          if(!/^[^\u0000-\u001f/\\]{1,200}$/.test(info.name))
            return {ok:false,error:"unsafe-entry-name"};
          if(namesInViewport.has(info.name))duplicates.add(info.name);
          namesInViewport.add(info.name);
          if(items.has(info.name)) {
            const prior=items.get(info.name);
            if(prior.kind!==info.kind) duplicates.add(info.name);
            // A duplicated same-name entry within the same viewport is also
            // suspect, but repeated virtualized renderings are not duplicates.
          } else items.set(info.name,{
            name:info.name,kind:info.kind,iconClasses:info.iconClasses,
            hasActionBar:info.hasActionBar
          });
        }
        if(!scroller)break;
        if(scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-4)break;
        const old=scroller.scrollTop;
        scroller.scrollTop=Math.min(scroller.scrollHeight,old+Math.max(80,Math.floor(scroller.clientHeight*.72)));
        positions++;
        await this.delay(100);
        if(scroller.scrollTop===old){complete=false;break;}
        if(step===this.maxScrollSteps-1)complete=false;
      }
      if(scroller) {scroller.scrollTop=0;await this.delay(130);}
      const list=[...items.values()];
      return {ok:true,items:list,complete,scrollSteps:positions,duplicates:[...duplicates]};
    }

    pathOf(parent,child) {
      if(child==="." || child===".." || child.includes("/") || child.includes("\\") || !child)
        throw new Error("unsafe-folder-name");
      const path=(parent ? parent+"/" : "")+child;
      if(path.split("/").length>this.maxDepth)throw new Error("maximum-depth-exceeded");
      return path;
    }

    push(path,collection){
      if(!collection.ok || !collection.complete)throw new Error(collection.error || "incomplete-directory-inventory");
      if(this.seenPaths.has(path))throw new Error("directory-cycle-or-duplicate");
      const entries=collection.items;
      if(this.objectCount+entries.length>this.maxObjects)throw new Error("maximum-object-count-exceeded");
      this.objectCount+=entries.length;
      this.seenPaths.add(path);
      const folders=entries.filter(item=>item.kind==="folder").map(x=>x.name);
      const frame={path,entries,folders,index:0,
        signature:entries.map(x=>x.name).sort().join("\n")};
      this.frames.push(frame);
      return {ok:true,event:"directory",path,
        items:entries,duplicates:collection.duplicates,
        scrollSteps:collection.scrollSteps,depth:this.frames.length-1,
        discoveredObjects:this.objectCount};
    }

    async begin(expectedArchiveName=null) {
      this.frames=[];this.halted=false;this.seenPaths.clear();this.objectCount=0;
      // Verify viewer identity, never infer the root from expected member names.
      const header=this.doc.querySelector('[class*="archiveHeader_"]');
      if(expectedArchiveName){
        const label=header?.querySelector("strong")?.textContent?.trim();
        if(!header || (label && label.normalize("NFC")!==expectedArchiveName.normalize("NFC")))
          return {ok:false,error:"archive-viewer-identity-not-confirmed"};
      }
      // Some viewer versions expose a navigational path; when present, it is
      // evidence that the user is inside a folder rather than at the root.
      const pathHint=header?.getAttribute("data-archive-path");
      if(pathHint && pathHint!=="/" && pathHint!==".")
        return {ok:false,error:"not-at-archive-root"};
      const collection=await this.enumerate();
      if(!collection.ok || !collection.complete)
        return {ok:false,error:collection.error || "cannot-read-full-root-list"};
      try{return this.push("",collection);}
      catch(error){this.halted=true;return {ok:false,error:error.message};}
    }

    async locate(name,expectedKind) {
      const doc=this.doc;
      let row=this.currentRows().find(x=>x.getAttribute("title")===name && this.dom.kindOf(x)===expectedKind);
      if(row)return row;
      const rows=this.currentRows();
      const scroller=this.dom.scrollerOf(rows[0],doc);
      if(!scroller)return null;
      scroller.scrollTop=0;await this.delay(120);
      for(let i=0;i<this.maxScrollSteps;i++){
        row=this.currentRows().find(x=>x.getAttribute("title")===name && this.dom.kindOf(x)===expectedKind);
        if(row)return row;
        const atEnd=scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-4;
        if(atEnd)break;
        const old=scroller.scrollTop;
        scroller.scrollTop=Math.min(scroller.scrollHeight,old+Math.max(80,Math.floor(scroller.clientHeight*.75)));
        await this.delay(95);
        if(scroller.scrollTop===old)break;
      }
      return null;
    }

    async waitForChange(previous,timeout=8500) {
      const start=Date.now();
      while(Date.now()-start<timeout){
        await this.delay(170);
        if(this.snapshot()!==previous) {
          await this.delay(240);
          return true;
        }
      }
      return false;
    }

    backButton() {
      const header=this.doc.querySelector('[class*="archiveHeader_"]');
      if(!header)return null;
      const arrow=header.querySelector('button[class*="backArrow_"],[class*="backArrow_"] button');
      if(arrow)return arrow;
      const buttons=Array.from(header.querySelectorAll("button"));
      const named=buttons.filter(button=>/назад|back/i.test(
        (button.getAttribute("aria-label")||"")+" "+(button.getAttribute("title")||"")));
      return named.length===1 ? named[0] : null;
    }

    async step() {
      if(this.halted)return {ok:false,error:"crawler-halted"};
      if(!this.frames.length)return {ok:false,error:"crawler-not-initialized"};
      const here=this.frames[this.frames.length-1];
      if(here.index<here.folders.length) {
        const name=here.folders[here.index];
        const path=this.pathOf(here.path,name);
        if(this.frames.length>=this.maxDepth) {
          this.halted=true;return {ok:false,error:"maximum-depth-exceeded",path};
        }
        const row=await this.locate(name,"folder");
        if(!row){
          this.halted=true;return {ok:false,error:"folder-row-not-visible",path};
        }
        const old=this.snapshot();
        const target=row.querySelector('[class*="resourceItemName_"]') || row;
        target.click();
        const changed=await this.waitForChange(old);
        if(!changed){
          this.halted=true;return {ok:false,error:"folder-navigation-not-confirmed",path};
        }
        const collection=await this.enumerate();
        if(!collection.ok || !collection.complete){
          this.halted=true;return {ok:false,error:"folder-list-incomplete",path};
        }
        here.index++;
        try{return this.push(path,collection);}
        catch(error){this.halted=true;return {ok:false,error:error.message,path};}
      }
      if(this.frames.length===1)return {ok:true,event:"complete",
        paths:this.seenPaths.size,objects:this.objectCount};
      const child=this.frames[this.frames.length-1];
      const parent=this.frames[this.frames.length-2];
      const back=this.backButton();
      if(!back){
        this.halted=true;return {ok:false,error:"back-control-not-found",path:child.path};
      }
      const old=this.snapshot();
      back.click();
      const changed=await this.waitForChange(old);
      if(!changed){
        this.halted=true;return {ok:false,error:"back-navigation-not-confirmed",path:child.path};
      }
      const restored=await this.enumerate();
      if(!restored.ok || !restored.complete ||
         !restored.items.some(x=>x.kind==="folder" && x.name===child.path.split("/").pop())){
        this.halted=true;return {ok:false,error:"parent-directory-mismatch",path:parent.path};
      }
      const restoredNames=restored.items.map(x=>x.name).sort().join("\n");
      if(restoredNames!==parent.signature){
        this.halted=true;return {ok:false,error:"parent-inventory-changed",path:parent.path};
      }
      this.frames.pop();
      return {ok:true,event:"returned",path:parent.path,depth:this.frames.length-1};
    }
  }

  root.RarRescueCrawler=ArchiveCrawler;
})(globalThis);
