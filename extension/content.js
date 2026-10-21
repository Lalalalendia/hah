/* Main-frame controller for Yandex RAR Rescue v0.5.
   Never reads account cookies, document payloads or signed download URLs. */
(() => {
  "use strict";
  const LEDGER_KEY = "rr_ledger";
  const NESTED_PILOT_LIMIT = 2;
  const TREE_KEY = "rr_tree_v05";
  const EXPECTED_OBJECTS = 1286; // legacy-only diagnostic
  const MAX_CRAWL_EVENTS = 100000;
  const ARCHIVE = "Disk-2.rar";
  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
  let panel = null, folder = "", frames = new Map(), scanId = "", scanning = false;
  let approved = null, pending = null, running = false, stopRequested = false;
  let events = [], downloaded = 0, failed = 0;
  let notice = "Ищу открытый RAR в веб-просмотрщике Яндекс Диска.";
  let progress = "";
  let lastInspection = [];
  let nativeVerified = false;
  let lastAutoCommand = null;
  let ledgerSnapshot = {};
  let lastResumeReview = null;
  let nestedPilotPlan = null;
  let tree = null;
  let treePhase = "";
  let treeFrame = null;
  let harvestSummary = null;
  let harvestLoopActive = false;
  const harvestWake=new RarRescueHarvestWake();
  let harvestWaitingSource=null;
  let scope = null;
  function archiveRoot(){return scope?.outputRoot||ARCHIVE;}
  let verifiedViewerTitle=null;
  function archiveTitleResolution(){
    const viewer=String(bestFrame()?.archiveName||"").trim();
    const meta=document.querySelector('meta[property="og:title"]')?.content||
      document.querySelector('meta[name="twitter:title"]')?.content||"";
    const fingerprint=RarRescueArchiveScope.viewerFingerprint(bestFrame());
    const resolved=RarRescueArchiveScope.resolveName(location.href,[
      {source:"viewer",value:viewer},
      {source:"metadata",value:meta},
      {source:"page",value:String(document.title||"")}
    ],fingerprint);
    return {...resolved,fingerprint};
  }
  async function ensureArchiveScope(){
    const resolved=archiveTitleResolution();
    const detected=RarRescueArchiveScope.fromYandexViewer(
      location.href,resolved.archiveName,resolved.fingerprint);
    if(scope&&!RarRescueArchiveScope.sameScope(scope,detected))
      throw Error("The active archive changed during recovery");
    // Output ownership must be allocated by the single background worker,
    // not by two independent tabs racing storage.get/storage.set.
    await send({kind:"RR_RESERVE_OUTPUT_ROOT",scope:detected});
    scope=detected;
    verifiedViewerTitle=resolved.viewerExpectedTitle;
    if(resolved.fallback)show("Яндекс не передал имя архива. Использую папку "+
      resolved.archiveName+" (по адресу и содержимому веб-просмотрщика); исходные имена файлов сохраняются.");
    if(!tree){
      const store=await chrome.storage.local.get(scope.treeStorageKey);
      const saved=store[scope.treeStorageKey];
      if(saved?.scopeId===scope.scopeId)tree=saved;
    }
    return scope;
  }

  function show(message) {
    events.unshift(new Date().toLocaleTimeString() + " " + message);
    events = events.slice(0,30);
    render();
  }
  const el = id => panel && panel.querySelector("#"+id);
  async function send(message) {
    if(scope&&message?.kind?.startsWith("RR_HARVEST_")&&!message.scope)
      message={...message,scope};
    const stage=String(message.kind||"unknown")+
      (message.kind==="RR_FRAME_CALL"?"/"+String(message.payload?.kind||"unknown"):"");
    const started=Date.now();
    let response;
    try{response=await chrome.runtime.sendMessage(message);}
    catch(error){
      const detail=String(error?.message||error);
      const elapsed=Math.round((Date.now()-started)/1000);
      throw new Error(/message channel closed|Receiving end does not exist|Could not establish connection/i.test(detail)?
        "Канал расширения оборвался на "+stage+" спустя "+elapsed+
        " с. Команда не будет автоматически повторена; уже учтённые файлы сохранены.":
        "Ошибка "+stage+": "+detail);
    }
    if(!response?.ok)throw new Error(response?.error||"Нет ответа на "+stage);
    return response;
  }
  let viewerFrameAlias=null;
  async function inFrame(id,payload){
    const target=viewerFrameAlias??id;
    const result=await send({kind:"RR_FRAME_CALL",frameId:target,payload});
    if(Number.isInteger(result.viewerFrameId)&&result.viewerFrameId!==target){
      viewerFrameAlias=result.viewerFrameId;
      show("Связь с веб-просмотрщиком восстановлена; найден активный iframe.");
    }
    return result;
  }
  function folderValue() {
    const value = String(el("rr-folder")?.value || "").trim().replace(/\\/g,"/");
    const parts = value.split("/");
    if (parts.some(p => p === ".." || p.startsWith("~"))) throw new Error("Недопустимый путь");
    return parts.filter(p => p && p !== ".").join("/");
  }
  const keyFor = (name, subfolder=folder) => ARCHIVE + "/" + (subfolder ? subfolder + "/" : "") + name;
  async function countDownloads() {
    const state = (await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY] || {};
    ledgerSnapshot = state;
    downloaded = Object.values(state).filter(x=>x.state==="downloaded").length;
    failed = Object.values(state).filter(x=>x.state==="failed").length;
    return state;
  }
  function bestFrame() {
    const sorted = [...frames.values()].filter(x =>
      Number.isFinite(Number(x.count))&&Number.isFinite(Number(x.folders))&&
      (x.host==="docviewer.yandex.ru"||x.host==="docviewer.360.yandex.ru"||
       Boolean(x.archiveName)))
      .sort((a,b) => (b.count+b.folders)-(a.count+a.folders));
    return sorted[0] || null;
  }
  function render() {
    if (!panel) return;
    const entries = [...frames.values()];
    const candidateFiles = bestFrame()?.count || 0;
    const candidateFolders = bestFrame()?.folders || 0;
    const candidateUnknown = bestFrame()?.unknown || 0;
    const best = bestFrame();
    if(el("rr-harvest")){
      el("rr-harvest").textContent=harvestLoopActive ? "Остановить после текущего файла" :
        scanning ? "Повторить поиск файлов" : best ? "Скачать всё" : "Найти файлы RAR";
      // Search is read-only: never lock the only button just because a
      // scan acknowledgment from the background worker has stalled.
      el("rr-harvest").disabled=running&&!harvestLoopActive;
    }
    if(el("rr-harvest-count")){
      const h=harvestSummary;
      el("rr-harvest-count").textContent=h ?
        ("Нажатий: "+h.clickCount+" · команд клика: "+h.clickDispatchCount+
        " · загрузок начато: "+h.downloadStartedCount+
        " · завершено: "+h.downloadCompletedCount+
        " · тайм-аутов (120 с): "+h.timedOutCount+
        " · расхождений: "+h.mismatchCount+
        " · без привязки: "+h.unmatchedDownloadCount+
         " · повторов: "+(h.retryClickCount||0)+
        " · не нажато: "+h.notClickedCount+" · можно повторить: "+h.safeToRetryLookupCount+" · позиций учтено: "+h.requested+"/"+h.total) :
        "Один клик на файл; ожидание до 120 секунд. Сохраняются исходные каталоги и реальные имена Яндекса.";
    }
    if (el("rr-status")) el("rr-status").textContent = scanning ?
      "Сканирование кадров браузера..." :
      (best ? ("Файлов: "+candidateFiles+" · папок: "+candidateFolders+" · неопределённых: "+candidateUnknown+
        " · источник: "+best.host) :
      ("Файлы не обнаружены. Ответили кадров: "+entries.length));
    if (el("rr-found")) el("rr-found").textContent = best ?
      "Примеры: "+(best.names || []).slice(0,10).join(", ") :
      "Открой веб-просмотрщик RAR и нажми «Скачать всё».";
    if (el("rr-progress")) el("rr-progress").textContent = (progress ? progress+" · " : "") +
      notice; // Old strict-ledger counts must not masquerade as new verified downloads.
    if (el("rr-log")) el("rr-log").textContent = events.slice(0,9).join("\n") ||
      "Ищу файлы открытого RAR. Подтверждение от пользователя не требуется.";
    if (el("rr-resume-status")){
      const p=tree?.complete ? RarRescuePlan.pendingDirectories(tree,ledgerSnapshot) : null;
      el("rr-resume-status").textContent = p?.ok ?
        ("По журналу: "+p.skipped+" готово, "+p.pending+
          " можно запрашивать, "+p.blockedCount+
          " требуют проверки, "+p.collisionBlockedCount+
          " с конфликтующими именами отложены. Ожидают решения: "+p.held+".") :
        (p?.error||"Манифест не готов");
      if(lastResumeReview?.active){
        el("rr-resume-status").textContent += " Есть незавершённая загрузка: "+
          (lastResumeReview.active.path||"другая вкладка")+
          ", состояние "+lastResumeReview.active.state+".";
      }
    }
    if(el("rr-review"))el("rr-review").disabled=running||!tree?.complete;
    if (el("rr-tree")) el("rr-tree").textContent = !tree ? "Манифест дерева ещё не построен." :
      ("Карта: " + Object.keys(tree.directories || {}).length + " каталогов, " +
       Object.keys(tree.files || {}).length + " файлов; объектов просмотрено: " +
       (tree.observedObjects || 0) + "/" + EXPECTED_OBJECTS +
       "; непроверенных объектов: " + (tree.unknown || []).length +
       "; проблем: " + (tree.issues || []).length +
       "; состояние: " + (tree.complete ? "полное" : tree.scanned ? "частичное" : "обход не завершён"));
    if (el("rr-scan")) el("rr-scan").disabled = running;
    if (el("rr-pilot")) el("rr-pilot").disabled = running || !best;
    if (el("rr-check")) el("rr-check").disabled = running || !best;
    if (el("rr-stop")) el("rr-stop").disabled = !running;
    if (el("rr-inventory")) el("rr-inventory").disabled = running || !bestFrame();
    if (el("rr-resume")) el("rr-resume").disabled = running || !best ||
      !tree?.complete || !tree?.nestedPilot?.passed || Boolean(approved);
    if (el("rr-nested")) el("rr-nested").disabled = running || !bestFrame() ||
      !approved || !tree?.complete || approved.frameId !== bestFrame().frameId ||
      tree?.nestedPilot?.passed===true;
    if (el("rr-nested-plan")) {
      const plan = tree?.complete ? RarRescuePlan.selectTwo(tree,ledgerSnapshot) : null;
      el("rr-nested-plan").textContent = tree?.nestedPilot?.passed ?
        "Приёмка вложенных путей завершена: " + tree.nestedPilot.files.join(" | ") :
        plan?.ok ? "Будут проверены: "+plan.files.map(x=>x.sourcePath).join(" | ")+
          (plan.sameBasename?" (одинаковые имена)":" (разные папки)") :
        plan?.error ? "Подбор вложенных файлов: "+plan.error : "";
    }
    if (el("rr-recover")) el("rr-recover").disabled = running || !bestFrame() ||
      !approved || !tree || !tree.scanned || !tree.complete ||
      tree.nestedPilot?.passed !== true ||
      approved.frameId !== bestFrame().frameId;
    if (el("rr-report")) el("rr-report").disabled = !tree;
    if (el("rr-native")) el("rr-native").disabled = running || !best;
    if (el("rr-import")) el("rr-import").disabled = running;
    if (el("rr-empty")) el("rr-empty").disabled = running || !tree || !tree.scanned;
  }

  function mount() {
    if (panel) { panel.remove(); panel=null; return; }
    panel=document.createElement("section");
    panel.id="rr-recovery-panel";
    panel.innerHTML=[
      '<header><strong>RAR Rescue</strong><button id="rr-close" title="Закрыть">×</button></header>',
      '<p>Автоматический обход архива, загрузка и возобновление.</p>',
      '<div class="rr-actions"><button id="rr-harvest">Скачать всё</button></div>',
      '<p id="rr-harvest-count"></p>',
      '<p id="rr-progress" role="status"></p>',
      '<pre id="rr-log"></pre>',
      '<small>Структура исходных каталогов сохраняется. Максимум 120 секунд ожидания на файл, потом следующий без повторного клика. Все конфликты записываются полными путями.</small>'
    ].join("");
    document.body.append(panel);
    el("rr-close").addEventListener("click",()=>{panel.remove();panel=null;});
    el("rr-harvest").addEventListener("click",()=>{
      if(harvestLoopActive){stopRequested=true;show("Остановка после текущего запроса.");}
      else if(scanning||!bestFrame())void scan();
      else void harvestAll();
    });
    render();
    void scan();
  }

  async function scan() {
    viewerFrameAlias=null;
    if (running) return;
    frames.clear();
    const requestId=String(Date.now())+"-"+Math.random().toString(36).slice(2);
    scanId=requestId;
    scanning=true;approved=null;
    show("Ищу файлы открытого RAR. Если поиск завис — нажми «Повторить поиск файлов».");
    let scanError="";
    let timer=null;
    try {
      // A stalled MV3 response channel must not keep the one-click UI
      // blocked for the full 45-second background guard. Sensor reports
      // arrive as independent events and remain valid after this deadline.
      await Promise.race([
        send({kind:"RR_SCAN_FRAMES",requestId}),
        new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(Error("Веб-просмотрщик не ответил за 6 секунд")),6000);
        })
      ]);
    }catch(error){
      scanError=String(error?.message||error).slice(0,180);
    }finally{
      if(timer!==null)clearTimeout(timer);
    }
    await sleep(1200);
    if(scanId!==requestId)return; // A newer manual scan superseded this one.
    scanning=false;
    const best=bestFrame();
    notice=best ?
      ("Найден веб-просмотрщик RAR: "+best.count+" файлов, "+best.folders+
       " папок. Нажми «Скачать всё», чтобы продолжить сохранённую очередь.") :
      ("Файлы RAR не обнаружены"+(scanError?": "+scanError:"")+
       ". Открой архив в просмотрщике и нажми «Найти файлы RAR». "+
       "Журнал предыдущих загрузок сохранён.");
    show(notice);
  }

  async function choosePilot(frame) {
    const roster=await inFrame(frame.frameId,{kind:"RR_SENSOR_LIST"});
    const items=Array.isArray(roster.items) ? roster.items : [];
    return items.find(x=>x.kind==="file" && x.name==="README.TXT") ||
      items.find(x=>x.kind==="file" && /\.(?:txt|xml|htm|html|md|ini|log)$/i.test(x.name)) ||
      null;
  }

  async function inspectReadme() {
    if(running) return;
    const frame=bestFrame();
    if(!frame) {notice="Сначала найди файлы.";render();return;}
    try {folder=folderValue();}
    catch(error){notice=error.message;render();return;}
    running=true;render();
    try {
      const target=await choosePilot(frame);
      if(!target) throw new Error("В текущей папке нет текстового файла для сопоставления.");
      const match=await send({kind:"RR_INSPECT_DOWNLOADS",filename:target.name,folder});
      lastInspection=match.matches || [];
      const recovered=lastInspection.find(x =>
        x.state==="complete" && x.bytes>0 && x.savedToRecovery && x.exists!==false);
      if(recovered) {
        const action=await inFrame(frame.frameId,{
          kind:"RR_SENSOR_TRIGGER",name:target.name,pilot:true,inspectOnly:true
        });
        if(!action.ok || !action.mode || !Number.isFinite(action.slots)) {
          notice="Скачанный файл в Recovery найден, но расположение кнопки Яндекса изменилось. Новые загрузки пока заблокированы.";
          show(notice);return;
        }
        const ledger=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY] || {};
        ledger[keyFor(target.name)] = {
          state:"downloaded",bytes:recovered.bytes,time:new Date().toISOString(),
          method:"verified-browser-history",downloadId:recovered.id
        };
        await chrome.storage.local.set({[LEDGER_KEY]:ledger});
        approved={frameId:frame.frameId,mode:action.mode,slots:action.slots,
          checkedFile:target.name,host:frame.host};
        await countDownloads();
        notice="Браузер подтвердил "+target.name+" в папке Recovery ("+
          recovered.bytes+" байт). Теперь можно скачивать остальные файлы текущей папки.";
      } else if(lastInspection.some(x=>x.state==="complete" && x.bytes>0)) {
        notice="Браузер действительно скачал "+target.name+
          ", но файл оказался НЕ в папке YandexRARRecovery. Запусти пробную загрузку из панели — очередь пока не разблокирована.";
      } else if(lastInspection.length) {
        notice="Загрузка в истории браузера найдена, но не завершена: "+
          lastInspection.map(x=>x.state+(x.error?"/"+x.error:"")).join(", ");
      } else {
        notice="В последних загрузках браузера нет подтверждённого "+target.name+
          ". Используй «Проверить новую загрузку» либо пришли диагностику.";
      }
      show(notice);
    } catch(error){notice="Ошибка учёта: "+error.message;show(notice);}
    finally {running=false;render();}
  }

  const START_WAIT_MS=8*60*1000;
  const COMPLETE_WAIT_MS=30*60*1000;
  async function chooseFreshPilot(frame) {
    const roster=await inFrame(frame.frameId,{kind:"RR_SENSOR_LIST"});
    const ledger=await countDownloads();
    const files=(roster.items||[]).filter(row=>row.kind==="file");
    const priority=["LOG4J.XML","INDEX.HTM","README.TXT"];
    const candidates=files.filter(row=>/\.(?:txt|xml|htm|html|md|log|ini)$/i.test(row.name))
      .sort((a,b)=>{
        const ia=priority.indexOf(a.name),ib=priority.indexOf(b.name);
        return (ia<0?100:ia)-(ib<0?100:ib);
      });
    return candidates.find(row=>
      !["downloaded","armed","awaiting","needs-review"].includes(
        ledger[keyFor(row.name)]?.state
      ))||null;
  }

  function clearPending(outcome) {
    if(!pending)return;
    const task=pending;
    pending=null;
    clearTimeout(task.timer);
    clearInterval(task.pollTimer);
    task.resolve(outcome);
  }
  function markDownloadStarted(token) {
    if(!pending || pending.token!==token || pending.started)return;
    pending.started=true;
    clearTimeout(pending.timer);
    pending.timer=setTimeout(()=>{
      if(pending?.token===token)clearPending({
        state:"needs-review",started:true,
        reason:"The browser has not completed the transfer after 30 minutes; will NOT click again."
      });
    },COMPLETE_WAIT_MS);
    show("Загрузка зарегистрирована браузером. Жду фактического завершения — повторных запросов не будет.");
  }
  function createPending(token,key) {
    if(pending)throw new Error("Previous transfer has not been resolved");
    let finish;
    const waiting=new Promise(resolve=>{finish=resolve;});
    const task={token,key,started:false,createdAt:Date.now(),resolve:finish,timer:null,pollTimer:null};
    pending=task;
    task.timer=setTimeout(()=>{
      if(pending?.token===token)clearPending({
        state:"needs-review",started:false,
        reason:"Yandex response delay exceeded 8 minutes; outcome unknown, no automatic retry."
      });
    },START_WAIT_MS);
    task.pollTimer=setInterval(()=>{
      if(!pending || pending.token!==token)return;
      progress="Ожидание "+Math.floor((Date.now()-task.createdAt)/1000)+" с — повторного запроса нет";
      render();
      void send({kind:"RR_CHECK_ATTEMPT",token,key}).then(result=>{
        if(!pending || pending.token!==token)return;
        if(result.browserState==="in_progress")markDownloadStarted(token);
        if(result.state==="downloaded" || result.state==="needs-review") {
          clearPending({state:result.state,reason:result.reason,
            bytes:result.bytes,started:task.started});
        }
      }).catch(()=>{/* Keep waiting. An unavailable service worker is not proof of failure. */});
    },6000);
    return waiting;
  }
  async function downloadOnce(frameId,name,pilotMode,approvedMode,subfolder=folder) {
    const token=String(Date.now())+"-"+Math.random().toString(36).slice(2);
    const key=keyFor(name,subfolder);
    const wait=createPending(token,key);
    let armed=false,clicked=false,action=null;
    try {
      await send({kind:"RR_ARM",token,key,folder:subfolder,filename:name});
      armed=true;
      action=await inFrame(frameId,{
        kind:"RR_SENSOR_TRIGGER",name,pilot:pilotMode,allowLocate:Boolean(subfolder),
        verifyNavigation:treePhase==="nested-pilot" || treePhase==="download",
        expectedFolder:subfolder,
        approvedMode:approvedMode?.mode||null,
        approvedSlots:approvedMode?.slots??null
      });
      lastAutoCommand={
        name:action.name,clicked:action.clicked,mode:action.mode,slots:action.slots,
        userActivationAtClick:action.userActivationAtClick,syntheticClick:action.syntheticClick
      };
      if(!action.clicked)throw new Error(action.error||"Встроенная кнопка скачивания не нажата");
      clicked=true;
      await send({kind:"RR_CLICK_SENT",token});
      show("Запрошен "+name+" один раз. Яндекс может отвечать несколько минут; новые клики заблокированы.");
    } catch(error) {
      if(armed) {
        if(clicked)await send({kind:"RR_MARK_UNKNOWN",token}).catch(()=>{});
        else await send({kind:"RR_RELEASE",token}).catch(()=>{});
      }
      clearPending({state:clicked?"needs-review":"failed",reason:String(error.message||error),
        started:false});
      return {state:clicked?"needs-review":"failed",reason:String(error.message||error),
        mode:action?.mode,slots:action?.slots,started:false};
    }
    const result=await wait;
    if(result.state!=="downloaded") {
      // Keep background watcher alive: a late Yandex response may still arrive.
      await send({kind:"RR_MARK_UNKNOWN",token}).catch(()=>{});
    }
    await countDownloads();
    render();
    return {...result,mode:action.mode,slots:action.slots};
  }

  async function retryDownload(frameId,name,pilotMode,approvedMode,_maxRetries,subfolder=folder) {
    // NO blind retries. A timed-out Yandex request often downloads minutes
    // later, which caused README (2).TXT through README (6).TXT.
    // Distinguish a confirmed transfer error from an unknown outcome.
    const result=await downloadOnce(frameId,name,pilotMode,approvedMode,subfolder);
    if(result.state!=="downloaded") {
      show(name+": "+result.state+" — повторное скачивание запрещено без подтверждения состояния.");
      try {
        const recent=await send({kind:"RR_INSPECT_DOWNLOADS",filename:name,folder:subfolder});
        lastInspection=recent.matches||[];
      }catch(_){}
    }
    return result;
  }

  async function pilot() {
    if (running) return;
    const frame=bestFrame();
    if (!frame) return scan();
    try {folder=folderValue();}
    catch(error) {notice=error.message;render();return;}
    running=true;stopRequested=false;approved=null;render();
    try {
      const target=await chooseFreshPilot(frame);
      if (!target) throw new Error("Все подходящие пробные файлы уже скачаны или ожидают проверки. Повторный запрос заблокирован.");
      show("Пробный файл: "+target.name+". Запускаю его кнопку скачивания внутри строки.");
      const result=await retryDownload(frame.frameId,target.name,true,null,1);
      if (result.state==="downloaded") {
        approved={frameId:frame.frameId,mode:result.mode,slots:result.slots,
          checkedFile:target.name,host:frame.host};
        notice="Пробная загрузка завершена в браузере. Проверь файл и затем запускай текущую папку.";
        show("Пилот успешен: "+target.name+" · "+result.mode+", "+result.slots+" кнопок.");
      } else {
        notice="Пилот не подтверждён: "+(result.reason||result.state)+". Скопируй диагностику.";
        show(notice);
      }
    } catch(error) {notice="Ошибка теста: "+error.message;show(notice);}
    finally {running=false;progress="";render();}
  }

  async function nativePilot(){
    if(running)return;
    const frame=bestFrame();
    if(!frame){notice="Сначала найди файлы в корне.";show(notice);return;}
    try {
      folder=folderValue();
      if(folder)throw new Error("Для теста README открой корень и оставь поле пути пустым.");
      const target=await choosePilot(frame);
      if(!target || target.name!=="README.TXT")throw new Error("README.TXT не найден.");
    }catch(error){notice=String(error.message||error);show(notice);return;}
    running=true;stopRequested=false;nativeVerified=false;render();
    const token=String(Date.now())+"-"+Math.random().toString(36).slice(2);
    const key=keyFor("README.TXT","");
    let armed=false;
    const waiting=createPending(token,key);
    try {
      await send({kind:"RR_ARM",token,key,folder:"",filename:"README.TXT"});
      armed=true;
      notice="Нажми штатную кнопку «Скачать» у README.TXT только ОДИН раз. Жди результата: до 8 минут на начало загрузки. Повторно не нажимай.";
      show(notice);
      const result=await waiting;
      if(result.state!=="downloaded") {
        await send({kind:"RR_MARK_UNKNOWN",token}).catch(()=>{});
        const recent=await send({kind:"RR_INSPECT_DOWNLOADS",filename:"README.TXT",folder:""});
        lastInspection=recent.matches||[];
      }
      if(result.state==="downloaded"){
        nativeVerified=true;
        notice="Нативная загрузка завершена: "+(result.bytes||0)+
          " байт. Для массовой очереди нужно отдельно подтвердить автоматический режим.";
      }else{
        notice="Исход нативной загрузки не подтверждён. Новые клики блокируются, чтобы не создавать дубли. "+String(result.reason||result.state);
      }
      await countDownloads();
      show(notice);
    }catch(error){
      if(armed)await send({kind:"RR_MARK_UNKNOWN",token}).catch(()=>{});
      clearPending({state:"needs-review",reason:String(error.message||error)});
      notice="Не удалось проверить загрузку: "+String(error.message||error);show(notice);
    }finally{running=false;progress="";render();}
  }


  async function importTreeFile(file){
    if(running)return;
    if(file.size>5*1024*1024){notice="JSON больше 5 МБ: импорт отменён.";show(notice);return;}
    try{
      const raw=JSON.parse(await file.text());
      const clean=RarRescueManifest.importManifest(raw,RarRescueUtils);
      tree=clean;
      await saveTree();
      notice="Карта загружена: 1199 файлов, 87 папок. Обход повторять не нужно. Статусы загрузок сброшены в pending, реальные скачивания проверяем отдельно.";
      show(notice);
    }catch(error){notice="Импорт отклонён: "+String(error.message||error);show(notice);}
  }

  /* Persistent archive manifest. Paths come from the crawler's verified
   * directory stack, never from a manually entered folder name. */
  async function saveTree() {
    if(!tree)return;
    tree.updatedAt=new Date().toISOString();
    if(!scope)throw Error("Archive scope is unknown");
    await chrome.storage.local.set({[scope.treeStorageKey]:tree});
    render();
  }

  function newTree() {
    return {
      schema:"rar-rescue-tree-v2",
      scopeId:scope.scopeId,archive:scope.archiveName,
      expectedObjects:null,
      createdAt:new Date().toISOString(),
      scanned:false,complete:false,observedObjects:0,
      directories:Object.create(null),files:Object.create(null),
      completedSubtrees:[],unknown:[],issues:[]
    };
  }

  function storeDirectory(event) {
    if(!tree || !event || event.event!=="directory")throw new Error("Invalid directory scan event");
    const path=String(event.path||"");
    const safePart=value=>typeof value==="string"&&
      value.length>0&&value.length<=200&&
      ![".","..","__proto__","prototype","constructor"].includes(value.toLowerCase())&&
      !/[/\\\\\u0000-\u001f]/.test(value);
    if(path&&path.split("/").some(part=>!safePart(part)))
      throw new Error("Unsafe archive directory identifier");
    const items=event.items||[];
    if(Object.prototype.hasOwnProperty.call(tree.directories,path)) {
      const prior=tree.directories[path].entries||[];
      const normalize=rows=>rows.map(x=>x.kind+"|"+x.name).sort().join("\n");
      if(normalize(prior)!==normalize(items))
        throw new Error("Checkpoint directory changed: "+path);
      tree.observedObjects=Number(event.discoveredObjects)||tree.observedObjects;
      return; // The same directory is revalidated, not double-counted.
    }
    tree.directories[path]={
      path,entries:items.map(i=>({name:i.name,kind:i.kind})),
      empty:items.length===0,scannedAt:new Date().toISOString()
    };
    for(const row of items){
      const source=(path?path+"/":"")+row.name;
      if(!safePart(row.name)){
        tree.issues.push({path:source,reason:"unsafe-entry-name"});
        continue;
      }
      if(row.kind==="file") {
        let destination;
        try {destination=RarRescueUtils.relative(path,row.name,archiveRoot());}
        catch(error) {
          tree.issues.push({path:source,reason:"invalid-output-path"});
          continue;
        }
        const previous=tree.files[source];
        tree.files[source]={
          sourcePath:source,folder:path,name:row.name,destination,
          status:previous?.status||"pending",
          attempts:previous?.attempts||0,
          bytes:previous?.bytes||0,
          error:previous?.error||""
        };
      } else if(row.kind==="unknown"){
        tree.unknown.push({path:source,icons:(row.iconClasses||[]).slice(0,6)});
      }
    }
    for(const duplicate of event.duplicates||[]){
      tree.issues.push({path:(path?path+"/":"")+duplicate,reason:"duplicate-entry-name"});
    }
    tree.observedObjects=Number(event.discoveredObjects)||tree.observedObjects;
  }

  function finalizeTree(event){
    tree.scanned=true;
    const expectedObjects=Object.values(tree.directories)
      .reduce((n,dir)=>n+(dir.entries||[]).length,0);
    const expectedPaths=Object.keys(tree.directories).length;
    if(Number(event.objects)!==expectedObjects||Number(event.paths)!==expectedPaths)
      tree.issues.push({path:"",reason:"checkpoint-count-mismatch",
        expectedObjects,expectedPaths,actualObjects:event.objects,actualPaths:event.paths});
    tree.observedObjects=expectedObjects;
    const reserved=new Map();
    for(const [source,record] of Object.entries(tree.files)){
      const dest=record.destination.toLowerCase();
      if(reserved.has(dest)&&reserved.get(dest)!==source) {
        tree.issues.push({path:source,reason:"output-name-collision",
          collidesWith:reserved.get(dest)});
      } else reserved.set(dest,source);
    }
    // Different source folders can normalize to the same Windows path too.
    const mappedDirs=new Map();
    for(const path of Object.keys(tree.directories)){
      if(!path)continue;
      let target;
      try {target=RarRescueUtils.relative(path,"_directory_marker_",archiveRoot()).toLowerCase();}
      catch(_){tree.issues.push({path,reason:"unsafe-directory-name"});continue;}
      if(mappedDirs.has(target)&&mappedDirs.get(target)!==path) {
        tree.issues.push({path,reason:"directory-name-collision",
          collidesWith:mappedDirs.get(target)});
      } else mappedDirs.set(target,path);
    }
    tree.expectedObjects=tree.observedObjects;
    tree.complete=tree.unknown.length===0&&tree.issues.length===0;
    if(tree.complete){
      try{RarRescueManifest.importManifest(tree,RarRescueUtils,scope);}
      catch(error){
        tree.complete=false;
        tree.issues.push({path:"",reason:"structural-integrity",
          detail:String(error.message||error).slice(0,180)});
      }
    }
  }

  async function inventoryPass(frameId,checkpoint){
    let item=await inFrame(frameId,{
      kind:"RR_SENSOR_CRAWL_BEGIN",archiveName:verifiedViewerTitle,checkpoint
    });
    if(!item.ok)throw new Error(item.error||"Не удалось подтвердить корень архива");
    storeDirectory(item);await saveTree();
    for(let iteration=0;iteration<MAX_CRAWL_EVENTS&&!stopRequested;iteration++){
      item=await inFrame(frameId,{kind:"RR_SENSOR_CRAWL_STEP"});
      if(!item.ok)throw new Error((item.path||"")+" "+(item.error||"Ошибка навигации"));
      if(item.event==="complete"){
        finalizeTree(item);
        await saveTree();
        notice=tree.complete?
          "Карта готова: "+Object.keys(tree.files).length+" файлов и "+
            (Object.keys(tree.directories).length-1)+" папок.":
          "Обход закончился, но есть неподтверждённые элементы: "+
            tree.unknown.length+" неизвестных, "+tree.issues.length+" ошибок.";
        show(notice);
        return true;
      }
      if(item.event==="directory"){
        storeDirectory(item);await saveTree();
        progress="Обход: "+(item.path||"[корень]")+
          " · объектов: "+tree.observedObjects;
        render();
      }
      if(item.event==="returned"){
        const closed=String(item.completedPath||"");
        if(!closed||!Object.prototype.hasOwnProperty.call(tree.directories,closed))
          throw new Error("Crawler returned an unknown completed folder");
        if(!tree.completedSubtrees.includes(closed)){
          tree.completedSubtrees.push(closed);
          await saveTree();
        }
      }
      if(item.event==="skipped"){
        progress="Продолжение: пропущена уже пройденная ветка "+item.path;
        render();
      }
      if(iteration===MAX_CRAWL_EVENTS-1)
        throw new Error("Превышен технический предел шагов обхода");
    }
    notice="Обход приостановлен. Завершённые ветки сохранены для продолжения.";
    show(notice);
    return false;
  }

  // Older betas stored partial directories without completion markers.
  // Recheck these rows instead of guessing which legacy folders were complete.
  function canResumeTree(){
    if(!tree||tree.schema!=="rar-rescue-tree-v2"||tree.scopeId!==scope.scopeId||
       tree.complete||tree.scanned||!tree.directories||
       !Object.prototype.hasOwnProperty.call(tree.directories,""))return false;
    if(!Array.isArray(tree.completedSubtrees))tree.completedSubtrees=[];
    return !(tree.unknown||[]).length&&
      !(tree.issues||[]).some(row=>row.reason!=="crawl-interrupted");
  }
  function recoverableCrawlError(message){
    // Never repeat a potentially successful click. Read-only viewer restarts
    // require a checkpoint-verified CRAWL_BEGIN before any next folder entry.
    return /Receiving end does not exist|Could not establish connection|No frame with id|frame was removed|viewer disconnected|Viewer did not respond|viewer was replaced|Viewer stopped responding|folder-row-not-visible/i.test(message);
  }
  async function inventoryTree(){
    if(running)return;
    const frame=bestFrame();
    if(!frame){notice="Открой корень архива и найди файлы.";show(notice);return;}
    if(!scope)throw Error("Archive scope is unknown");
    running=true;stopRequested=false;treePhase="inventory";treeFrame=frame.frameId;
    let resumeAttempt=0,cleanRebuild=0;
    let useCheckpoint=canResumeTree();
    try{
      for(let attempt=0;attempt<4&&!stopRequested;attempt++){
        const restoring=useCheckpoint&&canResumeTree();
        const previousTree=tree;
        if(restoring){
          tree.directories=Object.assign(Object.create(null),tree.directories);
          tree.files=Object.assign(Object.create(null),tree.files);
          tree.issues=[];
        }else tree=newTree();
        const checkpoint=restoring?{
          directories:tree.directories,completedSubtrees:tree.completedSubtrees
        }:null;
        show(restoring?
          "Продолжаю сохранённую карту: завершённые папки пропускаются.":
          "Обхожу дерево папок с корня RAR.");
        // Save only after BEGIN verifies the viewer root. A disconnected new
        // scan cannot overwrite an old checkpoint with an empty manifest.
        try{
          await inventoryPass(frame.frameId,checkpoint);
          return;
        }catch(error){
          const message=String(error.message||error);
          const hasRoot=Object.prototype.hasOwnProperty.call(tree.directories||{},"");
          if(!hasRoot&&previousTree&&previousTree!==tree)
            tree=previousTree;
          if(stopRequested)break;
          if(restoring&&/checkpoint[- ]directory[- ]changed/i.test(message)){
            if(cleanRebuild>=1)throw error;
            cleanRebuild++;
            useCheckpoint=false;
            show("Структура архива изменилась; перепроверяю корень и строю новую карту.");
            await sleep(600);
            continue;
          }
          if(recoverableCrawlError(message)&&resumeAttempt<2){
            resumeAttempt++;
            useCheckpoint=canResumeTree();
            show("Временный сбой обхода: "+message.slice(0,120)+
              ". Переподключаю просмотрщик и продолжаю карту ("+resumeAttempt+"/2).");
            await sleep(resumeAttempt*1200);
            continue;
          }
          throw error;
        }
      }
      if(stopRequested){
        show("Обход остановлен. Карта сохранена, продолжу с незавершённых папок.");
        return;
      }
      throw Error("Не удалось завершить обход после ограниченного числа попыток");
    }catch(error){
      if(!tree)tree=newTree();
      tree.issues.push({path:"",reason:"crawl-interrupted",
        detail:String(error.message||error).slice(0,200)});
      await saveTree();
      const detail=String(error.message||error);
      notice=/archive-root-unverified/i.test(detail)?
        "Не удалось подтвердить корень архива. Вернись в корень RAR и нажми «Скачать всё» ещё раз. Карта сохранена.":
        "Обход приостановлен: "+detail+
          ". Завершённые ветки сохранены; повтори запуск в корне RAR.";
      show(notice);
    }finally{
      running=false;stopRequested=false;progress="";treePhase="";treeFrame=null;
      render();
    }
  }

  /* Bounded acceptance: exactly two source files from two different nested
   * directories. Uses the same full-tree crawler as actual recovery, but
   * never starts another file until the browser confirmed a previous one.
   */
  function directoryManifestForNavigator(){
    if(!tree?.complete || !tree.directories)throw new Error("Нет завершённой карты архива");
    return Object.values(tree.directories).map(dir=>({
      path:dir.path,entries:dir.entries.map(x=>({name:x.name,kind:x.kind}))
    }));
  }
  async function beginKnownPathNavigation(frameId){
    const nav=await inFrame(frameId,{kind:"RR_SENSOR_NAV_START",
      directories:directoryManifestForNavigator(),archiveName:verifiedViewerTitle});
    if(!nav.ok)throw new Error(nav.error||"Не удалось подтвердить корень");
    show("Адресная навигация: проверен корень; ненужные каталоги обходиться не будут.");
    return nav;
  }
  async function goToKnownDirectory(frameId,path){
    const nav=await inFrame(frameId,{kind:"RR_SENSOR_NAV_GOTO",path});
    if(!nav.ok)throw new Error(nav.error||"Неизвестная ошибка перехода");
    return nav;
  }

  async function restoreApproval(){
    if(running || approved || !tree?.complete || !tree.nestedPilot?.passed)return;
    const frame=bestFrame();
    if(!frame){notice="Открой корень архива и нажми «Найти файлы».";show(notice);return;}
    running=true;render();
    try{
      const files=tree.nestedPilot.files;
      if(!Array.isArray(files) || files.length!==2 ||
         tree.nestedPilot.status!=="passed")
        throw new Error("Нет двух завершённых доказательств вложенных путей");
      const ledger=await countDownloads();
      const folders=new Set();
      for(const path of files){
        const entry=tree.files?.[path],record=ledger["Disk-2.rar/"+path];
        if(!entry || !entry.folder || !record ||
           record.state!=="downloaded" || Number(record.bytes)<=0 ||
           record.target!==entry.destination)
          throw new Error("Не подтверждена загрузка исходного файла: "+path);
        folders.add(entry.folder);
      }
      if(folders.size!==2)throw new Error("Контрольные файлы должны быть из разных каталогов");
      await beginKnownPathNavigation(frame.frameId);
      const target=await choosePilot(frame);
      if(!target)throw new Error("Не обнаружен контрольный файл в корне");
      const inspected=await inFrame(frame.frameId,{
        kind:"RR_SENSOR_TRIGGER",name:target.name,pilot:true,inspectOnly:true
      });
      if(!inspected.ok || inspected.clicked || inspected.mode!=="label" ||
         inspected.slots!==2)
        throw new Error("Кнопка скачивания Яндекса изменилась; нужно новое подтверждение");
      approved={frameId:frame.frameId,mode:inspected.mode,slots:inspected.slots,
        checkedFile:"verified prior nested files",host:frame.host};
      notice="Восстановлено подтверждение двух ранее загруженных вложенных файлов. "+
        "Манифест и кнопка Яндекса проверены без нового скачивания.";
      show(notice);
    }catch(error){
      notice="Невозможно безопасно восстановить допуск: "+String(error.message||error);
      show(notice);
    }finally{running=false;render();}
  }

  async function acceptNestedPaths(){
    if(running || !approved || !tree?.complete || tree.nestedPilot?.passed)return;
    const frame=bestFrame();
    if(!frame || frame.frameId!==approved.frameId){
      notice="Открой корень этого RAR и заново проверь автоматический клик.";
      show(notice);return;
    }
    let plan;
    try{
      const ledger=await countDownloads();
      plan=RarRescuePlan.selectTwo(tree,ledger);
      if(!plan.ok)throw new Error(plan.error||"Нет подходящих файлов");
    }catch(error){
      notice="Двухфайловая проверка не запущена: "+error.message;show(notice);
      return;
    }
    running=true;stopRequested=false;treePhase="nested-pilot";treeFrame=frame.frameId;
    nestedPilotPlan=plan;
    const confirmed=[];
    tree.nestedPilot={passed:false,status:"running",startedAt:new Date().toISOString(),
      files:plan.files.map(f=>f.sourcePath),sameBasename:plan.sameBasename,verifiedPaths:[]};
    await saveTree();
    notice="Адресно проверяю только две нужные папки: "+
      plan.files.map(f=>f.folder).join(" и ")+".";
    show(notice);
    try{
      await beginKnownPathNavigation(frame.frameId);
      for(const selected of plan.files){
        if(stopRequested)throw new Error("Остановлено пользователем после текущего файла");
        const nav=await goToKnownDirectory(frame.frameId,selected.folder);
        progress="Нужная папка: "+selected.folder+" ("+nav.entered+
          " входов, "+nav.backed+" возвратов)";render();
        const row=tree.directories[selected.folder]?.entries.find(x=>
          x.name===selected.name && x.kind==="file");
        if(!row)throw new Error("Файл отсутствует в манифесте: "+selected.sourcePath);
        const ledger=await countDownloads();
        const key="Disk-2.rar/"+selected.sourcePath;
        if(["downloaded","armed","awaiting","needs-review"].includes(ledger[key]?.state))
          throw new Error("Этот путь уже обработан или ожидает проверки: "+selected.sourcePath);
        const result=await retryDownload(frame.frameId,selected.name,false,approved,1,selected.folder);
        const record=tree.files[selected.sourcePath];
        record.attempts=(record.attempts||0)+1;
        record.status=result.state==="downloaded"?"downloaded":"needs-review";
        record.bytes=Number(result.bytes)||0;
        record.error=result.state==="downloaded"?"":String(result.reason||result.state).slice(0,160);
        await saveTree();
        if(result.state!=="downloaded")
          throw new Error("Не подтверждено скачивание "+selected.sourcePath+": "+
            String(result.reason||result.state).slice(0,120));
        confirmed.push(selected.sourcePath);
        tree.nestedPilot.verifiedPaths=[...confirmed];
        await saveTree();
        show("Подтверждено "+selected.sourcePath+" ("+(result.bytes||0)+" байт)");
        if(confirmed.length<plan.files.length)await sleep(1500);
      }
      if(confirmed.length!==NESTED_PILOT_LIMIT)
        throw new Error("Не получены оба контрольных файла");
      const returned=await goToKnownDirectory(frame.frameId,"");
      tree.nestedPilot={
        passed:true,status:"passed",files:plan.files.map(x=>x.sourcePath),
        sameBasename:plan.sameBasename,confirmedAt:new Date().toISOString(),
        navigation:{entered:returned.entered,backed:returned.backed,
          verified:returned.verified}
      };
      await saveTree();
      notice="Два вложенных файла получены. Открыто "+
        returned.entered+" каталогов вместо полного обхода 87. "+
        "Проверен возврат в корень. Полная очередь доступна.";
      show(notice);
    }catch(error){
      tree.nestedPilot={...tree.nestedPilot,passed:false,status:"needs-review",
        error:String(error.message||error).slice(0,220)};
      await saveTree();
      notice="Двухфайловая приёмка остановлена: "+error.message+
        ". Проверенные файлы остаются в журнале; не повторяй их скачивание.";
      show(notice);
    }finally{
      running=false;stopRequested=false;treePhase="";treeFrame=null;
      nestedPilotPlan=null;progress="";
      await countDownloads();render();
    }
  }

  async function reviewPending(){
    if(running||!tree?.complete)return;
    running=true;render();
    try{
      await reconcileBeforeResume();
      const p=RarRescuePlan.pendingDirectories(tree,ledgerSnapshot);
      if(!p.ok)throw new Error(p.error);
      notice="Проверка завершена: "+p.skipped+" подтверждено, "+
        p.pending+" доступно для очереди, "+p.blockedCount+
        " спорных и "+p.collisionBlockedCount+" связанных по имени отложены."+
        (lastResumeReview?.active ?
          " Есть незавершённый запрос — дождись его перед продолжением.":"");
      show(notice);
    }catch(error){notice="Проверка приостановлена: "+String(error.message||error);show(notice);}
    finally{running=false;render();}
  }

  async function reconcileBeforeResume(){
    // This call never clicks a file or deletes existing downloads. When
    // a request older than eight minutes is unconfirmed, background may
    // defer its watcher while preserving the needs-review ledger entry.
    const result=await send({kind:"RR_PREPARE_RESUME"});
    lastResumeReview=result;
    const ledger=await countDownloads();
    let changed=false;
    for(const [path,file] of Object.entries(tree.files||{})){
      const entry=ledger["Disk-2.rar/"+path];
      if(entry?.state==="downloaded" &&
         (file.status!=="downloaded" || Number(file.bytes)!==Number(entry.bytes))){
        file.status="downloaded";
        file.bytes=Number(entry.bytes)||0;
        file.error="";
        changed=true;
      } else if(entry && ["armed","awaiting","needs-review","failed"].includes(entry.state) &&
        file.status!=="needs-review"){
        file.status="needs-review";
        file.error=String(entry.reason||entry.state).slice(0,160);
        changed=true;
      }
    }
    if(changed)await saveTree();
    return result;
  }

  async function exportAutomaticHarvestReport(){
    const report=await send({kind:"RR_HARVEST_REPORT",scope});
    const ledger=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY]||{};
    const legacy=Object.entries(ledger)
      .filter(([path])=>scope?.sourceKey==="yandex-public:/d/_RSlWomRWmty1w"&&path.startsWith("Disk-2.rar/"))
      .map(([path,item])=>({
        sourcePath:path.slice("Disk-2.rar/".length),
        state:item.state,bytes:Number(item.bytes)||0,
        reason:String(item.reason||"").slice(0,160)
      }));
    const diagnostics=(await chrome.storage.local.get("rr_last_command_failure_v1"))
      .rr_last_command_failure_v1||null;
    const merged={
      ...report,transportDiagnostic:diagnostics,
      archive:scope?.archiveName||null,scopeId:scope?.scopeId||null,
      sourceManifest:{objects:tree?.observedObjects||null,
        files:Object.keys(tree?.files||{}).length,
        directories:Object.keys(tree?.directories||{}).length,
        sourcePaths:Object.keys(tree?.files||{})},
      legacyRequests:legacy,
      note:"Each click has a separate ID and a 120-second wait. Browser downloads and actual full paths are recorded independently. Mismatches never stop the queue."
    };
    const uri=URL.createObjectURL(new Blob([JSON.stringify(merged,null,2)],
      {type:"application/json;charset=utf-8"}));
    const link=document.createElement("a");
    link.href=uri;link.download=scope?.reportName||"RAR-Rescue-download-log.json";
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(uri),30000);
  }

  async function harvestAll(){
    if(harvestLoopActive)return;
    if(running)return;
    harvestLoopActive=true;
    stopRequested=false;
    render();
    let captureBegun=false;
    let clicked=0,skipped=0,failedActions=0;
    try{
      // Discover arbitrary files and directories from the web viewer.
      if(!bestFrame())await scan();
      await ensureArchiveScope();
      if(!tree?.complete)await inventoryTree();
      if(!tree?.complete||tree.scopeId!==scope.scopeId)
        throw new Error("Не удалось построить полную карту этого RAR. Скачивание не начато.");
      const frame=bestFrame();
      if(!frame)throw new Error("Просмотрщик Яндекса не найден");
      running=true;treePhase="raw-harvest";treeFrame=frame.frameId;
      const previous=await send({kind:"RR_HARVEST_PLAN",scope});
      const already=new Set(previous.processedSourcePaths||[]);
      const safeRetryPaths=new Set(previous.retryableSourcePaths||[]);
      const groups=new Map();
      for(const file of Object.values(tree.files)){
        // Old strict-ledger "downloaded" states cannot prove the server
        // actually returned the requested file. In raw capture mode visit
        // all discovered members, using only this archive's click ledger.
        // Resume by ONLY skipping requests already recorded in this mode.
        if(already.has(file.sourcePath) && !safeRetryPaths.has(file.sourcePath)){
          skipped++;
          continue;
        }
        const list=groups.get(file.folder)||[];
        list.push(file);
        groups.set(file.folder,list);
      }
      if(!groups.size){
        harvestSummary=await send({kind:"RR_HARVEST_STATUS"});
        notice="Все исходные позиции уже обработаны или ожидают проверки; сохраняю журнал.";
        show(notice);
        await exportAutomaticHarvestReport();
        return;
      }
      await send({kind:"RR_HARVEST_BEGIN",scope,total:Object.keys(tree.files).length});
      captureBegun=true;
      await beginKnownPathNavigation(frame.frameId);
      notice="Карта: "+Object.keys(tree.files).length+" файлов. Последовательная выгрузка, затем безопасные повторы ошибок.";
      show(notice);
      for(let pass=0;pass<3&&!stopRequested;pass++){
        let passGroups=groups;
        if(pass>0){
          await sleep(3000*pass);
          const current=await send({kind:"RR_HARVEST_PLAN",scope});
          const remaining=new Set(current.retryableSourcePaths||[]);
          passGroups=new Map();
          for(const file of Object.values(tree.files)){
            if(!remaining.has(file.sourcePath))continue;
            const list=passGroups.get(file.folder)||[];
            list.push(file);
            passGroups.set(file.folder,list);
          }
        }
        if(!passGroups.size)break;
        const folders=[...passGroups.keys()].sort((a,b)=>a.localeCompare(b));
        if(pass>0)show("Повторный проход "+pass+": "+[...passGroups.values()].reduce((n,a)=>n+a.length,0)+
          " доказанно неудачных позиций");
        for(const dir of folders){
          if(stopRequested)break;
          await goToKnownDirectory(frame.frameId,dir);
          for(const file of passGroups.get(dir)){
          if(stopRequested)break;
          // Preflight may scroll a virtualized directory, without clicking.
          // Do this before the 120-second click deadline starts.
          let preflight;
          try{
            preflight=await inFrame(frame.frameId,{
              kind:"RR_SENSOR_TRIGGER",name:file.name,pilot:false,
              allowLocate:true,verifyNavigation:true,expectedFolder:dir,
              approvedMode:"label",approvedSlots:2,inspectOnly:true
            });
          }catch(error){preflight={ok:false,error:String(error.message||error)};}
          if(!preflight?.ok||!preflight.inspected){
            // Refresh just this known directory; no file clicks are made.
            show("Строка не найдена: "+file.sourcePath+
              ". Повторно открываю каталог (без нажатия на файл).");
            await goToKnownDirectory(frame.frameId,"");
            await goToKnownDirectory(frame.frameId,dir);
            try{
              preflight=await inFrame(frame.frameId,{
                kind:"RR_SENSOR_TRIGGER",name:file.name,pilot:false,
                allowLocate:true,verifyNavigation:true,expectedFolder:dir,
                approvedMode:"label",approvedSlots:2,inspectOnly:true
              });
            }catch(error){preflight={ok:false,error:String(error.message||error)};}
          }
          if(!preflight?.ok||!preflight.inspected){
            const arm=await send({kind:"RR_HARVEST_ARM",folder:file.folder,filename:file.name});
            if(!arm.skipped){
              await send({kind:"RR_HARVEST_LOOKUP_FAILED",folder:file.folder,filename:file.name,
                reason:String(preflight?.error||"file-row-not-visible").slice(0,160)});
              failedActions++;
            }
            show("Не удалось обнаружить строку "+file.sourcePath+
              " — факт отсутствия клика записан, продолжаю остальные файлы.");
            continue;
          }
          const arm=await send({kind:"RR_HARVEST_ARM",folder:file.folder,filename:file.name});
          if(arm.skipped){skipped++;continue;}
          const dispatched=await send({kind:"RR_HARVEST_DISPATCH",folder:file.folder,filename:file.name});
          if(!dispatched.ok)throw new Error(dispatched.error||"Нельзя зафиксировать клик");
          try{
            if(!preflight?.ok||!preflight.inspected)
              throw new Error(preflight?.error||"Не найдена кнопка файла");
            const action=await inFrame(frame.frameId,{
              kind:"RR_SENSOR_TRIGGER",name:file.name,pilot:false,
              allowLocate:false,verifyNavigation:true,expectedFolder:dir,
              approvedMode:"label",approvedSlots:2
            });
            if(!action.clicked)throw new Error(action.error||"Не нажалась кнопка файла");
            const sent=await send({kind:"RR_HARVEST_SENT",folder:file.folder,
              filename:file.name,clicked:true});
            if(!sent.ok)throw new Error(sent.error||"Ошибка подтверждения клика");
            clicked++;
          }catch(error){
            // No re-click, including uncertain browser/frame responses.
            await send({kind:"RR_HARVEST_SENT",folder:file.folder,
              filename:file.name,clicked:false,
              definiteFailure:!preflight?.ok,
              reason:String(error.message||error).slice(0,160)}).catch(()=>{});
            failedActions++;
          }
          // The next file MUST NOT be clicked before Chrome reports a
          // terminal download or exactly 120 seconds have passed.
          let result={state:"waiting",remainingMs:120000};
          let lastCountRefresh=0;
          harvestWaitingSource=file.sourcePath;
          while(result.state==="waiting"){
            const wakeVersion=harvestWake.snapshot();
            result=await send({kind:"RR_HARVEST_CHECK",folder:file.folder,filename:file.name});
            if(!result.ok)throw new Error(result.error||"Нет учёта загрузки");
            const seconds=Math.max(0,Math.ceil((result.remainingMs||0)/1000));
            progress="Нажатий: "+clicked+"; ожидание: "+seconds+" с; "+
              "последний исходный путь: "+archiveRoot()+"/"+file.sourcePath+
              "; результат: "+result.state;
            if(Date.now()-lastCountRefresh>2200||result.state!=="waiting"){
              harvestSummary=await send({kind:"RR_HARVEST_STATUS"});
              render();lastCountRefresh=Date.now();
            }
            if(result.state!=="waiting")break;
            // Download events arrive in the extension service worker even
            // when the page's short polling timers have been throttled.
            // Wait for the terminal browser event, or poll if it is lost.
            await harvestWake.wait(wakeVersion,Math.max(1,Math.min(850,result.remainingMs||850)));
          }
          harvestWaitingSource=null;
          if(result.state==="timed_out")show("120 секунд истекли для "+file.sourcePath+
            ". Повторного клика нет. Перехожу к следующему файлу.");
          else if(result.state==="interrupted")show("Загрузка прервана для "+file.sourcePath+
            ". Причину сохраняю в журнал; очередь продолжается.");
          else if(result.state==="not-clicked")show("Кнопка не нажалась: "+file.sourcePath+
            ". Пропускаю, журнал сохраняется.");
          }
        }
      }
      notice=stopRequested ?
        "Остановлено после текущего запроса. Нажми «Скачать всё» для продолжения." :
        "Все исходные позиции пройдены. Яндекс может ещё присылать файлы; журнал сохраняется.";
      show(notice);
      try{await goToKnownDirectory(frame.frameId,"");}catch(_){}
    }catch(error){
      notice="Сбор остановлен: "+String(error.message||error)+
        ". Уже выгруженное сохранено. Запусти той же кнопкой для продолжения.";
      show(notice);
    }finally{
      if(captureBegun){
        try{
          await send({kind:"RR_HARVEST_STOP"});
          harvestSummary=await send({kind:"RR_HARVEST_STATUS"});
          await exportAutomaticHarvestReport();
        }catch(error){show("Журнал сохранён локально, но экспорт JSON не удался: "+error.message);}
      }
      harvestWaitingSource=null;
      running=false;harvestLoopActive=false;stopRequested=false;treePhase="";treeFrame=null;
      progress="";render();
    }
  }

  async function recoverTree(){
    if(running || !approved || !tree || !tree.scanned || !tree.complete ||
      tree.nestedPilot?.passed!==true)return;
    const frame=bestFrame();
    if(!frame || frame.frameId!==approved.frameId)return;
    // Disable all start buttons BEFORE awaiting reconciliation. Otherwise
    // double-clicks could start two simultaneous navigator/queue runs.
    running=true;stopRequested=false;render();
    let plan;
    try{
      const review=await reconcileBeforeResume();
      if(review.active)throw new Error("Старая загрузка ещё ожидается: "+
        (review.active.path||review.active.state)+
        ". Подожди её завершения или проверь историю браузера.");
      const ledger=await countDownloads();
      plan=RarRescuePlan.pendingDirectories(tree,ledger);
      if(!plan.ok)throw new Error(plan.error+
        (plan.blocked?.length?": "+plan.blocked.slice(0,3).join(", "):""));
    }catch(error){
      notice="Нельзя начинать восстановление: "+String(error.message||error);
      running=false;show(notice);render();return;
    }
    if(plan.pending===0){
      notice="Новых безопасных запросов нет. Не восстановлены/не проверены: "+
        plan.held+". Сохрани JSON-отчёт и проверь эти пути.";
      running=false;show(notice);render();return;
    }
    treePhase="download";treeFrame=frame.frameId;
    notice="Очередь: "+plan.pending+" файлов в "+plan.visitedDirectoryCount+
      " каталогах; готовых: "+plan.skipped+
      "; отложено для проверки: "+plan.blockedCount+
      "; конфликты имён: "+plan.collisionBlockedCount+
      ". Эти файлы не будут повторно запрошены.";
    show(notice);
    try{
      await beginKnownPathNavigation(frame.frameId);
      for(const group of plan.groups){
        if(stopRequested)break;
        const nav=await goToKnownDirectory(frame.frameId,group.path);
        progress="Каталог "+(group.path||"[корень]")+
          " · переходов в папки: "+nav.entered+", возвратов: "+nav.backed;
        render();
        for(const file of group.files){
          if(stopRequested)break;
          const record=tree.files[file.sourcePath];
          if(!record)throw new Error("Нет файла в манифесте: "+file.sourcePath);
          const ledger=await countDownloads();
          const key="Disk-2.rar/"+file.sourcePath;
          const oldState=ledger[key]?.state;
          if(oldState==="downloaded"){
            record.status="downloaded";
            record.bytes=Number(ledger[key]?.bytes)||record.bytes||0;
            record.error="";
            await saveTree();
            continue;
          }
          if(["armed","awaiting","needs-review","failed"].includes(oldState))
            throw new Error("Незавершённый запрос требует проверки: "+file.sourcePath);
          progress="Скачивание "+file.sourcePath;render();
          const result=await retryDownload(frame.frameId,file.name,false,approved,1,file.folder);
          record.attempts=(record.attempts||0)+1;
          record.status=result.state==="downloaded"?"downloaded":
            result.state==="failed"?"failed":"needs-review";
          record.bytes=Number(result.bytes)||0;
          record.error=result.state==="downloaded"?"":String(result.reason||result.state).slice(0,180);
          await saveTree();
          if(result.state!=="downloaded"){
            stopRequested=true;
            notice="Неопределённый исход "+file.sourcePath+
              ". Очередь остановлена без повторного запроса.";
            show(notice);
          }
          if(!stopRequested)await sleep(2500);
        }
      }
      if(stopRequested){
        notice="Восстановление остановлено. Завершённые файлы сохранены в журнале. "+
          "Возобновление начнётся с оставшихся путей.";
        show(notice);
        return;
      }
      const nav=await goToKnownDirectory(frame.frameId,"");
      const counts={downloaded:0,failed:0,pending:0,needsReview:0};
      for(const file of Object.values(tree.files)){
        if(file.status==="downloaded")counts.downloaded++;
        else if(file.status==="failed")counts.failed++;
        else if(file.status==="needs-review")counts.needsReview++;
        else counts.pending++;
      }
      tree.lastRecovery={
        finishedAt:new Date().toISOString(),counts,
        navigation:{entered:nav.entered,backed:nav.backed,verified:nav.verified},
        directoriesWithWork:plan.visitedDirectoryCount,
        initiallyPending:plan.pending
      };
      await saveTree();
      notice="Проход завершён. Получено: "+counts.downloaded+
        ", ошибок: "+counts.failed+", требуют проверки: "+counts.needsReview+
        ", ожидают: "+counts.pending+". Каталогов открыто: "+nav.entered+
        " вместо полного обхода дерева.";
      show(notice);
    }catch(error){
      (tree.recoveryIssues||=[]).push({
        reason:"recovery-interrupted",detail:String(error.message||error).slice(0,180)
      });
      await saveTree();
      notice="Восстановление остановлено: "+error.message+
        ". Проверенные файлы не перезаписываются; если просмотрщик во вложенной папке — вернись в корень.";
      show(notice);
    }finally{
      running=false;stopRequested=false;treePhase="";treeFrame=null;progress="";
      await countDownloads();render();
    }
  }

  async function createEmptyDirectories(){
    if(!tree || !tree.scanned || running)return;
    if(typeof window.showDirectoryPicker!=="function"){
      notice="Этот браузер не поддерживает выбор каталога для создания пустых папок. Их пути есть в JSON-отчёте.";
      show(notice);return;
    }
    let chosen;
    try {
      // Important: call showDirectoryPicker from the original user click,
      // before any await or Chrome API request consumes transient activation.
      chosen=await window.showDirectoryPicker({id:"rar-rescue-output",mode:"readwrite"});
    }catch(error){
      notice=error.name==="AbortError"?"Выбор папки отменён":
        "Нет доступа к папке: "+String(error.message||error);
      show(notice);return;
    }
    if(chosen.name!=="Disk-2.rar"){
      notice="Выбери именно Downloads/YandexRARRecovery/Disk-2.rar. Ничего не создано.";
      show(notice);return;
    }
    const dirs=Object.values(tree.directories)
      .filter(item=>item.path && item.empty)
      .sort((a,b)=>a.path.split("/").length-b.path.split("/").length);
    let created=0;
    try {
      for(const entry of dirs){
        let handle=chosen;
        for(const segment of entry.path.split("/")){
          if(!segment || segment==="." || segment==="..")throw new Error("Недопустимое имя папки");
          handle=await handle.getDirectoryHandle(RarRescueUtils.component(segment),{create:true});
        }
        created++;
      }
      tree.emptyDirectoriesCreated=created;
      await saveTree();
      notice="Пустые папки восстановлены: "+created+
        ". Другие каталоги создаются браузером при загрузке файлов.";
      show(notice);
    }catch(error){
      notice="Создано "+created+" пустых папок, затем ошибка: "+String(error.message||error);
      show(notice);
    }
  }

  function exportReport(){
    if(!tree)return;
    const p=tree.complete ? RarRescuePlan.pendingDirectories(tree,ledgerSnapshot) : null;
    const data={
      ...tree,
      exportedAt:new Date().toISOString(),
      resumeReport:p?.ok ? {
        downloaded:p.skipped,safePending:p.pending,
        needsReview:p.blockedCount,nameCollisionHeld:p.collisionBlockedCount,
        accounted:p.accounted,held:p.held,
        unresolved:p.blocked,
        nameCollisionPaths:p.collisionBlocked,
        note:"Unresolved and name-collision files were NOT retried. A late Yandex download may still arrive."
      } : null,
      note:"Browser download completion is not the same as CRC/SHA verified content. Empty directory paths are listed in directories and may require explicit creation."
    };
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],
      {type:"application/json;charset=utf-8"}));
    const anchor=document.createElement("a");
    anchor.href=url;anchor.download="Disk-2.rar-recovery-report.json";
    anchor.hidden=true;
    document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(url),12000);
    show("Скачан отчёт со всеми исходными путями, статусами файлов и пустыми каталогами.");
  }

  async function diagnostics() {
    const report={
      tool:"RAR Rescue v0.12",
      targetArchive:"Disk 2.rar",
      frames:[...frames.values()].map(x=>({
        id:x.frameId,host:x.host,count:x.count,folders:x.folders,unknown:x.unknown,
        sampleNames:(x.names||[]).slice(0,8),example:x.example||null,
        iconSamples:(x.iconSamples||[]).slice(0,16)
      })),
      approved:approved?{mode:approved.mode,slots:approved.slots,host:approved.host}:null,
      nativeVerified,
      lastAutoCommand,
      lastInspection,
      nestedPilot:tree?.nestedPilot||null,
      resumeReview:lastResumeReview ? {
        reconciled:lastResumeReview.reconciled,deferred:lastResumeReview.deferred,
        active:lastResumeReview.active,unresolvedCount:lastResumeReview.unresolvedCount,
        unresolved:lastResumeReview.unresolved
      }:null,
      resumePlan:tree?.complete ? (()=>{
        const p=RarRescuePlan.pendingDirectories(tree,ledgerSnapshot);
        return p.ok ? {pending:p.pending,downloaded:p.skipped,
          needsReview:p.blockedCount,nameConflicts:p.collisionBlockedCount,
          unresolved:p.blocked.slice(0,12),collisionPaths:p.collisionBlocked.slice(0,12)} :
          {error:p.error};
      })() : null,
      treeSummary: tree ? {scanned:tree.scanned,complete:tree.complete,objects:tree.observedObjects,
        directories:Object.keys(tree.directories||{}).length,files:Object.keys(tree.files||{}).length,
        issues:(tree.issues||[]).slice(0,10),unknown:(tree.unknown||[]).slice(0,10)} : null,
      downloaded,failed,events:events.slice(0,15)
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report,null,2));
      show("Диагностика скопирована: только имена и структура, без токенов и ссылок.");
    }catch(error){notice="Не удалось скопировать: "+error.message;render();}
  }

  chrome.runtime.onMessage.addListener(message=>{
    if(!message || !message.kind)return;
    if(message.kind==="RR_HARVEST_TERMINAL"){
      if(harvestLoopActive&&scope?.scopeId===message.scopeId&&
         harvestWaitingSource===message.sourcePath&&
         ["complete","interrupted"].includes(message.state))
        harvestWake.notify();
      return;
    }
    if(message.kind==="RR_TOGGLE")mount();
    if(message.kind==="RR_SENSOR_REPORT" && message.requestId===scanId) {
      frames.set(String(message.frameId),message);
      render();
    }
    if(message.kind==="RR_STARTED" && pending && message.token===pending.token) {
      markDownloadStarted(message.token);
    }
    if(message.kind==="RR_RESULT") {
      if(pending && message.token===pending.token) clearPending(message);
      else {
        // Yandex sometimes delivers a file after the earlier wait timed out.
        // Such a late success must be recorded but must never trigger re-click.
        notice="Запоздалый результат: "+(message.key||"файл")+" — "+message.state;
        if(!scope && tree && message.key?.startsWith("Disk-2.rar/")) {
          const path=message.key.slice("Disk-2.rar/".length);
          if(tree.files[path]) {
            tree.files[path].status=message.state==="downloaded"?"downloaded":"needs-review";
            tree.files[path].bytes=message.bytes||0;
            void saveTree().catch(()=>{});
          }
        }
      }
      void countDownloads().catch(()=>{});
      show("Результат загрузки: "+message.state+
        " ("+(message.bytes||0)+" байт)"+(message.state==="downloaded"?"":": "+message.reason));
    }
  });
  void countDownloads().catch(()=>{});
  // The per-archive map is loaded on the first one-button run. Never load
  // the legacy global Disk-2 map into an unrelated public archive.
})();
