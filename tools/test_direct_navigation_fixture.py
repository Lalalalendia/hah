#!/usr/bin/env python3
"""Chrome acceptance test for shortest known-path navigation.
Only verified on synthetic DOM; no browser data or Yandex credentials.
"""
import json
from pathlib import Path
from urllib.parse import quote
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

ROOT=Path(__file__).resolve().parents[1]/"extension"
folders=["HELP","PLUGINS","REPORT","JRE"]+[
    "SKIP"+str(n).zfill(3) for n in range(1,82)
]
trees={
    "":[["README.TXT","file"],["INDEX.HTM","file"]]+[[n,"folder"] for n in folders],
    "HELP":[["SUB","folder"],["OTHER","folder"],["README.TXT","file"]],
    "HELP/SUB":[["NESTED.XML","file"]],
    "HELP/OTHER":[["SECOND.JSON","file"]],
    "REPORT":[["README.TXT","file"]],
    "PLUGINS":[["README.TXT","file"]],
    "JRE":[]
}
for f in folders[4:]:trees[f]=[]
assert len(trees)==88,len(trees)
expected=[{"path":key,"entries":[{"name":n,"kind":k} for n,k in entries]}
    for key,entries in trees.items()]
html="""<!doctype html><html><body>
<div class="archive_test">
  <div class="archiveHeader_test"><button class="backArrow_test" id="back">Back</button></div>
  <div class="leftPanel_test"><div class="listing_test" id="listing"></div></div>
</div>
<script>
window.trees=TREES_JSON;
window.currentPath="";
window.navEvents=[];
function draw(){
  const listing=document.getElementById("listing");
  listing.replaceChildren();
  for(const [name,kind] of (trees[currentPath]||[])){
    const row=document.createElement("div");
    row.title=name;row.className="resourceItem_test listingItem_test";
    const icon=document.createElement("span");
    icon.className="file-icon file-icon_"+(kind==="folder"?"dir":"text");
    row.append(icon);
    const label=document.createElement("span");
    label.textContent=name;label.className="resourceItemName_test";
    row.append(label);
    const bar=document.createElement("div");
    bar.className="actionBar_test";
    const download=document.createElement("button");
    download.setAttribute("aria-label","Скачать");
    download.textContent="↓";
    download.onclick=(e)=>{e.stopPropagation();navEvents.push("download:"+currentPath+"/"+name);};
    bar.append(download);row.append(bar);
    row.onclick=()=>{if(kind==="folder"){
      currentPath=(currentPath?currentPath+"/":"")+name;
      navEvents.push("enter:"+currentPath);draw();
    }};
    listing.append(row);
  }
}
document.getElementById("back").onclick=()=>{
  navEvents.push("back:"+currentPath);
  currentPath=currentPath.split("/").slice(0,-1).join("/");
  draw();
};
draw();
</script></body></html>""".replace("TREES_JSON",json.dumps(trees,ensure_ascii=False))
opts=Options()
opts.add_argument("--headless=new")
opts.add_argument("--no-sandbox")
opts.add_argument("--disable-dev-shm-usage")
driver=webdriver.Chrome(options=opts)
def call(method,*args):
    return driver.execute_async_script("""
      const args=[...arguments];const callback=args.pop();
      window.__nav[args[0]](...args.slice(1)).then(callback,
        err=>callback({ok:false,error:String(err)}));
    """,method,*args)
try:
    driver.get("data:text/html;charset=utf-8,"+quote(html))
    for file in ["archive-dom.js","archive-crawler.js","archive-navigator.js"]:
        driver.execute_script((ROOT/file).read_text(encoding="utf-8"))
    driver.execute_script("""
      window.__crawl=new RarRescueCrawler(document,RarRescueDOM,
        {delay:()=>Promise.resolve()});
      window.__nav=new RarRescueNavigator(document,RarRescueDOM,window.__crawl);
    """)
    initialized=call("start",expected)
    assert initialized["ok"] and initialized["path"]=="",initialized
    for target in ["HELP/SUB","HELP/OTHER","REPORT","PLUGINS"]:
        result=call("go",target)
        assert result["ok"] and result["path"]==target,(target,result)
        if target in ["REPORT","PLUGINS"]:
            clicked=driver.execute_script("""
              const row=RarRescueDOM.rowNamed(document,"README.TXT");
              if(!row)return false;
              const action=RarRescueDOM.actionOf(row,false);
              if(!action.element)return false;
              action.element.click();
              return true;
            """)
            assert clicked,target
    returned=call("go","")
    assert returned["ok"] and returned["path"]=="",returned
    assert returned["entered"]==5 and returned["backed"]==5,returned
    actual=driver.execute_script("return navEvents")
    expected_events=[
      "enter:HELP","enter:HELP/SUB","back:HELP/SUB",
      "enter:HELP/OTHER","back:HELP/OTHER","back:HELP",
      "enter:REPORT","download:REPORT/README.TXT",
      "back:REPORT","enter:PLUGINS","download:PLUGINS/README.TXT",
      "back:PLUGINS"
    ]
    assert actual==expected_events,(actual,expected_events)
    assert not any("SKIP" in e or "JRE" in e for e in actual),actual
    bad=call("go","NONEXISTENT")
    assert not bad["ok"] and returned["path"]=="",bad
    print("PASS: navigates only selected known folders, LCA reuse, same-named file actions, 5 entries not 87")
    print(json.dumps({"entries":returned["entered"],"backtracks":returned["backed"],
      "knownDirectories":len(trees)},ensure_ascii=False))
    # Manifest mismatch while opening a target folder must stop navigation.
    driver.execute_script("""
      trees["REPORT"]=[["UNEXPECTED.TXT","file"]];draw();
    """)
    failed=call("go","REPORT")
    assert not failed["ok"] and "differ" in failed["error"],failed
    status=driver.execute_script("return window.__nav.status()")
    assert status["halted"],status
    print("PASS: mismatched folder content halts; no other directory explored")
finally:
    driver.quit()
