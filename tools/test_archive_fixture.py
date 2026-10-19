#!/usr/bin/env python3
"""Run the real RAR extension DOM adapter/sensor against a minimal live Chrome fixture.
No Yandex credentials, real downloads, network requests or private page contents.
"""
import json
import pathlib
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

ROOT = pathlib.Path(__file__).resolve().parents[1] / "extension"
HTML = """<!doctype html><html><head><title>Fixture</title></head><body>
<button id="header-download">Скачать Диск 2.rar целиком</button>
<div id="app"><div class="embed-slider"><div class="archive_YiC4SRUb2YA4rmP8">
<div class="leftPanel_s9SuwM_e_BsDqlxW"><div class="listing_c7puEm5nLuMUpHxl">
<div title="JRE" class="resourceItem_UW3xqn78_GQsvOky listingItem_OfYVDJLU7x0vOvQS">
  <span class="file-icon file-icon_size_s file-icon_folder"></span><span>JRE</span></div>
<div title="README.TXT" class="resourceItem_UW3xqn78_GQsvOky listingItem_OfYVDJLU7x0vOvQS">
  <span class="file-icon file-icon_size_s file-icon_txt"></span>
  <span class="resourceItemName_dNRxyCHXTFYiG9Ou">README.TXT</span>
  <div class="actionBar_n8Tf7eeEgYKxWp2o">
    <button id="preview-readme" type="button">👁</button>
    <button id="download-readme" type="button">↓</button>
  </div>
</div>
<div title="INDEX.HTM" class="resourceItem_UW3xqn78_GQsvOky listingItem_OfYVDJLU7x0vOvQS">
  <span class="file-icon file-icon_size_s file-icon_html"></span>
  <span class="resourceItemName_dNRxyCHXTFYiG9Ou">INDEX.HTM</span>
  <div class="actionBar_n8Tf7eeEgYKxWp2o">
    <button type="button" aria-label="Просмотреть">👁</button>
    <button type="button" aria-label="Скачать" id="download-index">↓</button>
  </div>
</div></div></div></div></div></body></html>"""

opts=Options()
opts.add_argument("--headless=new")
opts.add_argument("--no-sandbox")
opts.add_argument("--disable-dev-shm-usage")
opts.add_argument("--window-size=1280,900")
drv=webdriver.Chrome(options=opts)
try:
    drv.get("data:text/html;charset=utf-8," + __import__("urllib.parse",fromlist=["quote"]).quote(HTML))
    drv.execute_script("""
      window.__events=[];
      document.getElementById('header-download').addEventListener('click',()=>window.__events.push('header'));
      document.getElementById('preview-readme').addEventListener('click',()=>window.__events.push('preview'));
      document.getElementById('download-readme').addEventListener('click',()=>window.__events.push('README.TXT'));
      document.getElementById('download-index').addEventListener('click',()=>window.__events.push('INDEX.HTM'));
      window.chrome={runtime:{
        onMessage:{addListener:fn=>{window.__rrListener=fn;}},
        sendMessage:payload=>{window.__lastMessage=payload;return Promise.resolve({ok:true});}
      }};
    """)
    drv.execute_script((ROOT/"archive-dom.js").read_text())
    drv.execute_script((ROOT/"archive-crawler.js").read_text())
    drv.execute_script((ROOT/"frame-sensor.js").read_text())
    listing=drv.execute_async_script("""
      const cb=arguments[arguments.length-1];
      window.__rrListener({kind:'RR_SENSOR_LIST'},null,(response)=>cb(response));
    """)
    assert listing["ok"],listing
    by_name={item["name"]:item for item in listing["items"]}
    assert by_name["JRE"]["kind"] == "folder",listing
    assert by_name["README.TXT"]["kind"] == "file",listing
    assert by_name["INDEX.HTM"]["downloadHint"],listing
    first=drv.execute_async_script("""
      const cb=arguments[arguments.length-1];
      window.__rrListener({kind:'RR_SENSOR_TRIGGER',name:'README.TXT',pilot:true},
        null,(response)=>cb(response));
    """)
    assert first["ok"] and first["mode"] == "last-control",first
    second=drv.execute_async_script("""
      const cb=arguments[arguments.length-1];
      window.__rrListener({kind:'RR_SENSOR_TRIGGER',name:'INDEX.HTM',
       pilot:false,approvedMode:'label',approvedSlots:2},
       null,(response)=>cb(response));
    """)
    assert second["ok"] and second["mode"] == "label",second
    assert drv.execute_script("return window.__events") == ["README.TXT","INDEX.HTM"]
    inspected=drv.execute_async_script("""
      const cb=arguments[arguments.length-1];
      window.__rrListener({kind:'RR_SENSOR_TRIGGER',name:'README.TXT',
       pilot:true,inspectOnly:true},null,(response)=>cb(response));
    """)
    assert inspected["ok"] and inspected["inspected"] and not inspected["clicked"],inspected
    assert drv.execute_script("return window.__events") == ["README.TXT","INDEX.HTM"]
    denied=drv.execute_async_script("""
      const cb=arguments[arguments.length-1];
      window.__rrListener({kind:'RR_SENSOR_TRIGGER',name:'JRE',pilot:true},
        null,(response)=>cb(response));
    """)
    assert not denied["ok"] and denied["error"] == "file-row-not-visible",denied
    assert drv.execute_script("return window.__events") == ["README.TXT","INDEX.HTM"]
    print("PASS: Chrome fixture detects file titles, ignores folders, clicks only row downloads")
    print(json.dumps({"files":2,"folders":1,"headerClicked":False},ensure_ascii=False))
finally:
    drv.quit()
