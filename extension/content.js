/* Main-frame controller for Yandex RAR Rescue v0.5.
   Never reads account cookies, document payloads or signed download URLs. */
(() => {
  "use strict";
  const LEDGER_KEY = "rr_ledger";
  const TREE_KEY = "rr_tree_v05";
  const EXPECTED_OBJECTS = 1286;
  const ARCHIVE = "Disk-2.rar";
  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
  let panel = null, folder = "", frames = new Map(), scanId = "", scanning = false;
  let approved = null, pending = null, running = false, stopRequested = false;
  let events = [], downloaded = 0, failed = 0;
  let notice = "Используем названия файлов и кнопки на скриншотах DevTools.";
  let progress = "";
  let lastInspection = [];
  let tree = null;
  let treePhase = "";
  let treeFrame = null;

  function show(message) {
    events.unshift(new Date().toLocaleTimeString() + " " + message);
    events = events.slice(0,30);
    render();
  }
  const el = id => panel && panel.querySelector("#"+id);
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || !response.ok) throw new Error(response?.error || "Расширение не ответило");
    return response;
  }
  async function inFrame(id,payload) {
    return send({kind:"RR_FRAME_CALL",frameId:id,payload});
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
    downloaded = Object.values(state).filter(x=>x.state==="downloaded").length;
    failed = Object.values(state).filter(x=>x.state==="failed").length;
    return state;
  }
  function bestFrame() {
    const sorted = [...frames.values()].filter(x => x.count > 0)
      .sort((a,b) => b.count - a.count);
    return sorted[0] || null;
  }
  function render() {
    if (!panel) return;
    const entries = [...frames.values()];
    const candidateFiles = bestFrame()?.count || 0;
    const candidateFolders = bestFrame()?.folders || 0;
    const candidateUnknown = bestFrame()?.unknown || 0;
    const best = bestFrame();
    if (el("rr-status")) el("rr-status").textContent = scanning ?
      "Сканирование кадров браузера..." :
      (best ? ("Файлов: "+candidateFiles+" · папок: "+candidateFolders+" · неопределённых: "+candidateUnknown+
        " · источник: "+best.host) :
      ("Файлы не обнаружены. Ответили кадров: "+entries.length));
    if (el("rr-found")) el("rr-found").textContent = best ?
      "Примеры: "+(best.names || []).slice(0,10).join(", ") :
      "Нужно открыть содержимое Диск 2.rar и нажать «Найти файлы».";
    if (el("rr-progress")) el("rr-progress").textContent = (progress ? progress+" · " : "") +
      notice+" · успешно: "+downloaded+", ошибки: "+failed;
    if (el("rr-log")) el("rr-log").textContent = events.slice(0,9).join("\n") || "Ожидаю проверки.";
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
    if (el("rr-recover")) el("rr-recover").disabled = running || !bestFrame() ||
      !approved || !tree || !tree.scanned || !tree.complete ||
      approved.frameId !== bestFrame().frameId;
    if (el("rr-report")) el("rr-report").disabled = !tree;
    if (el("rr-empty")) el("rr-empty").disabled = running || !tree || !tree.scanned;
  }

  function mount() {
    if (panel) { panel.remove(); panel=null; return; }
    panel=document.createElement("section");
    panel.id="rr-recovery-panel";
    panel.innerHTML = [
      '<header><strong>RAR Rescue v0.5</strong><button id="rr-close" title="Закрыть">×</button></header>',
      '<p>Диск 2.rar — 1286 объектов, включая папки. Полное восстановление сохраняет пути и ведёт журнал.</p>',
      '<div class="rr-actions"><button id="rr-scan">1. Найти файлы</button><button id="rr-check">2. Учесть скачанный README</button></div>',
      '<div class="rr-actions"><button id="rr-pilot">3. Проверить новую загрузку</button></div>',
      '<p id="rr-status" role="status"></p><p id="rr-found"></p>',
      '<label>Путь открытой папки внутри архива (в корне оставь пустым)<input id="rr-folder" type="text" placeholder="например, HELP" autocomplete="off"></label>',
      '<div class="rr-actions"><button id="rr-inventory">4. Обойти все папки</button><button id="rr-stop">Остановить</button></div>',
      '<div class="rr-actions"><button id="rr-recover">5. Скачать всё со структурой</button><button id="rr-report">Отчёт JSON</button></div>',
      '<div class="rr-actions"><button id="rr-empty">Создать пустые каталоги</button></div>',
      '<p id="rr-tree"></p>',
      '<p id="rr-progress" role="status"></p>',
      '<div class="rr-actions"><button id="rr-copy">Скопировать диагностику</button></div>',
      '<pre id="rr-log"></pre>',
      '<small>Сначала нажми «Обойти все папки». Загрузка всего дерева разрешается только если обход завершён, неизвестных объектов нет, число объектов сходится с 1286 и подтверждён тестовый файл. При прерывании вернись в корень архива. EXE/CMD никогда не запускаются.</small>'
    ].join("");
    document.body.append(panel);
    el("rr-close").addEventListener("click",()=>{panel.remove();panel=null;});
    el("rr-scan").addEventListener("click",()=>{void scan();});
    el("rr-check").addEventListener("click",()=>{void inspectReadme();});
    el("rr-pilot").addEventListener("click",()=>{void pilot();});
    el("rr-inventory").addEventListener("click",()=>{void inventoryTree();});
    el("rr-recover").addEventListener("click",()=>{void recoverTree();});
    el("rr-report").addEventListener("click",()=>{exportReport();});
    el("rr-empty").addEventListener("click",()=>{void createEmptyDirectories();});
    el("rr-stop").addEventListener("click",()=>{stopRequested=true;show("Остановить после текущего файла.");});
    el("rr-copy").addEventListener("click",()=>{void diagnostics();});
    el("rr-folder").addEventListener("change",()=>{approved=null;render();});
    render();
    void scan();
  }

  async function scan() {
    if (running) return;
    frames.clear();scanId=String(Date.now())+"-"+Math.random().toString(36).slice(2);
    scanning=true;approved=null;render();
    try { await send({kind:"RR_SCAN_FRAMES",requestId:scanId}); }
    catch(error) { notice="Ошибка сканирования: "+error.message;show(notice); }
    await sleep(1800);
    scanning=false;
    const best=bestFrame();
    notice=best ?
      ("Обнаружено "+best.count+" файлов в окне Яндекса. Теперь нажми «Проверить README.TXT».") :
      "Список файлов не получен. Проверь доступ расширения к встроенному docviewer и обнови страницу.";
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

  function clearPending(outcome) {
    if (!pending) return;
    const task=pending;pending=null;
    clearTimeout(task.timer);
    task.resolve(outcome);
  }

  async function downloadOnce(frameId,name,pilotMode,approvedMode,subfolder=folder) {
    const token=String(Date.now())+"-"+Math.random().toString(36).slice(2);
    let done;
    const wait = new Promise(resolve=>{done=resolve;});
    pending={token,started:false,resolve:done,timer:null};
    const armTimer=()=> {
      if (!pending || pending.token!==token) return;
      pending.timer=setTimeout(()=>clearPending({
        state:"timeout",reason:"No browser download was reported"
      }),25000);
    };
    armTimer();
    let action;
    try {
      await send({kind:"RR_ARM",token,key:keyFor(name,subfolder),folder:subfolder,filename:name});
      action=await inFrame(frameId,{
        kind:"RR_SENSOR_TRIGGER",name,pilot:pilotMode,
        approvedMode:approvedMode?.mode || null,
        approvedSlots:approvedMode?.slots ?? null
      });
      if (!action.clicked) throw new Error("Встроенная кнопка скачивания не нажата");
      show("Команда скачивания отправлена: "+name+" ("+action.mode+", кнопок: "+action.slots+")");
    } catch(error) {
      clearPending({state:"failed",reason:error.message});
      await send({kind:"RR_RELEASE",token}).catch(()=>{});
      return {state:"failed",reason:error.message};
    }
    const result=await wait;
    if (result.state==="timeout") await send({kind:"RR_RELEASE",token}).catch(()=>{});
    await countDownloads();
    render();
    return { ...result, mode:action.mode, slots:action.slots };
  }

  async function retryDownload(frameId,name,pilotMode,approvedMode,maxRetries,subfolder=folder) {
    for (let attempt=1;attempt<=maxRetries&&!stopRequested;attempt++) {
      progress = name + " · попытка " + attempt + "/" + maxRetries;render();
      const result=await downloadOnce(frameId,name,pilotMode,approvedMode,subfolder);
      if (result.state==="downloaded") return result;
      show(name+": "+result.state+" · "+(result.reason || ""));
      // The Yandex viewer may trigger a download that escaped our onCreated
      // correlation. Before retrying, check browser history for the SAME
      // filename and recovery directory. Otherwise duplicate writes are likely.
      try {
        const recent=await send({kind:"RR_INSPECT_DOWNLOADS",filename:name,folder:subfolder});
        lastInspection=recent.matches || [];
        const active=lastInspection.find(x=>x.ageSeconds<90 && x.state==="in_progress");
        if(active) {
          return {state:"timeout",started:true,reason:"Browser download is still active; retries suspended"};
        }
        const complete=lastInspection.find(x=>
          x.ageSeconds<90 && x.state==="complete" && x.bytes>0 &&
          x.savedToRecovery && x.exists!==false);
        if(complete && result.mode && Number.isFinite(result.slots)) {
          const ledger=(await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY] || {};
          ledger[keyFor(name,subfolder)]={
            state:"downloaded",bytes:complete.bytes,time:new Date().toISOString(),
            method:"recent-browser-reconciliation",downloadId:complete.id
          };
          await chrome.storage.local.set({[LEDGER_KEY]:ledger});
          await countDownloads();
          show("Подтверждено по истории браузера: "+name+" ("+complete.bytes+" байт)");
          return {...result,state:"downloaded",bytes:complete.bytes};
        }
      } catch(error) {show("Не удалось проверить историю: "+error.message);}
      // If browser started a transfer but it never completed, do not start
      // another copy; let the user inspect/stop the stalled browser transfer.
      if (result.state==="timeout" && result.started) return result;
      if (/BLOCKED|DANGEROUS|USER_CANCELED|DENIED|permission/i.test(result.reason || "")) return result;
      if (attempt<maxRetries) await sleep(Math.min(20000,2000*Math.pow(2,attempt)));
    }
    return {state:"failed",reason:"retry limit"};
  }

  async function pilot() {
    if (running) return;
    const frame=bestFrame();
    if (!frame) return scan();
    try {folder=folderValue();}
    catch(error) {notice=error.message;render();return;}
    running=true;stopRequested=false;approved=null;render();
    try {
      const target=await choosePilot(frame);
      if (!target) throw new Error("В этой папке нет README.TXT или другого небольшого текстового файла.");
      show("Пробный файл: "+target.name+". Запускаю его кнопку скачивания внутри строки.");
      const result=await retryDownload(frame.frameId,target.name,true,null,2);
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

  /* Persistent archive manifest. Paths come from the crawler's verified
   * directory stack, never from a manually entered folder name. */
  async function saveTree() {
    if(!tree)return;
    tree.updatedAt=new Date().toISOString();
    await chrome.storage.local.set({[TREE_KEY]:tree});
    render();
  }

  function newTree() {
    return {
      schema:"rar-rescue-tree-v1",
      archive:"Диск 2.rar",
      expectedObjects:EXPECTED_OBJECTS,
      createdAt:new Date().toISOString(),
      scanned:false,complete:false,observedObjects:0,
      directories:{},files:{},unknown:[],issues:[]
    };
  }

  function storeDirectory(event) {
    if(!tree || !event || event.event!=="directory")throw new Error("Invalid directory scan event");
    const path=String(event.path||"");
    if(Object.prototype.hasOwnProperty.call(tree.directories,path)) {
      tree.issues.push({path,reason:"duplicate-directory-visit"});
      return;
    }
    const items=event.items||[];
    tree.directories[path]={
      path,entries:items.map(i=>({name:i.name,kind:i.kind})),
      empty:items.length===0,scannedAt:new Date().toISOString()
    };
    for(const row of items){
      const source=(path?path+"/":"")+row.name;
      if(row.kind==="file") {
        let destination;
        try {destination=RarRescueUtils.relative(path,row.name);}
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
    tree.observedObjects=Number(event.objects)||tree.observedObjects;
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
      try {target=RarRescueUtils.relative(path,"_directory_marker_").toLowerCase();}
      catch(_){tree.issues.push({path,reason:"unsafe-directory-name"});continue;}
      if(mappedDirs.has(target)&&mappedDirs.get(target)!==path) {
        tree.issues.push({path,reason:"directory-name-collision",
          collidesWith:mappedDirs.get(target)});
      } else mappedDirs.set(target,path);
    }
    tree.complete=tree.observedObjects===EXPECTED_OBJECTS &&
      tree.unknown.length===0 && tree.issues.length===0;
  }

  async function inventoryTree(){
    if(running)return;
    const frame=bestFrame();
    if(!frame){notice="Открой корень архива и найди файлы.";show(notice);return;}
    running=true;stopRequested=false;treePhase="inventory";treeFrame=frame.frameId;
    tree=newTree();await saveTree();
    notice="Строю дерево папок. Не переключай папки вручную во время обхода.";
    show(notice);
    try {
      let item=await inFrame(frame.frameId,{kind:"RR_SENSOR_CRAWL_BEGIN"});
      if(!item.ok)throw new Error(item.error||"Не удалось подтвердить корень архива");
      storeDirectory(item);await saveTree();
      for(let iteration=0;iteration<EXPECTED_OBJECTS*3 && !stopRequested;iteration++){
        item=await inFrame(frame.frameId,{kind:"RR_SENSOR_CRAWL_STEP"});
        if(!item.ok)throw new Error((item.path||"")+" "+(item.error||"Ошибка навигации"));
        if(item.event==="complete") {
          finalizeTree(item);
          await saveTree();
          notice=tree.complete ?
            "Все "+EXPECTED_OBJECTS+" объектов учтены. Можно запускать загрузку с исходной структурой." :
            "Обход завершён, но состав архива не подтверждён полностью. Проверь отчёт: "+
            tree.observedObjects+"/"+EXPECTED_OBJECTS+", неизвестных: "+
            tree.unknown.length+", ошибок: "+tree.issues.length+".";
          show(notice);return;
        }
        if(item.event==="directory"){
          storeDirectory(item);await saveTree();
          progress="Обход: "+(item.path||"[корень]")+
            " · объектов: "+tree.observedObjects+"/"+EXPECTED_OBJECTS;
          render();
        }
        if(iteration===EXPECTED_OBJECTS*3-1)throw new Error("Превышен лимит этапов обхода");
      }
      notice="Обход прерван. Карта сохранена частично. Для нового запуска вернись в корень RAR.";
      show(notice);
    } catch(error) {
      tree.issues.push({path:"",reason:"crawl-interrupted",detail:String(error.message||error).slice(0,200)});
      await saveTree();
      notice="Остановлено: "+error.message+
        ". Частичная карта сохранена. Вернись в корень архива.";
      show(notice);
    } finally {
      running=false;stopRequested=false;progress="";treePhase="";treeFrame=null;render();
    }
  }

  async function recoverTree(){
    if(running || !approved || !tree || !tree.scanned || !tree.complete)return;
    const frame=bestFrame();
    if(!frame||frame.frameId!==approved.frameId)return;
    running=true;stopRequested=false;treePhase="download";treeFrame=frame.frameId;
    notice="Скачиваю файлы по исходным относительным путям. Оставь просмотрщик открытым.";
    show(notice);
    try {
      let item=await inFrame(frame.frameId,{kind:"RR_SENSOR_CRAWL_BEGIN"});
      if(!item.ok)throw new Error(item.error||"Не открыт корень RAR");
      for(let iteration=0;iteration<EXPECTED_OBJECTS*3 && !stopRequested;iteration++){
        if(item.event==="directory"){
          const dir=tree.directories[item.path];
          if(!dir)throw new Error("Каталог отсутствует в манифесте: "+item.path);
          const expected=dir.entries.map(v=>v.kind+"|"+v.name).sort();
          const actual=(item.items||[]).map(v=>v.kind+"|"+v.name).sort();
          if(JSON.stringify(expected)!==JSON.stringify(actual))
            throw new Error("Содержимое изменилось: "+(item.path||"[корень]"));
          for(const entry of item.items||[]){
            if(stopRequested)break;
            if(entry.kind!=="file")continue;
            const original=(item.path?item.path+"/":"")+entry.name;
            const record=tree.files[original];
            if(!record)throw new Error("Файл отсутствует в манифесте: "+original);
            const local=await countDownloads();
            if(local[keyFor(entry.name,item.path)]?.state==="downloaded") {
              record.status="downloaded";
              await saveTree();continue;
            }
            progress=original+" · восстановление";render();
            const result=await retryDownload(frame.frameId,entry.name,false,approved,3,item.path);
            record.attempts=(record.attempts||0)+1;
            record.status=result.state==="downloaded"?"downloaded":
              result.state==="timeout"?"needs-review":"failed";
            record.bytes=Number(result.bytes)||0;
            record.error=result.state==="downloaded"?"":String(result.reason||result.state).slice(0,180);
            await saveTree();
            if(result.state==="timeout" && result.started){
              stopRequested=true;
              notice="Загрузка "+original+" не завершилась. Дальнейшие запросы остановлены.";show(notice);
            }
            if(!stopRequested)await sleep(700);
          }
        }
        if(stopRequested)break;
        item=await inFrame(frame.frameId,{kind:"RR_SENSOR_CRAWL_STEP"});
        if(!item.ok)throw new Error((item.path||"")+" "+(item.error||"Ошибка перехода"));
        if(item.event==="complete"){
          const counts={downloaded:0,failed:0,pending:0,needsReview:0};
          for(const file of Object.values(tree.files)){
            if(file.status==="downloaded")counts.downloaded++;
            else if(file.status==="failed")counts.failed++;
            else if(file.status==="needs-review")counts.needsReview++;
            else counts.pending++;
          }
          tree.lastRecovery={finishedAt:new Date().toISOString(),counts};
          await saveTree();
          notice="Проход завершён. Получено: "+counts.downloaded+
            ", ошибок: "+counts.failed+", требуют проверки: "+counts.needsReview+
            ", ещё не обработано: "+counts.pending+
            ". Скачай JSON-отчёт с путями.";
          show(notice);
          return;
        }
        if(iteration===EXPECTED_OBJECTS*3-1)throw new Error("Превышен лимит этапов восстановления");
      }
      notice="Восстановление остановлено. Уже полученные файлы остаются в каталоге загрузок; вернись в корень для продолжения.";
      show(notice);
    } catch(error){
      tree.issues.push({path:"",reason:"recovery-interrupted",detail:String(error.message||error).slice(0,180)});
      await saveTree();
      notice="Восстановление остановлено: "+error.message+
        ". Подробности в JSON. Не удаляй уже скачанные файлы.";
      show(notice);
    } finally {
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
    const data={
      ...tree,
      exportedAt:new Date().toISOString(),
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
      tool:"RAR Rescue v0.5",
      targetArchive:"Disk 2.rar",
      frames:[...frames.values()].map(x=>({
        id:x.frameId,host:x.host,count:x.count,folders:x.folders,unknown:x.unknown,
        sampleNames:(x.names||[]).slice(0,8),example:x.example||null,
        iconSamples:(x.iconSamples||[]).slice(0,16)
      })),
      approved:approved?{mode:approved.mode,slots:approved.slots,host:approved.host}:null,
      lastInspection,
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
    if(message.kind==="RR_TOGGLE")mount();
    if(message.kind==="RR_SENSOR_REPORT" && message.requestId===scanId) {
      frames.set(String(message.frameId),message);
      render();
    }
    if(message.kind==="RR_STARTED" && pending && message.token===pending.token) {
      pending.started=true;
      clearTimeout(pending.timer);
      const token=pending.token;
      pending.timer=setTimeout(()=>{
        if(pending && pending.token===token)clearPending({
          state:"timeout",reason:"Browser download exceeded 3 minutes",started:true
        });
      },180000);
      show("Браузер начал загрузку. Ожидаю сохранения файла.");
    }
    if(message.kind==="RR_RESULT" && pending && message.token===pending.token) {
      clearPending(message);
      show("Результат загрузки: "+message.state+
        " ("+(message.bytes||0)+" байт)"+(message.state==="downloaded"?"":": "+message.reason));
    }
  });
  void countDownloads().catch(()=>{});
  void chrome.storage.local.get(TREE_KEY).then(data=>{
    tree=data[TREE_KEY] || null;render();
  }).catch(()=>{});
})();
