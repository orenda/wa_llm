# Local Mac prototype

This is an experimental macOS prototype. It runs wa-scribe and Chromium on your Mac and writes exports to local files. It uses no Google account, Google OAuth, cloud service, or browser extension.

## Start it

Download and extract [wa-scribe-local-macos.zip](https://github.com/orenda/wa_llm/blob/codex/wa-scribe-complete/projects/wa-scribe/local-macos/wa-scribe-local-macos.zip?raw=true). Keep the extracted folder in a permanent location. Double-click `Start wa-scribe.command` at the folder's root. On first launch, the command installs the locked npm dependencies and Playwright's Chromium browser; both are reused on later launches. It accepts stable Node.js 24.x or 26.x releases, including 26.11.1. If neither is installed, the launcher prints the official Node download page and exits. Install Node yourself and relaunch; the launcher does not install Node or request administrator access.

The same launcher also works from a source checkout by double-clicking `scripts/Start wa-scribe.command`; it builds the local app if no bundle exists. It opens a Chromium window with the wa-scribe panel and WhatsApp Web in separate tabs. Scan the QR code in WhatsApp Web if needed. The browser profile stays at `~/Library/Application Support/wa-scribe/chromium`, so WhatsApp's local session is available next time. Keep that Mac account private and use WhatsApp's own logout controls when you want to end the session.

The default export folder is `~/Documents/wa-scribe`. You may pass `--output /path/to/folder` by launching the command from Terminal with that argument. Choose a folder separate from the browser profile. Exports contain readable message text and any verified original files; protect them like your other personal records.

## Pilot a sync

In the panel, refresh and select two non-current chats, one with a small photo and one with a PDF, then click **Sync selected**. The app opens selected chats through normal WhatsApp browser input, checks canonical account and chat IDs, and reports each result. Opening a chat can mark messages read. Inspect each export's `transcript.md`, `sync.json`, and saved original files. Repeat the sync and restart the app to check that existing exports are verified and retained.

PDF tiles may download directly or open WhatsApp's PDF preview. The adapter uses a recognized preview's visible Download control when available and closes known viewers before switching chats. If a viewer cannot be closed, close it in the WhatsApp tab and retry Sync. An attachment is saved only after its downloaded bytes match the selected message's original hash; otherwise its limitation appears in the chat result and transcript. For the owner check, sync a PDF chat followed by another chat and confirm the preview closes and the second chat opens.

When a captured attachment message is rendered but off-screen, the adapter scrolls it into view and rechecks its account, conversation, message, text, deletion state, and original metadata before downloading. A row that disappears or changes during scrolling remains unavailable. Results distinguish attachments found in the loaded message window from files saved; zero attachments found does not mean older history has no attachments.

The transcript reflects content rendered by WhatsApp: up to 50 messages per pass. Older history traversal is outside this capability prototype. Each original is limited to 8 MiB; a generation is limited to 128 files / 32 MiB. Staging is bounded to 64 MiB. Unsupported controls, missing original-byte evidence, grouped or view-once media, and other unavailable items are reported as limitations; a thumbnail is never described as an original. Keep the WhatsApp tab free of manual interaction during Sync.

Sync does not start automatically. **Stop** applies only when explicitly clicked and takes effect at a safe boundary. After stopping or restarting, review the panel and start another sync yourself when ready. Do not assume an interrupted job resumed.

## Local files and recovery

Each chat has a folder named from its readable WhatsApp chat name followed by `--` and a 16-character suffix derived from its account and chat IDs. Chats with the same visible name have separate folders, and existing folders are checked against their stored identity binding before reuse. Names retain Unicode, including Hebrew and emoji; unsafe filename characters are replaced, and long labels are shortened. A legacy folder named only with the ID suffix is renamed intact the next time wa-scribe accesses that chat's export. If WhatsApp later changes a chat's visible name, the existing folder keeps the label it was first given so saved paths stay stable.

Inside a chat folder, `CURRENT` names the active immutable generation under `generations/`. That generation contains `transcript.md`, `sync.json`, and any saved original files; the app's **Open folder** button opens it directly. Older generations remain on disk; remove them manually only after confirming which copy you want to keep. If a sync is interrupted and there is no pending save, review the export and retry **Sync**. If a pending save exists, use the app's explicit **Recover** action and inspect its result before syncing again. The app does not offer a discard or **Fresh** action.

If the app reports a lock after a crash, first verify that wa-scribe and its Chromium process are fully closed. Only then may you remove the stale `.wa-scribe.lock` directory from the export folder and relaunch. Do not remove a lock while an app process may still be running. Preserve `.staging` while any chat has a pending save; it holds bytes used by Recover.

This prototype is launched by a Node command in Terminal through Finder; it is not a signed or notarized native Mac app. The local Mac pilot still needs verification with two non-current chats, a photo, a PDF, a repeated sync, and an app restart. Do not treat a successful synthetic build or run as that live verification.

## Source checks for the owner

From `projects/wa-scribe`, preferably on the development/CI pin Node 24.22.0 for reproducibility. Stable Node 24.x and 26.x releases pass the runtime version check; a live Mac session on Node 26 has not been verified by the agents.

```bash
npm ci
npm run typecheck
npm run test:unit
npx playwright install chromium
npm run test:local
```

These tests use synthetic pages and temporary local files, with live browser requests blocked. Agents left them unrun as requested. The prebuilt ZIP omits test sources; use a source checkout for these commands.
