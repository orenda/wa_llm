# Current chat selection and connection flow

The 0.1.5 alpha flow is: install the standard ZIP, connect Google Drive, search the cached chat catalogue, check the chats to export, and click Sync. The panel supports up to 5,000 cached catalogue records and stores up to 100 selected chats.

## Chat selection and navigation

Chat names are display and navigation hints; they never bind an export. Sync uses WhatsApp's normal interface to open each selected conversation, then verifies the canonical account and chat IDs before collecting messages. Opening a conversation can mark it read. If navigation, canonical identity, message order, or account context is ambiguous, the extension pauses instead of guessing. User interaction with WhatsApp stops the whole job so the extension cannot continue against a changed page or selection.

The source adapter reads the visible conversation. Unknown message envelopes retain the visible body and record unknown sender/time fields with partial coverage. A last-sync timestamp does not discard unseen message IDs. Stop and pause preserve explicit coverage and unresolved work for recovery.

## Drive connection and export files

The packaged public OAuth client makes connection a user flow: click Connect Google Drive and approve consent. The app owner maintains the Google registration; users do not edit manifests. Export creation requires an explicit Sync.

Each export contains `transcript.md`, `sync.json`, and any verified media copies. Markdown has relative links to media beside the transcript. Links work after downloading and extracting the complete folder locally; the Drive web viewer is not guaranteed to resolve them. A changed generation may copy or re-upload retained media, while an unchanged pass verifies existing media files. Delete trashes recorded export files, including media, and retains folders and untracked children.

Original media is accepted through a normal Download command only when its bytes match the exact selected message's stored plaintext file hash; optional size evidence is checked. Metadata reads project a whitelist on that selected record. Unsupported controls, grouped media, view-once content or missing byte evidence remain unavailable. The limits are 8 MiB per file, 32 MiB and 128 files per generation, and 64 MiB cached media.

The extension does not send messages, access view-once content, run a model, or use a server-side WhatsApp session. See [INSTALL.md](INSTALL.md) for the owner pilot and recovery steps.
