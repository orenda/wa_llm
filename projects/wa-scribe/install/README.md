# Chrome install

[Download wa-scribe.zip](https://github.com/orenda/wa_llm/blob/codex/wa-scribe-complete/projects/wa-scribe/install/wa-scribe.zip?raw=true), extract it, then open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select the extracted folder containing `manifest.json`.

Follow [the install and Google Drive setup guide](../docs/INSTALL.md), also included inside the ZIP as `INSTALL.md`. No Node or build tools are needed to install this package. Reload WhatsApp Web after loading the extension.

Version **0.1.2 diagnostic alpha**, source **6745c9d**, exports text; unverified original media is unavailable. TypeScript and production build passed, and 93 unit tests passed on Node 24.22.0. The owner's Chrome check is blocked by conversation-ID detection; the new error supplies counts-only diagnostics. Browser/live export remain unverified. `BUILD.txt` records the source/evidence and `SHA256SUMS` records the ZIP digest. To update, back up the configured manifest, replace files in the same unpacked folder, restore its OAuth block into the new manifest, then Reload; preserve extension storage and reload WhatsApp Web.
