const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const source=fs.readFileSync(path.resolve(__dirname,"../archive-dom.js"),"utf8");
const sandbox={};
sandbox.globalThis=sandbox;
vm.runInNewContext(source,sandbox);
const dom=sandbox.RarRescueDOM;
let clicks=[];
function control(label,id) {
  return {
    textContent:"",
    getAttribute(attr){return attr==="aria-label"?label:null;},
    closest(){return null;},
    hasAttribute(){return false;},
    contains(other){return other===this;},
    click(){clicks.push(id);}
  };
}
const eye=control("Просмотреть","preview");
const down=control(null,"download");
const bar={
  children:[eye,down],
  querySelectorAll(selector){assert(selector.includes("button"));return [eye,down];}
};
function mockRow(name,icon,action=bar) {
  return {
    tagName:"DIV",
    getAttribute(attr){return attr==="title"?name:null;},
    closest(selector){return selector.includes("listing_")?{}:null;},
    querySelector(selector) {
      if(selector.includes('actionBar_'))return action;
      if(selector.includes('file-icon'))return icon==="file"?{}:null;
      if(selector.includes('folder-icon'))return icon==="folder"?{}:null;
      return null;
    }
  };
}
const folder=mockRow("JRE","folder");
const readme=mockRow("README.TXT","file");
const cd=mockRow("CDVIEWER.EXE","file");
const evil={...mockRow("Delete all", "unknown"),getAttribute(){return "Bad/Path";}};
const doc={querySelectorAll(selector) {
  assert(selector.includes('[title]'));
  return [folder,readme,cd,evil];
}};
assert.equal(dom.archiveRows(doc).length,3);
assert.equal(dom.kindOf(folder),"folder");
assert.equal(dom.kindOf(readme),"file");
assert.equal(dom.rowNamed(doc,"README.TXT"),readme);
assert.equal(dom.rowNamed(doc,"JRE"),undefined);
assert.equal(dom.itemOf(readme).name,"README.TXT");
assert.equal(dom.itemOf(readme).actionCount,2);
assert.equal(dom.actionOf(readme,false).error,"download-button-not-labeled");
const pilot=dom.actionOf(readme,true);
assert.equal(pilot.mode,"last-control");
assert.equal(pilot.slotCount,2);
pilot.element.click();
assert.deepEqual(clicks,["download"]);
const explicit=mockRow("INDEX.HTM","file",{
  children:[eye,control("Скачать","named-download")],
  querySelectorAll(){return [eye,this.children[1]];}
});
const a=dom.actionOf(explicit,false);
assert.equal(a.mode,"label");
a.element.click();
assert.deepEqual(clicks,["download","named-download"]);
assert.equal(dom.actionOf(folder,true).mode,"last-control"); // folder is filtered before click by caller
console.log("OK: screenshot-shaped archive DOM, title lookup and last action pilot");
