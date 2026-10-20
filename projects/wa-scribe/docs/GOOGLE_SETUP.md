# Google Drive connection

The standard 0.1.5 package already includes the app's public Google OAuth client ID. Users install the ZIP, choose **Connect Google Drive**, and approve Google's consent screen. They do not register an OAuth app, enter a client ID, copy a manifest, install Node, or rebuild the extension. See [INSTALL.md](INSTALL.md).

The app owner registers the Chrome-extension OAuth client once for the stable extension ID `ekheeljiijopgjfljhdaehhoomeancmj`, enables Google Drive API, and configures the consent audience. The extension requests only `https://www.googleapis.com/auth/drive.file`. Its public client ID and extension key are not secrets; a client secret, private signing key, password, access token, or refresh token must never be distributed.

Development builds must use a public OAuth client registered for the extension ID they load. A source build with a different public key needs a matching Chrome-extension client. This development detail does not change the standard ZIP's install flow.

Connect and restoring extension state do not create Drive files. Export files require an explicit Sync. Run optional Drive test, under diagnostics, creates synthetic files separately for manual cleanup. Live consent and Drive behavior for this version still need the owner's pilot. A Google consent rejection may require the app owner to add the account as a test user or correct the consent audience; reinstalling the extension will not fix that registration.
