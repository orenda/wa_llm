# Owner pilot checklist

This checklist is for David. It has not been run. Coding for T04 through T13 is on stacked draft branches. Automated unit and browser checks use fixtures and fakes. They are not a pilot pass, not live OAuth, and not a v1 claim.

The production panel can connect Google Drive and run the synthetic Drive probe after the setup below. It shows the Edit warning. **Edit selected chat** and **Delete export** stay disabled. The production build does not register a content script, so it does not read WhatsApp Web. The coded reader understands the fixture page's `data-account-id`, `data-chat-id`, and message attributes. It does not contain WhatsApp Web's real selectors. Fixture Download (`?download=1` on the test build) does not call Google.

Provisional budgets in code were not measured on WhatsApp: 500 messages per pass, 32 MiB per attachment, 3 media attempts, 256 KiB journal, and a 30 second retry cap. A local writer check is not cross-device exclusion. A fingerprint mismatch aborts a commit and does not close a concurrent Notes race. A fresh export does not inherit tombstones. Each media kind needs its own evidence.

## Setup

Follow [GOOGLE_SETUP.md](GOOGLE_SETUP.md). Short form:

1. In Google Cloud Console, choose a project, enable the Google Drive API, and configure the OAuth consent screen as External or Internal. Name the app `wa-scribe`. Add scope `https://www.googleapis.com/auth/drive.file`. While the app is in testing, add the Google account you will use as a test user. Do not publish the app.
2. Outside this repo, generate `extension.pem` and the public key, and print the 32-character extension id. Leave `extension.pem` out of git, chat, and the zip.
3. Create one OAuth client of type Chrome extension whose item id is that extension id. Copy the client id. There is no client secret.
4. From `projects/wa-scribe/` on Node 24.22.0:

```bash
export WA_SCRIBE_OAUTH_CLIENT_ID="the-client-id.apps.googleusercontent.com"
export WA_SCRIBE_EXTENSION_KEY="$(cat /path/to/extension.pub.b64)"
npm ci
npm run build
node scripts/package-release.mjs
```

5. Load unpacked `dist/` at `chrome://extensions` with Developer mode on. Do not load `dist-test/`. The shown id must match step 2. `node scripts/package-release.mjs` writes `release/wa-scribe.zip` and does not publish.

A build without the two variables stays offline. The panel then says: `Google setup is missing. Set the OAuth client ID and extension public key, then rebuild.`

## What to test

Record the extension commit SHA, Chrome version, OS, WhatsApp locale, the `drive.file` scope, and each outcome below. Omit account emails, file ids, tokens, and private URLs.

| Check | What to look for |
| --- | --- |
| Missing setup | Without the two env vars, Connect and Run Drive test stay disabled and the status sentence matches the line above. Edit and Delete stay disabled. The warning says to finish editing. |
| Connect | Click **Connect Google Drive**. Consent may appear. The account email comes from the Drive about response. If it is the wrong account, stop before **Run Drive test**. Connect creates no files. |
| Probe | Click **Run Drive test** once. It creates a new `wa-scribe test` folder and writes `note.md`, `meta.json`, and `dot.bin`. The panel says the raw bytes were verified. |
| Reconnect | Close Chrome, open it, and open the panel. The same account may appear without a new consent screen and without a new folder until you click **Run Drive test** again. |
| Intact tree | Download the folder from Drive on the web. `note.md` links to `dot.bin`. Those bytes are the four ASCII bytes `wa-s`. `meta.json` is the probe object. These are not Google Docs. Delete test folders yourself. The extension does not delete by name. |
| Unknown write | If a write may have succeeded but the response was lost, or Drive returns HTTP 500–504 for a write, the panel keeps an unknown outcome, does not retry that request, and does not delete anything. A later probe starts a new folder only after that warning is visible. A 401 or 403 does not clear an older unresolved change. |
| Busy panel | Closing the panel during a probe and reopening it can say a test is already running. Reopening does not start another probe or another consent screen. |
| Account and folder | Switching the Google account, or removing the test folder, pauses instead of writing into a different account or adopting a same-named folder. |
| Fixture identity | On the test build only, the fixture diagnostic counts rows and does not print message text. `?probe=1` reads the selected fixture chat. A row without an id is unresolved and is not given an invented id. |
| Fixture Download | `?download=1` on the test build writes the fixture chat once and does not call Google. Repeat does not duplicate it. This is not a WhatsApp or Drive pass. |
| Real WhatsApp selectors | Not in this build. A live pass needs selectors for the page you see, then a non-collecting diagnostic, then a separate explicit probe of one selected chat. Counts alone are not identity. |
| Download, then repeat | After a real reader exists: one selected chat, no unselected chats, no duplicate ids, Notes bytes unchanged, one whole-block removal becomes a `local-deletion` tombstone and stays gone. |
| Download, then Edit | A source wording change is kept on Download and applied on Edit. A positive delete-for-everyone removes that message with no tombstone. An absent row is not treated as a deletion. A local wording edit is a conflict and is kept. |
| Interrupt and unmark | Source disconnect can save a partial commit and keeps the gap. Drive disconnect leaves the save pending and does not advance last success. Restart does not resume collection. Unmark does not delete files. Stop does not roll back a write that already landed. |
| Delete and fresh export | Delete only the selected generation's owned files. Foreign files and another generation stay. A partial delete leaves the remaining owned ids. A fresh export uses a new root, leaves the old tree, and warns that tombstones are not inherited. |
| Media, one kind at a time | Image, voice, video, sticker, document, unknown MIME, and an album slot each need a separate result. A thumbnail, empty file, or HTML error page is not an original. Unknown bytes stay `.bin` with no signed URL stored. A missing owned file is missing bytes, not a deleted message. View-once content is not opened. |
| Two or three chats | One failed or over-budget chat stays partial. Another chat's committed result remains. Do not mark the run complete from one success. |

## Still not verified

Live Google consent, real Drive writes, real WhatsApp selectors, measured budgets, cross-device exclusion, and this pilot. Do not publish the extension or the OAuth client.
