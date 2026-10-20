#!/usr/bin/env python3
"""Real Chromium simulation of a 518-file virtualized Yandex archive list.

The viewer may stop refreshing DOM rows after a long download wait. We test
a missing-row failure and manual directory re-entry without any file clicks.
This synthetic model cannot prove the behavior of the live Yandex website.
"""
from pathlib import Path
from urllib.parse import quote
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

ROOT=Path(__file__).resolve().parents[1]/"extension"
PAGE="""<!doctype html><html><head><meta charset="utf-8">
<style>
#list{height:330px;max-height:330px;width:420px;overflow-y:auto;border:1px solid gray}
#spacer{position:relative;width:410px}
.resourceItem_test{position:absolute;height:24px;width:400px;left:0;box-sizing:border-box}
</style></head><body>
<div class="archive_test">
 <div class="archiveHeader_test"><button id="back" class="backArrow_test">Назад</button></div>
 <div class="listing_test" id="list"><div id="spacer"></div></div>
</div>
<script>
const HEIGHT=24,COUNT=518;
const view=document.getElementById("list"),spacer=document.getElementById("spacer");
window.path="";window.stalled=false;window.clickedFiles=[];window.entries=[];
function row(name,kind,index){
 const element=document.createElement("div");
 element.setAttribute("title",name);element.className="resourceItem_test";
 element.style.top=(index*HEIGHT)+"px";
 const icon=document.createElement("span");
 icon.className="file-icon file-icon_"+(kind==="folder"?"dir":"text");
 element.append(icon);
 const label=document.createElement("span");
 label.className="resourceItemName_test";label.textContent=name;element.append(label);
 const bar=document.createElement("div");bar.className="actionBar_test";
 const button=document.createElement("button");
 button.setAttribute("aria-label","Скачать");
 button.onclick=(event)=>{event.stopPropagation();window.clickedFiles.push(name);};
 bar.append(button);element.append(bar);
 if(kind==="folder")element.onclick=()=>window.enterImages();
 return element;
}
function renderVisible(){
 if(window.stalled)return;
 spacer.replaceChildren();
 if(window.path===""){
   view.style.overflowY="hidden";spacer.style.height="72px";
   spacer.append(row("README.TXT","file",0),row("INDEX.HTM","file",1),
     row("IMAGES","folder",2));
   return;
 }
 view.style.overflowY="auto";spacer.style.height=(COUNT*HEIGHT)+"px";
 const first=Math.max(0,Math.floor(view.scrollTop/HEIGHT));
 for(let i=first;i<Math.min(COUNT,first+20);i++){
   spacer.append(row("image"+String(i+1).padStart(5,"0")+".jpg","file",i));
 }
}
window.enterImages=()=>{
 window.path="IMAGES";window.stalled=false;view.scrollTop=0;
 window.entries.push("enter:IMAGES");renderVisible();
};
window.back=()=>{
 window.path="";window.stalled=false;view.scrollTop=0;
 window.entries.push("back:IMAGES");renderVisible();
};
document.getElementById("back").onclick=()=>window.back();
view.addEventListener("scroll",()=>renderVisible());
renderVisible();
</script></body></html>"""
opts=Options()
opts.add_argument("--headless=new")
opts.add_argument("--no-sandbox")
opts.add_argument("--disable-dev-shm-usage")
driver=webdriver.Chrome(options=opts)
driver.set_script_timeout(65)

def call(js,*args):
    return driver.execute_async_script(js,*args)
try:
    driver.get("data:text/html;charset=utf-8,"+quote(PAGE))
    for name in ("archive-dom.js","archive-crawler.js"):
        driver.execute_script((ROOT/name).read_text(encoding="utf-8"))
    driver.execute_script("""
      window.__crawl=new RarRescueCrawler(document,RarRescueDOM);
      window.enterImages();
    """)
    full=call("""
      const done=arguments[arguments.length-1];
      __crawl.enumerate().then(x=>done({ok:x.ok,complete:x.complete,
        length:x.items.length,first:x.items[0]?.name,last:x.items.at(-1)?.name,
        steps:x.scrollSteps}),e=>done({error:String(e)}));
    """)
    assert full["ok"] and full["complete"] and full["length"]==518,full
    assert full["last"]=="image00518.jpg",full
    first=call("""
      const done=arguments[arguments.length-1];
      __crawl.locate("image00026.jpg","file").then(row=>done({
        found:!!row,name:row?.getAttribute("title")}));
    """)
    assert first["found"] and first["name"]=="image00026.jpg",first
    # After a synthetic 120-second timeout, an app can stop updating rows.
    # Repeated scrolls must NOT cause any click on the missing item.
    driver.execute_script("""
      window.stalled=false;document.getElementById("list").scrollTop=0;
      window.renderVisible();window.stalled=true;
    """)
    missing=call("""
      const done=arguments[arguments.length-1];
      __crawl.locate("image00027.jpg","file").then(row=>done({found:!!row}));
    """)
    assert not missing["found"],missing
    assert driver.execute_script("return clickedFiles.length")==0
    # Repair by navigating via normal viewer controls to archive root/back.
    driver.execute_script("window.back();window.enterImages()")
    recovered=call("""
      const done=arguments[arguments.length-1];
      __crawl.locate("image00027.jpg","file").then(row=>done({
        found:!!row,name:row?.getAttribute("title")}));
    """)
    assert recovered["found"] and recovered["name"]=="image00027.jpg",recovered
    last=call("""
      const done=arguments[arguments.length-1];
      __crawl.locate("image00518.jpg","file").then(row=>done({
        found:!!row,name:row?.getAttribute("title")}));
    """)
    assert last["found"] and last["name"]=="image00518.jpg",last
    assert driver.execute_script("return clickedFiles")==[]
    assert driver.execute_script("return entries")==[
      "enter:IMAGES","back:IMAGES","enter:IMAGES"]
    print("PASS: Chrome virtualized 518-row inventory and last row location")
    print("PASS: stalled rows fail safely, re-enter fixes lookup without clicks")
finally:
    driver.quit()
