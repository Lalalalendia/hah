/* Verified navigation to known archive directories without enumerating
 * unrelated branches. Inventory crawler remains available separately.
 * One viewer frame owns one navigator and a checked current path.
 */
(function(root) {
"use strict";
class ArchiveNavigator {
  constructor(doc,dom,crawler){
    this.doc=doc;
    this.dom=dom;
    this.crawler=crawler;
    this.manifest=null;
    this.currentPath=null;
    this.halted=false;
    this.entered=0;
    this.backed=0;
    this.verified=0;
  }
  static parts(path){
    if(typeof path!=="string" || path.length>2400)return null;
    if(!path)return [];
    const parts=path.split("/");
    if(parts.length>32 || parts.some(p=>!p || p==="." || p===".." ||
       p.length>200 || /[/\\\u0000-\u001f]/.test(p)))return null;
    return parts;
  }
  normalized(items){
    return items.map(e=>e.kind+"|"+e.name).sort().join("\n");
  }
  status(){
    return {ok:!this.halted,initialized:!!this.manifest,path:this.currentPath,
      entered:this.entered,backed:this.backed,verified:this.verified,halted:this.halted};
  }
  isAt(path){
    return !this.halted && !!this.manifest && this.currentPath===path;
  }
  check(path,collected){
    const dir=this.manifest?.get(path);
    if(!dir)throw new Error("Folder is absent from verified manifest: "+path);
    if(!collected?.ok || !collected.complete || (collected.duplicates||[]).length)
      throw new Error("Cannot verify complete folder listing: "+path);
    if(this.normalized(collected.items)!==this.normalized(dir))
      throw new Error("Folder contents differ from saved manifest: "+path);
    this.verified++;
    return true;
  }
  async start(directories,expectedArchiveName=null){
    this.manifest=null;
    this.currentPath=null;
    this.halted=false;
    this.entered=0;
    this.backed=0;
    this.verified=0;
    try{
      if(!Array.isArray(directories) || directories.length<1 || directories.length>100000)
        throw new Error("Archive directory manifest is empty or too large");
      const registry=new Map();
      for(const directory of directories){
        const path=directory?.path, parts=ArchiveNavigator.parts(path);
        if(!parts || registry.has(path) || !Array.isArray(directory.entries) ||
           directory.entries.length>100000)throw new Error("Invalid directory manifest");
        const entries=[];
        const names=new Set();
        for(const entry of directory.entries){
          if(!entry || !["file","folder"].includes(entry.kind) ||
             ArchiveNavigator.parts(entry.name)?.length!==1 ||
             names.has(entry.name.toLowerCase()))
            throw new Error("Invalid directory entry: "+path);
          names.add(entry.name.toLowerCase());
          entries.push({name:entry.name,kind:entry.kind});
        }
        registry.set(path,entries);
      }
      if(!registry.has(""))throw new Error("Missing archive root");
      for(const [path,items] of registry.entries()){
        if(path){
          const segments=ArchiveNavigator.parts(path);
          const parent=segments.slice(0,-1).join("/");
          if(!registry.get(parent)?.some(e=>e.kind==="folder"&&e.name===segments.at(-1)))
            throw new Error("Missing parent folder reference: "+path);
        }
        for(const item of items){
          if(item.kind==="folder"){
            const sub=(path?path+"/":"")+item.name;
            if(!registry.has(sub))throw new Error("Unindexed folder: "+sub);
          }
        }
      }
      this.manifest=registry;
      // Verify only the root; never descend into unrelated directories again.
      const rootResult=await this.crawler.begin(expectedArchiveName);
      if(!rootResult.ok || rootResult.event!=="directory" || rootResult.path!=="")
        throw new Error(rootResult.error||"Archive root could not be confirmed");
      this.check("",{ok:true,complete:true,items:rootResult.items,
        duplicates:rootResult.duplicates||[]});
      this.currentPath="";
      return this.status();
    }catch(error){
      this.halted=true;
      this.currentPath=null;
      this.manifest=null;
      return {ok:false,error:String(error.message||error).slice(0,200)};
    }
  }
  async enter(parent,child){
    const dest=(parent?parent+"/":"")+child;
    if(!this.manifest?.get(parent)?.some(x=>x.kind==="folder"&&x.name===child) ||
       !this.manifest.has(dest))throw new Error("Unknown manifest folder: "+dest);
    const row=await this.crawler.locate(child,"folder");
    if(!row)throw new Error("Folder entry not found in viewer: "+dest);
    const before=this.crawler.snapshot();
    const clickable=row.querySelector('[class*="resourceItemName_"]')||row;
    clickable.click();
    if(!await this.crawler.waitForChange(before))
      throw new Error("Cannot confirm entry into: "+dest);
    const listing=await this.crawler.enumerate();
    this.check(dest,listing);
    this.currentPath=dest;
    this.entered++;
  }
  async leave(child){
    const path=ArchiveNavigator.parts(child);
    if(!path?.length)throw new Error("Cannot move above root");
    const parent=path.slice(0,-1).join("/");
    const back=this.crawler.backButton();
    if(!back)throw new Error("Viewer has no supported back button");
    const before=this.crawler.snapshot();
    back.click();
    if(!await this.crawler.waitForChange(before))
      throw new Error("Cannot confirm return to: "+parent);
    const listing=await this.crawler.enumerate();
    this.check(parent,listing);
    this.currentPath=parent;
    this.backed++;
  }
  async go(target){
    if(this.halted || !this.manifest || this.currentPath==null)
      return {ok:false,error:"Navigator has not verified archive root"};
    const next=ArchiveNavigator.parts(target);
    if(!next || !this.manifest.has(target))
      return {ok:false,error:"Requested path is not a known archive directory"};
    try{
      const current=ArchiveNavigator.parts(this.currentPath);
      let shared=0;
      while(shared<current.length && shared<next.length &&
        current[shared]===next[shared])shared++;
      for(let k=current.length;k>shared;k--)await this.leave(this.currentPath);
      for(let k=shared;k<next.length;k++)
        await this.enter(this.currentPath,next[k]);
      // Do not roam if the destination is already known. The only
      // directory validation occurred when navigating into it.
      return this.status();
    }catch(error){
      this.halted=true;
      return {ok:false,error:String(error.message||error).slice(0,200),
        expected:target,lastVerified:this.currentPath};
    }
  }
}
root.RarRescueNavigator=ArchiveNavigator;
})(globalThis);
