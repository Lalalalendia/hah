#!/usr/bin/env python3
"""Probe public RAR viewer DOM in a fresh unauthenticated Chrome session.

No cookies, query strings, full HTML dumps, private files or raw network URLs
are exported. Output is strictly structural information and known test names.
"""
import json
import re
import sys
import time
from urllib.parse import urlparse
from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By

URL = "https://disk.yandex.ru/d/_RSlWomRWmty1w"
KNOWN = ["README.TXT", "INDEX.HTM", "CDVIEWER.EXE", "1000005A"]
JS = r"""
const wanted = arguments[0];
const candidates = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
let n;
while ((n = walker.nextNode()) && candidates.length < 70) {
  const str = String(n.textContent || "").trim();
  if (wanted.includes(str) && n.parentElement) {
    const parents = [];
    let cur = n.parentElement;
    for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) {
      parents.push({
        tag: cur.tagName.toLowerCase(),
        classes: [...cur.classList].slice(0, 3),
        role: cur.getAttribute("role"),
        testid: cur.getAttribute("data-testid"),
        siblings: cur.parentElement ? cur.parentElement.children.length : 0,
        buttons: [...cur.querySelectorAll("button,[role=button]")].slice(0, 5).map(el => ({
          tag: el.tagName.toLowerCase(),
          label: el.getAttribute("aria-label"),
          title: el.getAttribute("title"),
          testid: el.getAttribute("data-testid")
        }))
      });
    }
    candidates.push({name: str, parents});
  }
}
return {
  title: document.title.slice(0, 100),
  knownItems: candidates,
  frameCount: document.querySelectorAll("iframe").length,
  frameHosts: [...document.querySelectorAll("iframe")].map(f => {
    try {return new URL(f.src).hostname;} catch(e){return "about:blank";}
  }),
  bodyHasArchiveName: (document.body.innerText || "").includes("Диск 2.rar"),
  bodyHasReadme: (document.body.innerText || "").includes("README.TXT"),
  visibleActionLabels: [...document.querySelectorAll("button,[role=button]")].map(b => ({
    text: (b.innerText || "").trim().slice(0, 40),
    aria: (b.getAttribute("aria-label") || "").slice(0, 60)
  })).filter(x=>/просмотр|скач|download|view/i.test(x.text+" "+x.aria)).slice(0, 20)
}
"""
options = Options()
options.add_argument("--headless=new")
options.add_argument("--no-sandbox")
options.add_argument("--disable-gpu")
options.add_argument("--disable-dev-shm-usage")
options.add_argument("--window-size=1400,1000")
options.add_argument("--lang=ru-RU")
options.page_load_strategy = "eager"

def inspect(driver, label):
    try:
        d = driver.execute_script(JS, KNOWN)
        print(label + " " + json.dumps(d, ensure_ascii=False), flush=True)
        return d
    except Exception as e:
        print(label + " inspected_failed=" + type(e).__name__, flush=True)
        return {}

def frame_walk(driver, level=0):
    if level>2:return
    frames = driver.find_elements(By.TAG_NAME, "iframe")
    for i, frame in enumerate(frames[:8]):
        try:
            driver.switch_to.frame(frame)
            result = inspect(driver, "FRAME " + str(level) + "." + str(i))
            if result.get("bodyHasReadme"): return True
            if frame_walk(driver, level+1): return True
        except Exception as e:
            print("Frame error: " + type(e).__name__, flush=True)
        finally:
            driver.switch_to.parent_frame()
    return False

try:
    browser = webdriver.Chrome(options=options)
except Exception as e:
    print("WEB_DRIVER_START_FAILURE", type(e).__name__, str(e)[:250], flush=True)
    sys.exit(1)

try:
    browser.set_page_load_timeout(35)
    browser.get(URL)
    time.sleep(7)
    first = inspect(browser, "PAGE_INITIAL")
    candidates = browser.find_elements(By.XPATH, "//*[self::button or self::a or @role='button'][contains(normalize-space(.), 'Просмотреть')]")
    print("VIEW_BUTTONS_FOUND", len(candidates), flush=True)
    for btn in candidates[:4]:
        try:
            if btn.is_displayed():
                btn.click()
                print("CLICKED_VIEW", flush=True)
                break
        except Exception as e:
            print("VIEW_CLICK_FAILED", type(e).__name__, flush=True)
    time.sleep(9)
    inspect(browser, "PAGE_AFTER_VIEW")
    frame_walk(browser)
finally:
    browser.quit()
