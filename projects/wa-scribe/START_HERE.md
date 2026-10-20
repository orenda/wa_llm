# Installable alpha: owner verification next

The 0.1.5 alpha is packaged in [`install/wa-scribe.zip`](install/wa-scribe.zip). Install it from [INSTALL.md](docs/INSTALL.md). Standard setup is Install → Connect Google Drive → approve Google's consent screen; users do not edit `manifest.json` or register an OAuth client.

The panel searches a cached catalogue of up to 5,000 chats. Select chats with checkboxes and Sync; wa-scribe opens selected chats through WhatsApp's normal navigation and verifies canonical account/chat IDs before collection. Ambiguity pauses the affected chat; user interaction with WhatsApp stops the job. Navigation can mark chats read.

Images, PDFs and other original attachments use WhatsApp's normal Download command, with raw bytes checked against the selected message's native plaintext file hash. Inspect the downloaded export folder locally: it contains `transcript.md`, `sync.json`, and immutable media copies with relative Markdown links. Links work in a locally downloaded copy; Drive's web viewer is not promised to resolve them.

Pilot two low-sensitivity chats, including one with a photo and one with a PDF smaller than 8 MiB. Inspect the media, repeat Sync, and exercise Stop and recovery. Typecheck and the production build passed on Node 24.22.0; tests were left for the owner. `install/BUILD.txt` records the package source. Live Google/WhatsApp compatibility is unverified for this version.

Do not use the old UI-only update ZIP. It is incompatible with the current media-capable source. Update by extracting the full ZIP into the same unpacked folder, clicking Reload on `chrome://extensions`, and reloading WhatsApp Web. Keep the stable extension ID and existing Chrome extension storage; never remove the extension or reset storage as an update or recovery step.
