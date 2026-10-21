# Local Mac prototype

This is an experimental macOS prototype. It runs wa-scribe and Chromium on your Mac and writes exports to local files. It uses no Google account, Google OAuth, cloud service, or browser extension.

## Start it

Download and extract [wa-scribe-local-macos.zip](https://github.com/orenda/wa_llm/blob/codex/wa-scribe-complete/projects/wa-scribe/local-macos/wa-scribe-local-macos.zip?raw=true). Keep the extracted folder in a permanent location. Double-click `Start wa-scribe.command` at the folder's root. On first launch, the command installs the locked npm dependencies and Playwright's Chromium browser; both are reused on later launches. It requires Node.js 24.22.0. If that exact version is missing, the launcher prints the official Node download page and exits. Install Node yourself and relaunch; the launcher does not install Node or request administrator access.

The same launcher also works from a source checkout by double-clicking `scripts/Start wa-scribe.command`; it builds the local app if no bundle exists. It opens a Chromium window with the wa-scribe panel and WhatsApp Web in separate tabs. Scan the QR code in WhatsApp Web if needed. The browser profile stays at `~/Library/Application Support/wa-scribe/chromium`, so WhatsApp's local session is available next time. Keep that Mac account private and use WhatsApp's own logout controls when you want to end the session.

The default export folder is `~/Documents/wa-scribe`. You may pass `--output /path/to/folder` by launching the command from Terminal with that argument. Choose a folder separate from the browser profile. Exports contain readable message text and any verified original files; protect them like your other personal records.

## Pilot a sync

In the panel, refresh and select two non-current chats, one with a small photo and one with a PDF, then click **Sync selected**. The app opens selected chats through normal WhatsApp browser input, checks canonical account and chat IDs, and reports each result. Opening a chat can mark messages read. Inspect each export's `transcript.md`, `sync.json`, and saved original files. Repeat the sync and restart the app to check that existing exports are verified and retained.

The transcript reflects content rendered by WhatsApp: up to 50 messages per pass. Older history traversal is outside this capability prototype. Each original is limited to 8 MiB; a generation is limited to 128 files / 32 MiB. Staging is bounded to 64 MiB. Unsupported controls, missing original-byte evidence, grouped or view-once media, and other unavailable items are reported as limitations; a thumbnail is never described as an original. Keep the WhatsApp tab free of manual interaction during Sync.

Sync does not start automatically. **Stop** applies only when explicitly clicked and takes effect at a safe boundary. After stopping or restarting, review the panel and start another sync yourself when ready. Do not assume an interrupted job resumed.

## Local files and recovery

Each successful save creates an immutable export generation and updates a `CURRENT` pointer. If interrupted work leaves a pending journal, use the app's explicit recovery action and inspect its result before syncing again. Older generations remain on disk; remove them manually only after confirming which copy you want to keep. The app does not offer a discard or **Fresh** action.

If the app reports a lock after a crash, first verify that wa-scribe and its Chromium process are fully closed. Only then may you remove the stale `.wa-scribe.lock` directory from the export folder and relaunch. Do not remove a lock while an app process may still be running. Preserve `.staging` while any chat has a pending save; it holds bytes used by Recover.

This prototype is launched by a Node command in Terminal through Finder; it is not a signed or notarized native Mac app. The local Mac pilot still needs verification with two non-current chats, a photo, a PDF, a repeated sync, and an app restart. Do not treat a successful synthetic build or run as that live verification.

## Source checks for the owner

From `projects/wa-scribe` on Node 24.22.0:

```bash
npm ci
npm run typecheck
npm run test:unit
npx playwright install chromium
npm run test:local
```

These tests use synthetic pages and temporary local files, with live browser requests blocked. Agents left them unrun as requested. The prebuilt ZIP omits test sources; use a source checkout for these commands.
