# RAR Rescue v0.2 — Yandex Disk archive viewer recovery

**Status:** experimental, first live test required. This is not yet a finished recursive downloader.

## Why v0.1 failed

The Yandex Disk parent page embeds the archive viewer in separate iframe documents,
including `docviewer.yandex.ru` and `docviewer.360.yandex.ru`.
Version 0.1 injected event handlers only into `disk.yandex.ru`, so it could
neither see file entries nor capture clicks inside the viewer. Also its
`visibleRows=0` display was hard-coded to depend on manual calibration.

An independent unauthenticated Chrome/Selenium probe showed the two document
viewer frames and that `README.TXT` is not in the parent page DOM.
The actual logged-in viewer's file markup still needs a browser pilot.

## Target

Public file: https://disk.yandex.ru/d/_RSlWomRWmty1w

- `Диск 2.rar`
- 244,374,677 bytes
- SHA-256 of **original RAR**: `2f980815b8267d1ab6cf5c8f1cf867542fa60b9469a3d0c6c4d15c217c577ad5`
- Viewer reports **1,286 objects, including directories**.
- Full archive download returns HTTP 500 on both Windows and GitHub Actions.

## Install in Yandex Browser / Chrome

1. From the latest successful **RAR Rescue Extension Checks** GitHub Action,
   download the `rar-rescue-extension-mv3` artifact (there is a second ZIP
   inside the GitHub artifact; extract **both**).
2. In `browser://extensions` / `chrome://extensions`, enable Developer Mode.
3. Remove/disable v0.1; use **Load unpacked** and choose the folder containing `manifest.json`.
4. Allow site access for `disk.yandex.ru`, `docviewer.yandex.ru`,
   and `docviewer.360.yandex.ru` if the browser asks. Reload the Yandex Disk page.
5. Open the RAR preview and click the extension toolbar icon.

## v0.2 live pilot (about 2 minutes)

1. Click **1. Найти файлы**. The panel shows how many iframe documents answered
   and up to 8 filenames. This works **without calibration**.
2. Click **2. Выбрать файл**. Now click the **name** `README.TXT` on the LEFT side
   of the Yandex RAR viewer (not an extension button).
3. The panel should identify `README.TXT` and the frame hostname.
4. Leave “Путь внутри архива” empty for files in the RAR root.
5. Click **3. Отследить скачивание**. Hover over `README.TXT` in the Yandex list,
   then click the download icon that Yandex shows on hover. If the document opened,
   use its own download action. The extension records the browser's actual result.
6. Check the browser Downloads folder for
   `YandexRARRecovery/Disk-2.rar/README.TXT`. Completion does not prove
   content integrity; open a harmless TXT file and inspect it.

If frame scan or click capture fails, click **Копировать диагностику** and
share the resulting JSON **after reviewing any file names**. No cookies,
headers, OAuth tokens, signed direct URLs, account data or full HTML are read.

**Do not try to run the archive's EXE, BAT, CMD or SH files.**

## Technical design

- `content.js`: the control panel in `disk.yandex.ru` only.
- `frame-sensor.js`: strictly read-only file detection and capture-phase click
   observation across `disk.yandex.ru`, `docviewer.yandex.ru`, and
   `docviewer.360.yandex.ru` frames.
- `background.js`: per-tab forwarding from frame to main panel; browser
   download tracking, guarded output paths and local ledger.
- `common.js`: sanitization and download origin allowlist.
- No network interception, token capture, cookie access, telemetry or servers.
- On-disk output path is under the default browser Downloads directory.
- `downloaded` means Chrome completed a nonempty transfer with a
   consistent size (if known); **it does not mean CRC/SHA verified**.

## Follow-on scope (after this pilot)

1. Capture a safe structural selector for file rows and their *hover download action*
   in each viewer frame, without copying full page HTML.
2. Fully enumerate file and folder metadata (all levels), not only currently
   visible entries. Build expected vs downloaded vs failed manifest.
3. Trigger downloads automatically in sequence; retry 500/504/429 with backoff,
   pause/resume and no redownload of verified files.
4. Preserve directory hierarchy; inspect file-level CRC / sizes if the viewer exposes them.
5. Export failures and partial recovery report, then assemble a new archive.

The current version **does not** automatically download all 1,286 objects.
The number includes folders and must not be treated as a count of downloadable files.
