#!/usr/bin/env python3
"""Exercise actual recursive walker with Chrome and a nested, stateful archive UI.
No Yandex account, requests or archive contents are involved."""
import json
import pathlib
from urllib.parse import quote
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

ROOT=pathlib.Path(__file__).resolve().parents[1]/"extension"
HTML="""<!doctype html><html lang="ru"><body>
<div class="archive_abc">
  <div class="archiveHeader_abc"><button class="backArrow_abc" id="back">Back</button>
    <strong>Диск 2.rar</strong></div>
  <div class="leftPanel_abc"><div class="listing_abc" id="listing"></div></div>
</div>
<script>
const trees = {
  "": [
    ["HELP","folder"],["JRE","folder"],
    ["README.TXT","file"],["INDEX.HTM","file"],["CDVIEWER.EXE","file"]
  ],
  "HELP": [["SUB","folder"],["HELPME.TXT","file"]],
  "HELP/SUB": [["NESTED.JSON","file"]],
  "JRE": []
};
window.currentPath="";
window.navEvents=[];
function draw() {
  const listing=document.getElementById("listing");
  listing.replaceChildren();
  for(const [name,kind] of trees[window.currentPath] || []) {
    const row=document.createElement("div");
    row.title=name;
    row.className="resourceItem_test listingItem_test";
    const icon=document.createElement("span");
    icon.className="file-icon file-icon_size_s file-icon_"+(kind==="folder"?"folder":"txt");
    row.append(icon);
    const label=document.createElement("span");
    label.className="resourceItemName_test";
    label.textContent=name;row.append(label);
    const bar=document.createElement("div");bar.className="actionBar_test";
    const download=document.createElement("button");
    download.type="button";download.textContent="↓";
    download.onclick=(e)=>{e.stopPropagation();window.navEvents.push("download:"+name)};
    bar.append(download);row.append(bar);
    row.onclick=()=>{if(kind==="folder"){window.currentPath=window.currentPath?
      window.currentPath+"/"+name:name;window.navEvents.push("enter:"+window.currentPath);draw();}};
    listing.append(row);
  }
}
document.getElementById("back").onclick=()=>{
  window.navEvents.push("back:"+window.currentPath);
  window.currentPath=window.currentPath.split("/").slice(0,-1).join("/");draw();
};
draw();
</script></body></html>"""

options=Options()
options.add_argument("--headless=new")
options.add_argument("--no-sandbox")
options.add_argument("--disable-dev-shm-usage")
drv=webdriver.Chrome(options=options)
def call(method):
    return drv.execute_async_script("""
    const args=arguments;const callback=args[args.length-1];
    window.__crawler[args[0]]().then(callback,e=>callback({ok:false,error:String(e)}));
    """,method)
try:
    drv.get("data:text/html;charset=utf-8,"+quote(HTML))
    drv.execute_script((ROOT/"archive-dom.js").read_text())
    drv.execute_script((ROOT/"archive-crawler.js").read_text())
    drv.execute_script("""
    window.__crawler=new window.RarRescueCrawler(document,window.RarRescueDOM,
      {delay:()=>Promise.resolve()});
    """)
    events=[call("begin")]
    for i in range(20):
        event=call("step")
        events.append(event)
        assert event["ok"],event
        if event["event"]=="complete":break
    else:raise AssertionError("Crawler did not finish")
    directory_events=[e for e in events if e["event"]=="directory"]
    visited=[e["path"] for e in directory_events]
    assert visited==["","HELP","HELP/SUB","JRE"],visited
    assert events[-1]["objects"]==8,events[-1]
    assert drv.execute_script("return window.currentPath")=="" 
    assert not any("download:" in x for x in drv.execute_script("return window.navEvents"))
    assert any(e["path"]=="JRE" and not e["items"] for e in directory_events)
    print("PASS: recursive navigation, empty directories, original folder paths and return to root")
    print(json.dumps({"paths":visited,"objects":events[-1]["objects"]}))
    # An absent back control must STOP rather than silently treating a
    # nested folder as if it were the root.
    drv.execute_script("window.currentPath='HELP/SUB';draw()")
    drv.execute_script("document.getElementById('back').remove()")
    drv.execute_script("window.__crawler=new window.RarRescueCrawler(document,window.RarRescueDOM,{delay:()=>Promise.resolve()})")
    result=call("begin")
    assert not result["ok"] and result["error"]=="not-at-known-rar-root",result
    print("PASS: rejects starting recovery inside an arbitrary subfolder")
finally:
    drv.quit()
