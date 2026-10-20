# Google setup for the installable alpha

Use [INSTALL.md](INSTALL.md#connect-your-google-drive) for the prebuilt ZIP. Its fixed unpacked extension ID is `ekheeljiijopgjfljhdaehhoomeancmj`; no signing-key generation, client secret, Node or rebuild is needed. Enable Drive API, configure your consent audience/test user, create the Chrome-extension OAuth client bound to that ID, and enter only its public client ID in the panel's Set up Google Drive action. Replace the downloaded manifest.json and reload the extension/WhatsApp tab.

The installed manifest is the runtime source of OAuth configuration. It requests only `https://www.googleapis.com/auth/drive.file`, uses Chrome's token cache, and preserves the scoped WhatsApp/Google host permissions when configuration is downloaded.

For a source build with the same bundled public key:

```bash
export WA_SCRIBE_OAUTH_CLIENT_ID="YOUR_PUBLIC_CLIENT_ID.apps.googleusercontent.com"
npm run build
```

If supplying `WA_SCRIBE_EXTENSION_KEY`, it must be a public DER key whose extension ID matches your OAuth client. Do not put a private key or token in that variable. An unpacked extension does not need its private signing key.

Connect and startup restore do not create files. Run optional Drive test is separate; its synthetic files stay in a wa-scribe test folder for manual cleanup. Actual chat export uses the bound WhatsApp Desk tree and the persistent immutable-ID commit protocol described in INSTALL.md.

No live consent or Drive operation was run for this alpha delivery; the owner requested to run those checks themselves.
