# Local Mac capability prototype

Current investigation: [handoff and lessons learned](docs/HANDOFF-2026-10-22.md), with a [short research prompt](docs/RESEARCH_PROMPT.md). Pause speculative capture patches until the source method is demonstrated; Chromium remains the owner's preference.

Start with [LOCAL_MAC.md](docs/LOCAL_MAC.md). The current workflow is a dedicated Chromium browser and local files only. The historical Chrome extension is no longer the active development path.

Install Node.js 24.x or 26.x, extract `local-macos/wa-scribe-local-macos.zip`, and double-click `Start wa-scribe.command`. Keep your existing Node installation if it is in either range. Link WhatsApp by QR in its browser tab, then use the chat checklist in the wa-scribe tab. Exports default to `~/Documents/wa-scribe`; each chat has Open folder.

Before increasing scope, the owner must check automatic switching between two chats, a photo and PDF, repeat Sync, Stop, Recover and restarting the saved browser profile. This bounded prototype captures up to 50 rendered messages and 8 MiB per original file. It has not been verified against the owner's Mac/WhatsApp session. Build/source evidence is in `local-macos/BUILD.txt`.

Previous extension files, journals and Drive exports remain untouched. New local exports use their own bindings and immutable generations. Do not reset a profile or discard a pending save to troubleshoot collection.
