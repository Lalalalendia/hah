# Yandex RAR Rescue — experimental Chromium extension

A local, **unverified MVP** for recovering files visible in the Yandex Disk archive viewer when the original RAR download fails. Tested statically; **not yet tested against the real archive viewer DOM**.

## Target

- Public archive: https://disk.yandex.ru/d/_RSlWomRWmty1w
- Displayed archive: \`Диск 2.rar\` (244,374,677 bytes, 1,286 objects including folders)
- Original SHA256: \`2f980815b8267d1ab6cf5c8f1cf867542fa60b9469a3d0c6c4d15c217c577ad5\`
- Independent direct-download tests on Windows and GitHub Actions: HTTP 500 for the original RAR.
- Goal: recover **individual archive members** through the existing web viewer, without relying on the failing original-file endpoint.

**Limitations:** a 1,286-object tree does not mean 1,286 downloadable files. The extension currently works on *one viewer folder at a time*. It cannot claim that all content has been recovered, and it cannot verify inner-file hashes without metadata.

## Install (Windows / Chrome / Yandex Browser)

1. Download this repository as ZIP, extract it, and navigate to the \`extension\` directory.
2. Open \`chrome://extensions\` (or your browser's extension management screen).
3. Enable **Developer mode**, click **Load unpacked**, and select the extracted \`extension\` directory.
4. Open the archive viewer on Yandex Disk.
5. Click the extension's toolbar icon: this opens a small panel in the current page.

## First-run calibration

1. Open a folder showing several **files** (rather than only folders). Type the relative folder name into the panel, e.g. \`1000005A\`; for files in the archive root leave it blank.
2. Click **1. Обучить на значке скачивания**, then click the download icon next to an ordinary small file in the Yandex viewer. The extension captures this click, so it will *not* download the file yet.
3. Confirm that a plausible filename and several matching rows are detected.
4. Click **2. Пробная загрузка**. Check that a real, nonzero file arrives in the browser's Downloads folder under \`YandexRARRecovery/Disk-2.rar/\`.
5. After the pilot works, click **3. Скачать текущую папку**. The extension attempts each listed file in sequence, scrolls the visible list, retries failures up to three times, and remembers files marked downloaded.
6. Navigate manually into another folder, update the relative folder path, and repeat. Click **Остановить после файла** to pause safely.

Chrome or Yandex Browser may ask to allow multiple downloads. Do **not** disable antivirus or bypass dangerous-download warnings, especially for EXE/CMD files.

## Diagnostics

**Копировать диагностику** puts a limited JSON report on the clipboard containing:
- calibration selector and button DOM path;
- up to five *names* currently visible in the folder;
- counts of downloaded/failed files;
- recent local error messages.

No HTML dumps, cookies, authorization headers, OAuth tokens or signed download URLs are collected or published. Review the report before sharing, since file names can still be personal.

## Implementation and safeguards

- MV3 content script on \`disk.yandex.ru\`, launched only from the toolbar.
- Train one item download icon to learn the row structure; automated clicks reuse the site's own download action.
- \`chrome.downloads.onCreated\` and \`onChanged\` track actual browser results, while \`onDeterminingFilename\` assigns a bounded relative path under Downloads.
- Only matched Yandex-hosted downloads from the active tab are associated with an armed request.
- Sequential queue and backoff; local \`chrome.storage.local\` ledger prevents re-downloading files marked complete after a restart.
- Session-scoped pending downloads are preserved across service-worker suspension.
- Relative paths are normalized; absolute paths and \`..\` segments are rejected.
- No embedded credentials, request interception, telemetry, or upload endpoints.

**Important:** “downloaded” means Chrome reported a completed, nonempty transfer (with consistent byte count if known), **not** checksum verification. Some files may be unavailable on Yandex's servers. The original RAR SHA-256 does not verify a reconstructed archive.

## Acceptance gates

- [x] Project source and local download ledger.
- [x] Safety guards for download destinations.
- [x] Static JavaScript and helper tests (run by CI).
- [ ] Pilot on the real viewer: detect a file row and icon reliably.
- [ ] Pilot on the real viewer: download one nonempty file and inspect it.
- [ ] Multiple files under one folder: retry, pause, restart and no duplicates.
- [ ] Browser's download restrictions and blocked files are handled correctly.
- [ ] Automated recursive folder traversal, without manual path entry.
- [ ] Manifest audit: expected vs recovered vs missing, and file-level checksums when available.

If the pilot does not detect the DOM, **stop** and use the diagnostic report to adjust selectors; do not enable bulk downloads.

## Next engineering phase

Collect a *sanitized* DevTools Network trace for one successful internal-file download and one failed download (HTTP status, URL **pathname only**, method, response content type — no query parameters or cookies). Confirm how the viewer enumerates archive contents and whether an inner-file API exposes sizes, CRC or original download links. Only then implement a reliable fully recursive manifest-based downloader. Document any internal API as version-sensitive and subject to change.

No downloaded RAR or user-specific HTML is stored in GitHub.
