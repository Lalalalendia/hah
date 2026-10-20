# RAR Rescue v0.13 — одна кнопка «Скачать всё»

**Лимит на файл: 120 секунд**, затем следующий путь без повторного клика. Браузерное завершение `complete` или `interrupted` разрешает перейти раньше. Запоздалые файлы после 120 секунд всё равно учитываются по идентификатору `downloadId`.

**Установка:** сохрани прежний JSON, распакуй ZIP в уже установленную папку расширения и нажми «Перезагрузить» на `browser://extensions`. Открой корень публичного `Диск 2.rar` на Яндекс Диске; единственная кнопка — **«Скачать всё»**. Во время обхода она превращается в «Остановить после текущего файла». Не закрывай вкладку, пока идёт сбор.

**Результат:** `Загрузки/Disk-2.rar/<исходные каталоги>/<реальное имя Яндекса>`, без `_unattributed`, `YandexRARRecovery` и других дополнительных папок. При запросе `100000`, если Яндекс вернул `100000E1`, сохраняем `100000E1` и записываем оба полных пути. Если источник файла не установлен достоверно, файл помещается в корень `Disk-2.rar` без ложной привязки к другому каталогу. Существующие файлы не перезаписываются (`uniquify`).

**Учёт:** `clickCount` (подтверждённые клики), `clickDispatchCount` (выданные команды), `downloadStartedCount`, `downloadCompletedCount`, `timedOutCount`, `mismatchCount`, `unmatchedDownloadCount`. Клики и загрузки — независимые счётчики; после тайм-аута исходный путь не запрашивается повторно. Возобновление сохраняет старый журнал v0.12 и пропускает уже нажатые позиции.

**Журнал:** `Disk-2.rar-download-log.json` автоматически выгружается после остановки и после завершения обхода. Содержит ожидаемый полный путь, фактическое имя, полный сохранённый путь Chrome, байты, время, ID нажатия и загрузки, статус и достоверность сопоставления. Файлы с несовпадающими именами не блокируют очередь.

**Ограничения:** тесты синтаксиса и модельные сценарии v0.13 должны пройти CI, а реальное скачивание всех 1199 объектов ещё требует приёмки. При очень позднем ответе может быть неизвестна исходная папка; её не угадываем как факт. Chrome Downloads не создаёт пустые каталоги без файла — они остаются перечисленными в манифесте для дальнейшего восстановления. Не запускать EXE/CMD/SH.

**Спецификация:** [RAR-RESCUE-SPEC-01](https://app.notion.com/p/3ff32a84beec81ef9ad5c831b63e66f8).

## v0.14 — Viewer row lookup recovery

A user-supplied complete v0.13 audit recorded 1199 source entries, 706 confirmed row clicks, 493 `not-clicked` failures (`file-row-not-visible`), 2 120-second timeouts and 20 returned-name mismatches. 492 of 493 visibility failures were inside `IHE_PDI/IMAGES`; one was `1000005A/1000018E/10000239/10000245`. Of the 699 browser completions, one was a migrated extension JSON report, leaving 698 archive file completions.

v0.14 preserves durable `rr_harvest_v13` state and never re-clicks confirmed/timed-out/uncertain files. `not-clicked` entries that have no browser download IDs and no click confirmation can be retried safely. A missing virtualized file row triggers one directory re-entry without a file click; persistent missing rows stop the queue rather than issuing hundreds of fictitious download dispatches. Diagnostics capture visible rows and scroller state. Migration-era extension JSON is excluded from counters.

Validation: the actual 1199-entry diagnostic passed Node.js worker-resume tests; real Yandex viewer re-entry behavior still requires live acceptance.
