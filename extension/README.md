# Yandex RAR Rescue v0.4 — recovery of files inside a RAR on Yandex Disk

**Status: experimental.** The user has confirmed that at least one file (`README.TXT`) downloaded from the browser viewer. The extension's download ledger still needs a real-browser acceptance check.

## Target
- Public file: https://disk.yandex.ru/d/_RSlWomRWmty1w
- `Диск 2.rar`: 244,374,677 bytes (about 233 MiB).
- 1,286 objects **including directories**.
- Original archive SHA-256:
  `2f980815b8267d1ab6cf5c8f1cf867542fa60b9469a3d0c6c4d15c217c577ad5`.
- Whole-file GET, HEAD and HTTP Range all returned HTTP 500 on Windows and GitHub Actions.
- Native browser viewer can list the tree, and `README.TXT` is confirmed obtainable.

## Install / update
1. Download the **rar-rescue-v04** artifact from the most recent successful GitHub Actions workflow **RAR Rescue Extension Checks**, and unzip it once.
2. In Yandex Browser open `browser://extensions` and enable developer mode.
3. Disable v0.3 or use **Reload** on the current unpacked extension after replacing its files.
4. Load the unpacked directory containing `manifest.json`.
5. Reload the Yandex Disk archive preview. Grant only requested site access to `disk.yandex.ru`, `docviewer.yandex.ru`, and `docviewer.360.yandex.ru`.
6. Click the extension toolbar icon. The heading should read **RAR Rescue v0.4**.

## First step — reconcile the README that has already downloaded
1. Open the root of the archive, keeping the relative folder field **empty**.
2. Click **1. Найти файлы**.
3. Click **2. Учесть скачанный README**. This checks recent Chrome/Yandex Browser download history for the same filename; it **does not download it again**.
4. The panel distinguishes:
   - completed nonzero file **inside** `Downloads/YandexRARRecovery/Disk-2.rar/` — counted in the local ledger, permits the next stage;
   - completed file elsewhere — download succeeded but extension could not prove destination; the queue remains locked;
   - still active or failed — do not start overlapping downloads;
   - no matching recent download — need to perform the new one-file pilot.
5. If necessary click **3. Проверить новую загрузку**. This uses the real viewer's row-level download action for `README.TXT`, *not* the broken original-RAR button in the header.
6. **4. Скачать текущую папку** becomes available only after a browser-confirmed pilot and a recognized download button layout.

Before starting the queue, visually check the counts of files, folders and unknown rows. If seven folders appear as files or the displayed counts look wrong, **do not run the queue**. Copy diagnostic JSON using the panel and return it for the next selector correction.

## DOM rules and bug fixed from v0.3
From the user's real DevTools screenshots:
- each member row has a `title` and `resourceItem_*` CSS class;
- row actions appear inside `actionBar_*`;
- actual file icons use `file-icon` variants;
- folders may also reuse `file-icon`, so the generic class **does not prove that a member is a file**.

v0.4 considers folder-specific icon class tokens first, then explicit file-type tokens, and marks unrecognized rows as `unknown`. Unknown objects and folders are **never clicked as files**. The diagnostics include up to 16 visible item names, inferred types and icon class tokens to allow precise further corrections without DevTools.

## Technical architecture
- `archive-dom.js`: `title/resourceItem/actionBar` selectors and conservative file/folder classification.
- `frame-sensor.js`: runs in allowed docviewer frames; enumerates rows, returns a bounded classification report and triggers row-level action.
- `background.js`: cross-frame communication, browser download observation, optional user-requested inspection of **only filename-matching recent downloads**, and guarded output paths. No tokens, headers, cookies, network interception or uploads.
- `content.js`: UI, first-file probe, guarded queue, local ledger and safe retries.
- `extension/tests/dom-smoke.cjs`: generic file-icon on folders, DICOMDIR, unknown-row classification, button selection.
- `extension/tests/download-history.cjs`: recent download reconciliation, target path matching, no unrelated file names or signed download links in report.
- `tools/test_archive_fixture.py`: Chrome fixture matching visible screenshot structure, ensuring file buttons are clicked and header/folders are not.
- `.github/workflows/extension-check.yml`: CI gate and unpacked extension artifact.

## Limitations / safeguards
- No automatic traversal of all nested folders yet. Current queue handles **only the folder currently open**.
- Keep the viewer in the current folder during a batch. Do not navigate away until the queue stops.
- Browser `complete` + nonzero bytes is a transport outcome, **not** CRC, SHA or correct internal content verification. Compare against archive member checksums if obtainable.
- If the viewer does not expose a file through a real download endpoint, repeating requests indefinitely will not restore it.
- Recovered EXE, CMD and other executables should be treated as untrusted files and **not run**.
- Never upload browser account HTML, signed download URLs, cookies or OAuth tokens to GitHub.
- Missing files should be recorded explicitly; a reconstructed archive is a separate object whose SHA-256 will differ from the original RAR.

## Future stages
1. Validate correct browser download bookkeeping from the real Yandex viewer.
2. Fully enumerate and classify all 1,286 objects, including unknown rows.
3. Build recursive traversal of directories, backoff, progress ledger and resume after restart.
4. Fetch original member CRC/size metadata where available; verify each recovered member and export unresolved failures.
5. Optionally pack a new archive with a recovery manifest; never mark an incomplete recovery as complete.
