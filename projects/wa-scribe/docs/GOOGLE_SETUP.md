# Google setup for the synthetic Drive probe

This is the owner-operated setup for T03. The extension requests only `https://www.googleapis.com/auth/drive.file`. It uses Chrome's token cache. It does not contain a client secret, refresh token, or password. A cloud agent cannot complete these steps. A green unit test is not live OAuth.

Do this in the Google account that will click **Connect Google Drive**. Keep `extension.pem` outside the repository.

## 1. Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or choose a project.
2. Enable the **Google Drive API** for that project (APIs & Services → Library → Google Drive API → Enable).
3. Open **OAuth consent screen**. Choose External, or Internal if this is a Workspace account. Set the app name to `wa-scribe`. Add the scope `https://www.googleapis.com/auth/drive.file`. While the app is in testing, add the Google account you will use as a test user. Save. Do not publish the app.

## 2. Stable extension id

From a directory that is not this repo:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out extension.pem
openssl rsa -in extension.pem -pubout -outform DER | openssl base64 -A > extension.pub.b64
python3 - << 'PY'
import base64, hashlib, pathlib
der = base64.b64decode(pathlib.Path("extension.pub.b64").read_text().strip())
digest = hashlib.sha256(der).digest()[:16]
print("".join("abcdefghijklmnop"[byte >> 4] + "abcdefghijklmnop"[byte & 15] for byte in digest))
PY
```

The printed 32-character value is the extension id. `extension.pub.b64` is the public `key` value. Leave `extension.pem` out of git, chat, and the extension package.

## 3. OAuth client

APIs & Services → Credentials → Create credentials → OAuth client ID.

- Application type: **Chrome extension**
- Item ID: the extension id from step 2

Copy the client id. It looks like `123456789012-abc.apps.googleusercontent.com`. There is no client secret for this client type. Do not create a second client and do not paste a token.

## 4. Build and load

From `projects/wa-scribe/`, with Node 24.22.0:

```bash
export WA_SCRIBE_OAUTH_CLIENT_ID="the-client-id.apps.googleusercontent.com"
export WA_SCRIBE_EXTENSION_KEY="$(cat /path/to/extension.pub.b64)"
npm ci
npm run build
```

Load the unpacked `dist/` directory at `chrome://extensions` with Developer mode on. The shown id must match step 2. If it does not, the public key was not the one used for the OAuth client; fix the env and rebuild. Do not load `dist-test/`.

A build without those two variables stays usable. The panel then says Google setup is missing and does not call Google. Never commit a made-up client id.

The built `dist/manifest.json` contains the client id, the public key, and the single `drive.file` scope. That is public configuration. It must not contain `client_secret`, a private key, or a token.

## 5. Connect, then run the probe

1. Open the wa-scribe side panel.
2. Click **Connect Google Drive**. Chrome may show the `drive.file` consent screen. This is not a separate application password.
3. Read the account email in the panel. It comes from the Drive `about` response, not from the Chrome profile label. If it is the wrong account, stop. Do not click **Run Drive test**.
4. Click **Run Drive test** once. Connect itself does not create files. The probe creates a new folder named `wa-scribe test`, then writes and reads `note.md`, `meta.json`, and `dot.bin` inside it. The panel should say the raw bytes were verified.
5. Close Chrome and open it again. Open the panel. The cached connection may show the same account without a new consent screen. It must not create another folder until you click **Run Drive test** again.

If a change may have succeeded but the response was lost, or Drive returns HTTP 500, 502, 503, or 504 for a write, the panel says the outcome is unknown and stops. It keeps that warning. It does not retry the request and it does not delete anything. **Run Drive test** shows the warning before it creates another folder. Click it again only after that warning is visible. The second click starts a new folder and leaves the earlier change alone. A rejected sign-in or permission error does not clear an older unresolved change.

Closing the panel during a test and opening it again can show that a test is already running. The panel catches up when that test finishes. Reopening does not start another test or another consent screen.

## 6. Check the downloaded tree

In Drive on the web, download the `wa-scribe test` folder (Download, not the in-browser preview). Unzip it. `note.md` contains a relative link to `dot.bin`. Open that file from the unzipped folder and confirm the bytes are the four ASCII bytes `wa-s`. `meta.json` is the synthetic probe object. These files are not Google Docs.

Delete test folders yourself in Drive. The extension does not delete by name.

## 7. What this environment did not run

Record a live pass separately: extension commit SHA, Chrome version, OS, the `drive.file` scope, whether consent appeared, the byte-verification sentence, reconnect after restart, and which failures were not tried (denial, expiry, removed folder, account switch). Omit account emails, file ids, tokens, and URLs. Do not publish the extension or the OAuth client.
