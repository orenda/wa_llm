# Local Mac capability prototype

Start with [LOCAL_MAC.md](docs/LOCAL_MAC.md). The current workflow is a dedicated Chromium browser and local files only. The historical Chrome extension is no longer the active development path.

Install Node.js 24.22.0, extract `local-macos/wa-scribe-local-macos.zip`, and double-click `Start wa-scribe.command`. Link WhatsApp by QR in its browser tab, then use the chat checklist in the wa-scribe tab. Exports default to `~/Documents/wa-scribe`; each chat has Open folder.

Before increasing scope, the owner must check automatic switching between two chats, a photo and PDF, repeat Sync, Stop, Recover and restarting the saved browser profile. This bounded prototype captures up to 50 rendered messages and 8 MiB per original file. It has not been verified against the owner's Mac/WhatsApp session. Build/source evidence is in `local-macos/BUILD.txt`.

Previous extension files, journals and Drive exports remain untouched. New local exports use their own bindings and immutable generations. Do not reset a profile or discard a pending save to troubleshoot collection.
