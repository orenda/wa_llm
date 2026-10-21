# Install wa-scribe

This is the installable **0.1.6 alpha**. The standard ZIP includes the app's public OAuth client ID. To connect, install the extension, click **Connect Google Drive**, and approve Google's consent screen. Do not create a Cloud project or edit the manifest.

## Install or update

1. Download [wa-scribe.zip](https://github.com/orenda/wa_llm/blob/codex/wa-scribe-complete/projects/wa-scribe/install/wa-scribe.zip?raw=true) and extract it into a permanent folder.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select the extracted folder containing `manifest.json`.
3. Open or reload [WhatsApp Web](https://web.whatsapp.com/) and open the wa-scribe side panel. Chrome 116 or newer is required.

To update an existing installation, extract the **full ZIP into the same unpacked folder**, allow files to be replaced, click **Reload** on `chrome://extensions`, then reload WhatsApp Web. The package keeps the same public extension key and extension ID, so Chrome retains its extension storage and Google connection. Never remove/reinstall the extension or clear/reset its storage during an update or recovery. The old UI-only update ZIP is incompatible with the current media-capable source; do not use it.

Confirm **0.1.6** on `chrome://extensions`. This version activates the chat label with pointer/mouse events and retains a registered native name when the cached catalogue supplies only an ID. These repairs address two paths that could leave a different chat unopened; live compatibility still needs your check.

The stable extension ID is:

```text
ekheeljiijopgjfljhdaehhoomeancmj
```

The package contains a public client ID and public extension key. It contains no client secret, private signing key, password, or token. The extension requests only the `drive.file` OAuth scope.

## Connect and select chats

Click **Connect Google Drive** and approve the requested access. Verify the connected account in the panel. Connecting alone creates no export files.

The chat list comes from this browser's local WhatsApp cache, with a limit of 5,000 records. Search and check chats; only checked chats are registered in extension storage, up to 100 registered chats. This is not a list of every server-side or archived chat. Sync visits the checked conversations through WhatsApp's normal interface; those visits can mark messages read. User interaction with WhatsApp stops the job. Ambiguous navigation, identity or ordering pauses the affected chat. Names are navigation hints; canonical account/chat IDs bind the export. If discovery is unavailable, Add current chat manually remains under Sync settings.

## Pilot and inspect an export

1. Leave an unrelated conversation open in WhatsApp. Select two other low-sensitivity chats in the extension, including one with a small photo and one with a PDF, and click **Sync selected**. WhatsApp should switch to each checked chat automatically.
2. Follow the panel's per-chat progress and result. If WhatsApp opens a selected conversation, let the extension finish. Interacting with WhatsApp stops the job; restart Sync explicitly after you are ready.
3. Download the complete export folder from Drive and extract it locally. Inspect `transcript.md`, `sync.json`, and the media files. Relative attachment links work in this downloaded folder; wa-scribe does not promise that Drive's web viewer resolves them.
4. Check that each saved photo/PDF is the exact expected original. Repeat Sync and confirm it verifies unchanged files without creating duplicates. Exercise Stop and the recovery controls before using important chats.

If automatic switching still fails on 0.1.6, expand the failed chat's **More actions** and copy **Result detail**, omitting chat names/IDs. Do not use Start fresh to troubleshoot navigation.

Message text comes from the rendered WhatsApp conversation. Original media is saved through WhatsApp's normal Download command. A readonly lookup of the exact selected message record projects only its identity, plaintext `filehash`, optional size, MIME type and filename. Downloaded bytes must match that hash and any supplied size, and the metadata is rechecked afterward. Missing evidence, unsupported controls, grouped media and view-once media remain unavailable. A thumbnail is never presented as an original. If the normal download arrives after capture times out, Chrome may download a local copy instead; it is not marked saved in Drive.

Limits are 8 MiB per file, 32 MiB and 128 files per export generation, and 64 MiB of cached media. A limit or incomplete source boundary produces partial coverage. Unknown message envelopes keep the visible body, mark sender/time as unknown where needed, and retain partial coverage.

The Markdown and JSON sidecar are stored with immutable copies of verified media. A changed export generation may copy or re-upload retained media. An unchanged pass verifies the existing files. **Delete export** trashes recorded transcript, sidecar, and media files but retains folders and untracked children. It does not remove other Drive files.

## Stop, recovery, and privacy

**Stop** ends collection and prevents new mutations at a safe boundary; a Drive operation already sent may still finish. The extension never resumes collection automatically after opening the panel or restarting Chrome. Use **Recover** for a pending save: Sync will not replay it, and Start fresh refuses while a save, deletion or cleanup is unresolved. Do not clear extension storage: it contains the recovery journal and staged attachment bytes.

Typecheck and the production build passed on Node 24.22.0. Unit/browser tests were not run by agents, as requested. Exact package source and verification are in `BUILD.txt`. Live consent, chat discovery/navigation and photo/PDF compatibility still need your Chrome pilot. Report Chrome/OS, locale, scope and visible outcomes without sharing chat text, account identifiers, credentials or private Drive links.

To run the automatic tests from a source checkout on Node 24.22.0:

```bash
git clone --branch codex/wa-scribe-complete https://github.com/orenda/wa_llm.git
cd wa_llm/projects/wa-scribe
npm ci
npm run typecheck
npm run test:unit
npx playwright install chromium
npm run test:browser
```

The browser suite uses synthetic pages and blocks live requests. Its success would not verify the live WhatsApp layout.

wa-scribe does not send WhatsApp messages, run a model, sync on a schedule, open view-once content, or create a server-side WhatsApp session. Exported content is readable by people who can access the Drive destination.
