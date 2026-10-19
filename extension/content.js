/* Browser-side controller. No direct calls to Yandex APIs or cookie access. */
(() => {
  "use strict";
  const CONFIG_KEY = "rr_config";
  const LEDGER_KEY = "rr_ledger";
  const ARCHIVE = "Disk-2.rar";
  let panel = null;
  let calibration = null;
  let folder = "";
  let armedForTeaching = false;
  let running = false;
  let stopRequested = false;
  let ledger = {};
  const waiters = new Map();
  const recent = [];

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = message => {
    recent.unshift(new Date().toLocaleTimeString() + " " + message);
    recent.length = Math.min(recent.length, 40);
    refresh();
  };

  function linesFromRow(row) {
    const result = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!parent || parent.closest("button,[role=button]")) continue;
      const s = String(walker.currentNode.textContent || "").trim();
      if (s && s.length < 190 && !/^(Скачать|Просмотреть|На Диск|Download|Save)$/i.test(s)) result.push(s);
    }
    return [...new Set(result)];
  }

  function getName(row) {
    const titleNodes = row.querySelectorAll("[title]");
    for (const el of titleNodes) {
      if (el.closest("button,[role=button]")) continue;
      const t = (el.getAttribute("title") || "").trim();
      if (t && t.length < 190 && !/скач|download|сохран/i.test(t)) return t;
    }
    const names = linesFromRow(row);
    return names.find(s => /\.[\p{L}\p{N}]{1,9}$/u.test(s)) || names[0] || "";
  }

  function selectorForRow(row) {
    const classes = Array.from(row.classList).filter(c => !/^(active|selected|hover|focus)$/i.test(c)).slice(0, 2);
    const part = classes.map(c => "." + CSS.escape(c)).join("");
    return row.tagName.toLowerCase() + part;
  }

  function actionTrail(row, action) {
    const trail = [];
    let node = action;
    while (node && node !== row && node.parentElement && trail.length < 18) {
      trail.unshift(Array.from(node.parentElement.children).indexOf(node));
      node = node.parentElement;
    }
    return node === row ? trail : null;
  }

  function findAction(row) {
    if (!calibration) return null;
    let node = row;
    for (const index of calibration.trail) {
      if (!node || !node.children || !node.children[index]) return null;
      node = node.children[index];
    }
    return node && (node.matches("button,a,[role=button],[title]") ? node : node.closest("button,a,[role=button]"));
  }

  function pickRepeatedRow(button) {
    let node = button.parentElement;
    for (let depth = 0; node && depth < 14; depth++, node = node.parentElement) {
      if (!node.parentElement || node === document.body || (panel && panel.contains(node))) break;
      const className = Array.from(node.classList)[0];
      const siblings = Array.from(node.parentElement.children).filter(s =>
        s.tagName === node.tagName && (!className || s.classList.contains(className))
      );
      if (siblings.length < 2 || siblings.length > 500) continue;
      const names = siblings.map(getName).filter(Boolean);
      if (new Set(names).size < 2) continue;
      if (!names.some(s => /\.[\p{L}\p{N}]{1,9}$/u.test(s))) continue;
      const trail = actionTrail(node, button);
      if (!trail) continue;
      return { row: node, trail, count: siblings.length };
    }
    return null;
  }

  function scope() {
    if (!calibration) return document;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const matching = dialogs.find(d => d.querySelector(calibration.selector) && /Диск 2\.rar/i.test(d.textContent || ""));
    return matching || document;
  }

  function rows() {
    if (!calibration) return [];
    try {
      return Array.from(scope().querySelectorAll(calibration.selector))
        .filter(el => findAction(el) && getName(el));
    } catch (_) { return []; }
  }

  function findScroller(el) {
    for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
      const style = getComputedStyle(cur);
      if (/(auto|scroll)/.test(style.overflowY) && cur.scrollHeight > cur.clientHeight + 25 && cur.clientHeight > 70) return cur;
    }
    return document.scrollingElement;
  }

  function safeFolder(value) {
    const p = String(value || "").replace(/\\/g, "/").split("/");
    if (p.some(part => part === "..")) throw new Error("Путь не может содержать ..");
    return p.filter(x => x && x !== ".").join("/");
  }

  function keyFor(name) {
    return ARCHIVE + "/" + (folder ? folder + "/" : "") + name;
  }

  function contentFor(id) {
    return panel && panel.querySelector("#" + id);
  }

  function refresh() {
    if (!panel) return;
    const status = contentFor("rr-status");
    const entries = rows();
    const completed = Object.values(ledger).filter(x => x.state === "downloaded").length;
    const failed = Object.values(ledger).filter(x => x.state === "failed").length;
    if (status) status.textContent =
      (calibration ? "Обучено: " + calibration.sample + " · файлов в DOM: " + entries.length : "Нужно обучить кнопку скачивания") +
      " · сохранено: " + completed + " · ошибки: " + failed + (running ? " · ЗАГРУЗКА ИДЁТ" : "");
    const output = contentFor("rr-log");
    if (output) output.textContent = recent.slice(0, 9).join("\n") || "Ожидаю действий.";
    for (const id of ["rr-test", "rr-batch"]) {
      if (contentFor(id)) contentFor(id).disabled = !calibration || running;
    }
    if (contentFor("rr-stop")) contentFor("rr-stop").disabled = !running;
  }

  function mount() {
    if (panel) { panel.remove(); panel = null; return; }
    panel = document.createElement("div");
    panel.id = "rr-recovery-panel";
    panel.innerHTML = [
      '<header><strong>RAR Rescue · опытная версия</strong><button id="rr-close" title="Скрыть панель">×</button></header>',
      '<p>Диск 2.rar · 1286 объектов. Работаем только с текущей папкой просмотрщика.</p>',
      '<label>Путь текущей папки внутри RAR <input id="rr-folder" type="text" placeholder="например, 1000005A" autocomplete="off"></label>',
      '<div class="rr-actions"><button id="rr-teach">1. Обучить на значке скачивания</button><button id="rr-test">2. Пробная загрузка</button></div>',
      '<div class="rr-actions"><button id="rr-batch">3. Скачать текущую папку</button><button id="rr-stop">Остановить после файла</button></div>',
      '<div class="rr-actions"><button id="rr-scan">Обновить список</button><button id="rr-copy">Копировать диагностику</button></div>',
      '<p id="rr-status" role="status"></p><pre id="rr-log"></pre>',
      '<small>Сохраняет в «Загрузки/YandexRARRecovery/Disk-2.rar/». EXE и скрипты не запускаются. Браузер может потребовать разрешить несколько загрузок.</small>'
    ].join("");
    document.body.append(panel);
    contentFor("rr-folder").value = folder;
    contentFor("rr-folder").addEventListener("change", async event => {
      try {
        folder = safeFolder(event.target.value);
        event.target.value = folder;
        await saveConfig();
        log("Папка: " + (folder || "[корень]"));
      } catch (error) { log(String(error.message)); }
    });
    contentFor("rr-close").addEventListener("click", () => { panel.remove(); panel = null; });
    contentFor("rr-teach").addEventListener("click", () => {
      if (running) return;
      armedForTeaching = true;
      document.addEventListener("click", teach, true);
      log("Наведи курсор на обычный файл и нажми его значок «Скачать». Клик будет перехвачен для обучения.");
    });
    contentFor("rr-test").addEventListener("click", () => { void run(true); });
    contentFor("rr-batch").addEventListener("click", () => { void run(false); });
    contentFor("rr-stop").addEventListener("click", () => { stopRequested = true; log("Остановка после текущего файла."); });
    contentFor("rr-scan").addEventListener("click", () => {
      const list = rows();
      log("В DOM сейчас найдено файлов: " + list.length + ". Пример: " + list.slice(0, 3).map(getName).join(", "));
    });
    contentFor("rr-copy").addEventListener("click", () => { void copyReport(); });
    refresh();
  }

  async function saveConfig() {
    await chrome.storage.local.set({ [CONFIG_KEY]: { folder, calibration } });
  }

  function teach(event) {
    if (!armedForTeaching || !panel || panel.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    armedForTeaching = false;
    document.removeEventListener("click", teach, true);
    const action = event.target.closest("button,a,[role=button],[title]") || event.target;
    const match = pickRepeatedRow(action);
    if (!match) {
      log("Разметку ряда определить не удалось. Выбери значок скачивания файла в папке, где есть несколько файлов.");
      return;
    }
    calibration = {
      selector: selectorForRow(match.row),
      trail: match.trail,
      sample: getName(match.row),
      detectedRows: match.count
    };
    log("Образец: " + calibration.sample + "; рядов рядом: " + match.count + ". Теперь нажми «Пробная загрузка».");
    void saveConfig();
    refresh();
  }

  async function one(row, retryCount) {
    const filename = getName(row);
    const key = keyFor(filename);
    const button = findAction(row);
    if (!button || !document.contains(button)) return "missing";
    const attempts = retryCount || 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (stopRequested) return "stopped";
      const token = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);
      let finish;
      let timer;
      const resultPromise = new Promise(resolve => {
        finish = resolve;
        timer = setTimeout(() => { waiters.delete(token); resolve({ state: "timeout", reason: "No browser download event" }); }, 30000);
        waiters.set(token, {
          started() {
            clearTimeout(timer);
            timer = setTimeout(() => { waiters.delete(token); resolve({ state: "timeout", reason: "Download not finished within 3 minutes" }); }, 180000);
          },
          resolved(result) { clearTimeout(timer); waiters.delete(token); resolve(result); }
        });
      });
      let armed;
      try {
        armed = await chrome.runtime.sendMessage({ kind: "RR_ARM", token, key, folder, filename });
        if (!armed || !armed.ok) throw new Error((armed && armed.error) || "Cannot arm download");
        button.click();
      } catch (error) {
        clearTimeout(timer);
        waiters.delete(token);
        log("Не удалось начать " + filename + ": " + error.message);
        return "failed";
      }
      const result = await resultPromise;
      if (result.state === "timeout") {
        await chrome.runtime.sendMessage({ kind: "RR_DISARM", token }).catch(() => {});
      }
      log(filename + ": попытка " + attempt + "/" + attempts + " → " + result.state +
        (result.reason ? " (" + result.reason + ")" : ""));
      if (result.state === "downloaded") {
        ledger[key] = { state: "downloaded", time: new Date().toISOString(), bytes: result.bytes || 0 };
        await chrome.storage.local.set({ [LEDGER_KEY]: ledger });
        return "downloaded";
      }
      if (/BLOCKED|DANGEROUS|SECURITY|USER_CANCELED/i.test(result.reason || "")) break;
      if (attempt !== attempts) await sleep(Math.min(16000, 2500 * Math.pow(2, attempt)));
    }
    ledger[key] = { state: "failed", time: new Date().toISOString() };
    await chrome.storage.local.set({ [LEDGER_KEY]: ledger });
    return "failed";
  }

  async function run(testOnly) {
    if (running || !calibration) return;
    try { folder = safeFolder(contentFor("rr-folder").value); }
    catch (error) { log(String(error.message)); return; }
    await saveConfig();
    running = true;
    stopRequested = false;
    let total = 0;
    const seen = new Set();
    log(testOnly ? "Пробная загрузка одного файла." : "Начинаю последовательную загрузку текущей папки.");
    try {
      const first = rows()[0];
      if (!first) throw new Error("Файлы не найдены. Открой папку с файлами и повтори обучение.");
      const scroller = findScroller(first);
      if (!testOnly && scroller) scroller.scrollTop = 0;
      let stagnant = 0;
      for (let page = 0; page < (testOnly ? 1 : 400) && !stopRequested; page++) {
        let fresh = 0;
        for (const row of rows()) {
          if (stopRequested) break;
          const filename = getName(row);
          const key = keyFor(filename);
          if (seen.has(key) || (!testOnly && ledger[key] && ledger[key].state === "downloaded")) continue;
          seen.add(key);
          fresh++;
          const status = await one(row, 3);
          if (status === "downloaded") total++;
          if (status === "stopped") break;
          refresh();
          if (testOnly) { stopRequested = true; break; }
          await sleep(1300);
        }
        if (testOnly || stopRequested) break;
        if (!scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8) break;
        const before = scroller.scrollTop;
        scroller.scrollTop = before + Math.max(150, Math.round(scroller.clientHeight * 0.75));
        await sleep(450);
        stagnant = (fresh === 0 || scroller.scrollTop === before) ? stagnant + 1 : 0;
        if (stagnant >= 4) break;
      }
      log("Проход завершён. Скачиваний в этом проходе: " + total + ". Проверь папку загрузок.");
    } catch (error) {
      log("Остановлено из-за ошибки: " + String(error.message || error));
    } finally {
      running = false; stopRequested = false; refresh();
    }
  }

  async function copyReport() {
    const entries = rows();
    const report = {
      tool: "Yandex RAR Rescue v0.1",
      targetArchive: "Disk 2.rar",
      visibleRows: entries.length,
      sampleNames: entries.slice(0, 5).map(getName),
      calibration,
      downloaded: Object.values(ledger).filter(x => x.state === "downloaded").length,
      failed: Object.values(ledger).filter(x => x.state === "failed").length,
      events: recent.slice(0, 20)
    };
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); log("Диагностика скопирована. Нет cookies, токенов или URL с подписью."); }
    catch (error) { log("Буфер обмена недоступен: " + error.message); }
  }

  chrome.runtime.onMessage.addListener(message => {
    if (!message || !message.kind) return;
    if (message.kind === "RR_TOGGLE") mount();
    if (message.kind === "RR_STARTED") {
      const waiter = waiters.get(message.token);
      if (waiter) waiter.started();
    }
    if (message.kind === "RR_RESULT") {
      const waiter = waiters.get(message.token);
      if (waiter) waiter.resolved(message);
    }
  });

  void (async () => {
    const values = await chrome.storage.local.get([CONFIG_KEY, LEDGER_KEY]);
    const saved = values[CONFIG_KEY] || {};
    folder = typeof saved.folder === "string" ? saved.folder : "";
    calibration = saved.calibration && Array.isArray(saved.calibration.trail) ? saved.calibration : null;
    ledger = values[LEDGER_KEY] || {};
  })();
})();
