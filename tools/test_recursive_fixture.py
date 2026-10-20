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
    ["HELP","folder"],["JRE","folder"],["REPORT","folder"],["PLUGINS","folder"],
    ["README.TXT","file"],["INDEX.HTM","file"],["CDVIEWER.EXE","file"]
  ],
  "HELP": [["SUB","folder"],["HELPME.TXT","file"]],
  "HELP/SUB": [["NESTED.JSON","file"]],
  "JRE": [],
  "REPORT": [["README.TXT","file"]],
  "PLUGINS": [["README.TXT","file"]]
};
window.currentPath="";
window.navEvents=[];
function draw() {
  const listing=document.getElementById("listing");
  document.querySelector('[class*="archiveHeader_"]').setAttribute("data-archive-path",window.currentPath||"/");
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
    download.onclick=(e)=>{e.stopPropagation();window.navEvents.push("download:"+window.currentPath+"/"+name)};
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
        if event["event"]=="directory" and event["path"] in ["REPORT","PLUGINS"]:
            clicked=drv.execute_script("""
              const row=window.RarRescueDOM.rowNamed(document,"README.TXT");
              if(!row)return {ok:false,error:"same-name-row-not-found"};
              const action=window.RarRescueDOM.actionOf(row,true);
              if(!action.element)return {ok:false,error:action.error};
              action.element.click();
              return {ok:true,path:window.currentPath+"/README.TXT"};
            """)
            assert clicked["ok"],clicked
            assert clicked["path"]==event["path"]+"/README.TXT",clicked
        if event["event"]=="complete":break
    else:raise AssertionError("Crawler did not finish")
    directory_events=[e for e in events if e["event"]=="directory"]
    visited=[e["path"] for e in directory_events]
    assert visited==["","HELP","HELP/SUB","JRE","REPORT","PLUGINS"],visited
    assert events[-1]["objects"]==12,events[-1]
    assert drv.execute_script("return window.currentPath")=="" 
    assert sorted(x for x in drv.execute_script("return window.navEvents") if x.startswith("download:")) == [
        "download:PLUGINS/README.TXT","download:REPORT/README.TXT"
    ]
    assert any(e["path"]=="JRE" and not e["items"] for e in directory_events)
    print("PASS: recursive navigation, empty directories, same-name nested file buttons, and return to root")
    print(json.dumps({"paths":visited,"objects":events[-1]["objects"]}))
    # Test durable per-subtree inventory checkpoints. The restart begins at
    # viewer root and checks cached parent signatures; a fully scanned HELP
    # subtree must never be re-entered or counted twice.
    drv.execute_script("window.currentPath='';draw()")
    drv.execute_script("window.__crawler=new window.RarRescueCrawler(document,window.RarRescueDOM,{delay:()=>Promise.resolve()})")
    root=call("begin")
    cache={"": {"path":"","entries":root["items"]}}
    closed=[]
    for i in range(12):
        step=call("step")
        assert step["ok"],step
        if step["event"]=="directory":
            cache[step["path"]]={"path":step["path"],"entries":step["items"]}
        elif step["event"]=="returned":
            closed.append(step["completedPath"])
            if step["completedPath"]=="HELP":break
    else:raise AssertionError("Crawler did not close first subtree")
    assert set(closed)=={"HELP","HELP/SUB"},closed
    assert drv.execute_script("return window.currentPath")==""
    checkpoint={"directories":cache,"completedSubtrees":closed}
    drv.execute_script("window.navEvents=[];window.currentPath='';draw()")
    drv.execute_script("""
      window.__crawler=new window.RarRescueCrawler(document,window.RarRescueDOM,
        {delay:()=>Promise.resolve()});
    """)
    resumed=drv.execute_async_script("""
      const done=arguments[arguments.length-1];
      window.__crawler.begin('Диск 2.rar',arguments[0]).then(done);
    """,checkpoint)
    assert resumed["ok"],resumed
    skipped=[]
    for _ in range(20):
        item=call("step")
        assert item["ok"],item
        if item["event"]=="skipped":skipped.append(item["path"])
        if item["event"]=="complete":break
    else:raise AssertionError("Checkpointed crawler did not complete")
    assert skipped==["HELP"],skipped
    assert item["objects"]==12 and item["paths"]==6,item
    visited=drv.execute_script("return window.navEvents")
    assert not any(x=="enter:HELP" or x=="enter:HELP/SUB" for x in visited),visited
    print("PASS: restart skips previously completed subtree, preserves 12 objects, and reaches root")
    # If the root contents changed, the checkpoint must be rejected.
    drv.execute_script("window.currentPath='';trees[''][0][0]='CHANGED';draw()")
    drv.execute_script("window.__crawler=new window.RarRescueCrawler(document,window.RarRescueDOM,{delay:()=>Promise.resolve()})")
    mismatched=drv.execute_async_script("""
      const done=arguments[arguments.length-1];
      window.__crawler.begin('Диск 2.rar',arguments[0]).then(done);
    """,checkpoint)
    assert not mismatched["ok"] and "checkpoint-directory-changed" in mismatched["error"],mismatched
    print("PASS: changed source root invalidates stored inventory")
    drv.execute_script("trees[''][0][0]='HELP';draw()")
    # A changed NESTED listing must be rejected, even though root listing is
    # unchanged. Keep enough path context to return to root for a fresh scan.
    drv.execute_script("""
      window.currentPath='';trees['HELP'].push(['ADDED.TXT','file']);draw();
      window.__crawler=new window.RarRescueCrawler(document,window.RarRescueDOM,
        {delay:()=>Promise.resolve()});
    """)
    mid_checkpoint={"directories":checkpoint["directories"],
                    "completedSubtrees":["HELP/SUB"]}
    assert drv.execute_async_script("""
      const done=arguments[arguments.length-1];
      window.__crawler.begin('Диск 2.rar',arguments[0]).then(done);
    """,mid_checkpoint)["ok"]
    mismatch=call("step")
    assert not mismatch["ok"] and "checkpoint-directory-changed:HELP" in mismatch["error"],mismatch
    rewind=drv.execute_async_script("""
      const done=arguments[arguments.length-1];
      window.__crawler.rewindToRoot('Диск 2.rar').then(done);
    """)
    assert rewind["ok"] and rewind["rootReached"],rewind
    assert drv.execute_script("return window.currentPath")==""
    fresh=call("begin")
    assert fresh["ok"],fresh
    for _ in range(20):
        item=call("step")
        assert item["ok"],item
        if item["event"]=="complete":break
    else:raise AssertionError("Rebuilt crawler did not complete")
    assert item["objects"]==13 and item["paths"]==6,item
    drv.execute_script("trees['HELP'].pop();window.currentPath='';draw()")
    print("PASS: mutated nested listing rejected; verified rewind allows clean 13-member rebuild")

    # An interrupted crawl leaves the viewer inside a nested folder.
    # Rewinding uses the VERIFIED DFS parent listings, not an unchecked click.
    drv.execute_script("window.currentPath='';draw()")
    drv.execute_script("window.__crawler=new window.RarRescueCrawler(document,window.RarRescueDOM,{delay:()=>Promise.resolve()})")
    assert call("begin")["ok"]
    assert call("step")["path"]=="HELP"
    assert call("step")["path"]=="HELP/SUB"
    assert drv.execute_script("return window.currentPath")=="HELP/SUB"
    rewound=drv.execute_async_script("""
      const done=arguments[arguments.length-1];
      window.__crawler.rewindToRoot('Диск 2.rar').then(done);
    """)
    assert rewound["ok"] and rewound["rootReached"],rewound
    assert drv.execute_script("return window.currentPath")==""
    print("PASS: interrupted live walker rewinds to root by verified parents")

    # Identical parent/child rows are valid: the viewer's path transition
    # confirms navigation even when filename snapshots do not change.
    drv.execute_script("""
      trees['']=[['TWIN','folder']];
      trees['TWIN']=[['TWIN','folder']];
      trees['TWIN/TWIN']=[['leaf.txt','file']];
      window.currentPath='';draw();
      window.__crawler=new window.RarRescueCrawler(document,window.RarRescueDOM,
        {delay:()=>Promise.resolve()});
    """)
    assert call("begin")["ok"]
    for _ in range(10):
        result=call("step")
        assert result["ok"],result
        if result["event"]=="complete":break
    else:raise AssertionError("Identical-listing nested traversal did not finish")
    assert result["objects"]==3 and result["paths"]==3,result
    assert drv.execute_script("return window.currentPath")==""
    print("PASS: identical parent/child directory names navigate by viewer path changes")
    drv.execute_script("""
      trees['']=[
        ['HELP','folder'],['JRE','folder'],['REPORT','folder'],['PLUGINS','folder'],
        ['README.TXT','file'],['INDEX.HTM','file'],['CDVIEWER.EXE','file']
      ];
      window.currentPath='';draw();
    """)
    # An absent back control must STOP rather than silently treating a
    # nested folder as if it were the root.
    drv.execute_script("window.currentPath='HELP/SUB';draw()")
    drv.execute_script("document.getElementById('back').remove()")
    drv.execute_script("window.__crawler=new window.RarRescueCrawler(document,window.RarRescueDOM,{delay:()=>Promise.resolve()})")
    result=call("begin")
    assert not result["ok"] and result["error"]=="not-at-archive-root",result
    print("PASS: rejects a non-root viewer breadcrumb independent of member names")
    # A different public RAR may have zero of Disk-2's special file names.
    drv.execute_script("window.currentPath='';trees['']=[['arbitrary.dat','file']];draw()")
    drv.execute_script("window.__crawler=new window.RarRescueCrawler(document,window.RarRescueDOM,{delay:()=>Promise.resolve()})")
    fresh=call("begin")
    assert fresh["ok"] and fresh["path"]=="" and len(fresh["items"])==1,fresh
    print("PASS: accepts a markerless arbitrary archive root")
    # An untrusted folder name must not become an object prototype or
    # escape into an unexpected browser path.
    drv.execute_script("""
      trees['']=[['__proto__','folder']];window.currentPath='';draw();
      window.__crawler=new window.RarRescueCrawler(document,window.RarRescueDOM,
        {delay:()=>Promise.resolve()});
    """)
    assert call("begin")["ok"]
    blocked=call("step")
    assert not blocked["ok"] and "unsafe-folder-name" in blocked["error"],blocked
    assert drv.execute_script("return window.currentPath")==""
    print("PASS: prototype-shaped folder name cannot trigger unsafe viewer traversal")
finally:
    drv.quit()
