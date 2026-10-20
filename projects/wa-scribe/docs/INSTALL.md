# Install wa-scribe in Chrome

This is an installable **0.1.1 alpha**, not a verified v1 release. The build and TypeScript checks were run. Automated tests, Chrome interaction tests, live WhatsApp, Google consent, and real Drive operations were deliberately **not run**, at the owner's request.

## Install the ZIP

1. [Download wa-scribe.zip](https://github.com/orenda/wa_llm/blob/codex/wa-scribe-complete/projects/wa-scribe/install/wa-scribe.zip?raw=true) and extract it into a permanent folder. Keep this folder: Chrome loads the unpacked files from it.
2. Open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select the extracted folder containing `manifest.json`.
3. Open or reload [WhatsApp Web](https://web.whatsapp.com/), then click the wa-scribe extension icon to open its side panel. Chrome 116 or newer is required.

To update 0.1.0, replace the files in the same unpacked folder, retain your configured `oauth2` block in `manifest.json`, and click **Reload**. Keep the existing public `key`; do not remove/reinstall the extension or clear its storage. Confirm version 0.1.1, then reload WhatsApp Web. This preserves pending operations and registered chats.

The included public key gives the unpacked extension this stable ID:

```text
ekheeljiijopgjfljhdaehhoomeancmj
```

There is no private signing key, Google client secret, password or token in the package. The public extension key is not a credential. The extension's host permissions cover only WhatsApp Web and Google's API host.

## Connect your Google Drive

Chrome sign-in supplies an identity; your Google Cloud application still needs OAuth configuration. No Node, npm or rebuild is required for this setup.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select your project and enable **Google Drive API**.
2. Configure the OAuth consent screen for your account/audience. Use only `https://www.googleapis.com/auth/drive.file`; add your account as a test user where required. Do not publish the application for this pilot.
3. Create an OAuth client of type **Chrome extension**. Its Item ID must be `ekheeljiijopgjfljhdaehhoomeancmj`. Copy the **public client ID**, ending in `.apps.googleusercontent.com`.
4. In the wa-scribe panel choose **Set up Google Drive**, enter that public client ID, and click **Download manifest.json**. Replace `manifest.json` in the extracted extension folder with that downloaded file.
5. Return to `chrome://extensions`, click **Reload** for wa-scribe, and reload WhatsApp Web. Open the panel, click **Connect Google Drive**, approve consent, and verify the displayed Google account.

Never paste a client secret, access token or refresh token. **Connect** and opening the panel do not create export files. **Run optional Drive test** is a separate user action that creates only synthetic files in its own test folder; those test files are cleaned up manually in Drive.

If using a custom extension public key, rebuild with a matching Chrome OAuth client rather than mixing its ID with this prebuilt ZIP.

## First export

1. Open one low-sensitivity conversation in WhatsApp Web. Click **Add current WhatsApp chat**. Nothing from an unregistered conversation is exported.
2. Leave that chat selected. Choose **Download**, **Rendered messages**, and a small message limit (for example 20).
3. Verify the Google account, then choose **Sync selected**. Follow the per-chat result and **Open export** link.
4. The Drive tree is `WhatsApp Desk/<chat-name>--<key>/export-<operation>/transcript.md` plus `sync.json`. Download that intact folder to read the raw Markdown/JSON locally; files are not converted to Google Docs.
5. Repeat the pass and inspect the results. The extension reads the committed transcript/sidecar, preserves Notes/prefix bytes, retains known message IDs, and pauses on partial local edits instead of replacing them.

You can register several chats. A pass freezes the selected set; each selected conversation must currently be open in an accessible WhatsApp tab. The extension does not navigate to a conversation by its display name. If a chat is not open, that chat pauses with an instruction to open it; other selected chats have independent results. Opening a conversation can mark messages read through WhatsApp's normal behavior.

**Older loaded history** scrolls the selected conversation upward with overlap/identity checks, up to 500 messages, 60 seconds, and 128 KiB of normalized captured data. The pending-save budget is 256 KiB per generation and 768 KiB total local state. A history boundary, account/chat change, missing ID, unknown envelope, disconnection or budget limit produces a partial/paused result. It is not a complete-archive claim, and timestamps are never a cutoff for unseen IDs.

## Edit, Stop, recovery and deletion

- **Download** keeps stored wording when a source message changes. **Edit** applies positively observed changes and delete-for-everyone markers only when the generated blocks remain locally unchanged. An absent row is not a deletion. Partial local edits pause the chat; whole-block removal is retained as a tombstone when alignment is unambiguous. Notes are preserved.
- `sync.json` retains the collector's stop reason, such as `visible-window`, `message-budget`, `byte-budget` or `time-budget`. The panel derives Partial from that same coverage record; an identical resync says Unchanged while retaining partial coverage. Verified message order never means a complete archive. A local-edit pause identifies the affected message IDs.
- **Stop** or unselecting the active chat stops collection/new mutations at a safe boundary. An already sent Drive mutation may still complete. Opening the panel or restarting Chrome never resumes collection automatically.
- Each commit writes **new, preallocated Drive IDs**. A late create cannot overwrite newer generation files. Known IDs, exact staged content and ownership are retained before writes. **Recover** is explicit and can retry the same immutable create ID, verify a 409 against ownership/digest/read-back bytes, and publish only a coherent transcript/sidecar. This uses Drive's pre-generated-ID semantics; it is not an atomic folder transaction or a cross-device lock.
- If a transcript/sidecar changes after capture, recovery pauses without replacing it. **Start fresh** refuses while a save, deletion or previous-generation cleanup is unresolved. Once resolved, it explicitly creates a separate export generation on the next sync, leaves the previous tree untouched, and does not inherit missing tombstones. The previous Open export link remains until a new generation is published; archived root links remain accessible afterward. Do not clear Chrome extension storage as a recovery method.
- **Delete export** requires confirmation and the displayed bound Google account. It trashes only recorded `transcript.md` and `sync.json` files, including Notes in that transcript. Folders and untracked media are retained, even if a folder looks empty: `drive.file` may hide foreign children. A retained-folder link stays available after deletion. Interrupted cleanup retains state for retry. Drive trash/history and prior explicitly archived export trees are not erased.
- After a new coherent generation is committed, old owned generation files are cleaned up. The panel reports pending cleanup when that cannot finish. Follow the latest **Open export** link rather than bookmarking an older generation file.

## Current media and source limitations

The real DOM adapter reads only the verified open `#main` conversation. It uses message `data-id` values and the nonsecret `last-wid`/`last-wid-md` account identifiers. It does not access WhatsApp credentials, private application modules or private endpoints. If this WhatsApp version does not expose those identities, it pauses rather than using a name or timestamp as identity.

Visible captions/quotes are retained. **This alpha does not automatically download media originals.** Images, audio, video, documents and unsupported envelopes carry explicit unavailable/unsupported markers when original provenance/completeness cannot be established. Thumbnails are not claimed as originals, and view-once controls are never opened. Later media support needs live capability evidence for each kind.

The extension does not send WhatsApp messages, run a model, sync on a schedule or create a server-side WhatsApp session. Its exported content is readable by people who have access to the destination.

## Tests for you to run

The test sources were updated for the changed contracts but were not executed. From the source checkout, with the pinned Node 24.22.0/npm 11.19.1:

```bash
cd projects/wa-scribe
npm ci
npx playwright install chromium
npm run typecheck
npx vitest run tests/review-repro.test.ts
npm run test:unit
npm run test:browser
npm run build
```

Keep ordinary automatic tests offline; authorized browser/Google/WhatsApp checks are separate. For the first manual pass, check account display, one-chat export, a repeated pass, Notes preservation, Stop, restart, and explicit recovery before increasing history limits or using important chats. Report the extension version, Chrome/OS, WhatsApp locale, selected scope and the visible error/result; omit chat text, account IDs, credentials and private links.
