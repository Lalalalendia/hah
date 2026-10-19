/* Yandex RAR Rescue v0.2. Main-frame panel; read-only sensors live in docviewer frames. */
(() => {
  "use strict";
  const CONFIG_KEY = "rr_v02_config";
  const LEDGER_KEY = "rr_ledger";
  const ARCHIVE = "Disk-2.rar";
  let panel = null;
  let folder = "";
  let picked = null;
  let scanning = false;
  let isPicking = false;
  let awaiting = null;
  let downloaded = 0;
  let failed = 0;
  let frames = new Map();
  let scanId = "";
  let events = [];
  let selectedSummary = "";
  let notice = "Расширение ещё не проверило содержимое просмотрщика.";

  const send = async data => {
    try {
      const response = await chrome.runtime.sendMessage(data);
      if (!response || !response.ok) throw new Error(response?.error || "Нет ответа расширения");
      return response;
    } catch (error) { throw new Error(String(error.message || error)); }
  };
  const el = id => panel && panel.querySelector("#" + id);
  function note(str) {
    events.unshift(new Date().toLocaleTimeString() + " " + str);
    events = events.slice(0, 30);
    render();
  }
  function cleanPath(value) {
    const parts = String(value || "").replace(/\\/g, "/").split("/");
    if (parts.some(p => p === ".." || p.startsWith("~"))) throw new Error("Недопустимый путь: .. или ~");
    return parts.filter(p => p && p !== ".").join("/");
  }
  async function persist() {
    await chrome.storage.local.set({ [CONFIG_KEY]: { folder } });
  }
  async function updateLedger() {
    const l = (await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY] || {};
    downloaded = Object.values(l).filter(x => x.state === "downloaded").length;
    failed = Object.values(l).filter(x => x.state === "failed").length;
    render();
  }
  function render() {
    if (!panel) return;
    const snapshots = [...frames.values()].sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
    const populated = snapshots.filter(x => x.count > 0);
    const sum = populated.reduce((n, x) => n + Number(x.count || 0), 0);
    const statuses = el("rr-status");
    if (statuses) {
      statuses.textContent =
        (scanning ? "Сканирование... " : "") +
        (snapshots.length ?
          ("Обнаружено кадров: " + snapshots.length + ", имён файлов в DOM: " + sum +
            (populated.length ? " (доступен " + populated[0].host + ")" : " (список ещё не доступен)")) :
          "Кадры не ответили: проверь разрешения docviewer.yandex.ru и docviewer.360.yandex.ru");
    }
    const sample = snapshots.filter(x => x.count > 0).flatMap(x => x.names || []).slice(0, 8);
    if (el("rr-found")) el("rr-found").textContent = sample.length ? "На экране: " + sample.join(", ") : "Имена файлов пока не обнаружены.";
    if (el("rr-selected")) el("rr-selected").textContent = picked ?
      "Выбран " + picked.name + " · кадр " + picked.host + " · frame #" + picked.frameId :
      "Файл ещё не выбран.";
    if (el("rr-notice")) el("rr-notice").textContent = notice +
      " · сохранено: " + downloaded + ", ошибок: " + failed;
    if (el("rr-log")) el("rr-log").textContent = events.slice(0, 8).join("\n") || "Ожидаю действия.";
    if (el("rr-try")) el("rr-try").disabled = !picked || Boolean(awaiting);
    if (el("rr-pick")) el("rr-pick").disabled = isPicking || Boolean(awaiting);
    if (el("rr-stop")) el("rr-stop").disabled = !awaiting && !isPicking;
  }

  function mount() {
    if (panel) { panel.remove(); panel = null; return; }
    panel = document.createElement("section");
    panel.id = "rr-recovery-panel";
    panel.innerHTML = [
      '<header><strong>RAR Rescue v0.2</strong><button id="rr-close" title="Закрыть панель">×</button></header>',
      '<p>Диск 2.rar — 1286 объектов (файлы + каталоги). Сначала проверяем доступ к просмотрщику.</p>',
      '<div class="rr-actions"><button id="rr-scan">1. Найти файлы</button><button id="rr-pick">2. Выбрать файл</button></div>',
      '<p id="rr-status" role="status"></p><p id="rr-found"></p>',
      '<p id="rr-selected"></p>',
      '<label>Путь внутри архива (корень — оставить пустым)<input id="rr-folder" type="text" placeholder="например, HELP" autocomplete="off"></label>',
      '<div class="rr-actions"><button id="rr-try">3. Отследить скачивание</button><button id="rr-stop">Отмена ожидания</button></div>',
      '<p id="rr-notice" role="status"></p>',
      '<div class="rr-actions"><button id="rr-copy">Копировать диагностику</button></div>',
      '<pre id="rr-log"></pre>',
      '<small>После выбора файла нажми «Отследить скачивание», затем в просмотрщике Яндекса наведи курсор на этот файл и нажми появившийся значок «Скачать». Никакие EXE/скрипты не запускаются. Автоматическую очередь включим после подтверждения первого скачивания.</small>'
    ].join("");
    document.body.append(panel);
    if (el("rr-folder")) el("rr-folder").value = folder;
    el("rr-close").addEventListener("click", () => { panel.remove(); panel = null; });
    el("rr-folder").addEventListener("change", async e => {
      try {
        folder = cleanPath(e.target.value);
        e.target.value = folder;
        await persist();
        note("Путь: " + (folder || "[корень]"));
      } catch (err) { notice = err.message; render(); }
    });
    el("rr-scan").addEventListener("click", () => { void scan(); });
    el("rr-pick").addEventListener("click", () => { void startPick(); });
    el("rr-try").addEventListener("click", () => { void startDownloadWatch(); });
    el("rr-stop").addEventListener("click", () => { void stop(); });
    el("rr-copy").addEventListener("click", () => { void copyReport(); });
    render();
    void scan();
  }
  async function scan() {
    frames = new Map();
    scanning = true;
    scanId = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
    notice = "Проверяю основной документ и вложенные окна просмотрщика.";
    render();
    try { await send({ kind: "RR_SCAN_FRAMES", requestId: scanId }); }
    catch (error) { notice = "Не удалось запустить проверку: " + error.message; note(notice); }
    setTimeout(() => {
      scanning = false;
      if (!frames.size) {
        notice = "Ни один кадр не ответил. В настройках расширения разреши доступ к сайтам docviewer.* и обнови страницу Яндекса.";
        note(notice);
      } else {
        const best = [...frames.values()].sort((a, b) => b.count - a.count)[0];
        notice = best.count ?
          "Файлы обнаружены. Теперь нажми «Выбрать файл», затем нажми README.TXT в списке." :
          "Кадры отвечают, но имён в DOM нет. Открой RAR просмотрщик и повтори поиск.";
        render();
      }
    }, 1700);
  }
  async function startPick() {
    if (awaiting) return;
    try {
      await send({ kind: "RR_PICK_FILE" });
      isPicking = true;
      notice = "Теперь ОДИН РАЗ нажми на имя README.TXT (или другого файла) СЛЕВА в окне Яндекса. Не на кнопку этого расширения.";
      note("Ожидаю клик по самому файлу внутри просмотрщика.");
      setTimeout(() => {
        if (isPicking) {
          isPicking = false;
          notice = "За 45 секунд файл не выбран. Попробуй ещё раз и проверь разрешения docviewer.";
          render();
        }
      }, 47000);
    } catch (error) { notice = "Не удалось начать выбор: " + error.message; note(notice); }
  }
  function gotPicked(message) {
    if (!isPicking) return;
    isPicking = false;
    void send({ kind: "RR_STOP_PICK" }).catch(() => {});
    if (!message.found || !message.name) {
      notice = "Клик получен в " + message.host + ", но элемент не распознан как файл. Нажми прямо на имя README.TXT.";
      selectedSummary = JSON.stringify({ ancestry: message.ancestry, frameId: message.frameId });
      note(notice);
      return;
    }
    picked = {
      name: String(message.name).slice(0, 150),
      frameId: message.frameId,
      host: String(message.host || "").slice(0, 90),
      ancestry: message.ancestry || []
    };
    selectedSummary = "";
    notice = "Файл " + picked.name + " обнаружен. Нажми «Отследить скачивание», затем штатную кнопку скачивания Яндекса.";
    note("Файл выбран: " + picked.name + " · " + picked.host);
  }
  async function startDownloadWatch() {
    if (!picked || awaiting) return;
    try {
      folder = cleanPath(el("rr-folder").value);
      el("rr-folder").value = folder;
      await persist();
    } catch (error) { notice = error.message; render(); return; }
    const token = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
    const key = ARCHIVE + "/" + (folder ? folder + "/" : "") + picked.name;
    try {
      await send({ kind: "RR_ARM", token, key, folder, filename: picked.name });
      awaiting = { token, filename: picked.name, started: Date.now(), startedDownload: false };
      notice = "ОЖИДАЮ: наведи курсор на " + picked.name +
        " в списке Яндекса и нажми появившийся значок «Скачать». Если файл уже открыт, ищи «Скачать» в его просмотрщике.";
      note("Ожидаю загрузку файла " + picked.name + " в течение 90 секунд.");
      setTimeout(async () => {
        if (!awaiting || awaiting.token !== token) return;
        if (!awaiting.startedDownload) {
          await send({ kind: "RR_DISARM", token }).catch(() => {});
          awaiting = null;
          notice = "Браузер не начал загрузку за 90 секунд. Нужен снимок действия скачивания.";
          note(notice);
        }
      }, 90000);
    } catch (error) { notice = "Не удалось начать перехват загрузки: " + error.message; note(notice); }
  }
  async function stop() {
    if (isPicking) {
      isPicking = false;
      await send({ kind: "RR_STOP_PICK" }).catch(() => {});
      notice = "Выбор файла отменён.";
      note(notice);
      return;
    }
    if (awaiting) {
      const token = awaiting.token;
      await send({ kind: "RR_DISARM", token }).catch(() => {});
      awaiting = null;
      notice = "Ожидание завершено. Если скачивание уже идёт, оно не прерывается.";
      note(notice);
    }
  }
  async function copyReport() {
    const report = {
      version: "0.2.0",
      archive: "Disk 2.rar",
      detectedFrames: [...frames.values()].map(x => ({
        frameId: x.frameId, host: x.host, top: x.top, candidateCount: x.count,
        sampleNames: (x.names || []).slice(0, 8), archiveMarker: x.archiveMarker,
        knownReadme: x.knownReadme
      })),
      picked: picked ? { name: picked.name, frameId: picked.frameId, host: picked.host,
        ancestry: picked.ancestry } : null,
      missedClick: selectedSummary || null,
      downloaded, failed,
      events: events.slice(0, 12)
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      note("Диагностика скопирована. Проверь имена файлов перед отправкой.");
    } catch (error) { notice = "Буфер обмена недоступен: " + error.message; note(notice); }
  }
  chrome.runtime.onMessage.addListener(message => {
    if (!message || !message.kind) return;
    if (message.kind === "RR_TOGGLE") mount();
    if (message.kind === "RR_SENSOR_REPORT" && message.requestId === scanId) {
      frames.set(String(message.frameId), message);
      render();
    }
    if (message.kind === "RR_SENSOR_PICKED") gotPicked(message);
    if (message.kind === "RR_STARTED" && awaiting && message.token === awaiting.token) {
      awaiting.startedDownload = true;
      notice = "Загрузка началась. Ожидаю завершения в браузере.";
      note(notice);
    }
    if (message.kind === "RR_RESULT" && awaiting && message.token === awaiting.token) {
      awaiting = null;
      notice = message.state === "downloaded" ?
        "Загрузка завершена; проверь фактический файл в папке YandexRARRecovery. Сверка содержимого пока недоступна." :
        "Скачивание завершилось ошибкой: " + (message.reason || "неизвестная ошибка");
      note(picked?.name + ": " + message.state + " (" + (message.bytes || 0) + " байт)");
      void updateLedger();
    }
  });
  void (async () => {
    try {
      const saved = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || {};
      folder = String(saved.folder || "");
      await updateLedger();
    } catch (_) {}
  })();
})();
