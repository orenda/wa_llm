# Chrome install

[Download wa-scribe.zip](https://github.com/orenda/wa_llm/blob/codex/wa-scribe-complete/projects/wa-scribe/install/wa-scribe.zip?raw=true), extract it, then open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select the extracted folder containing `manifest.json`.

Follow [the install and Google Drive setup guide](../docs/INSTALL.md), also included inside the ZIP as `INSTALL.md`. No Node or build tools are needed to install this package. Reload WhatsApp Web after loading the extension.

Version **0.1.1 alpha**, source **acdb65c**, exports text; unverified original media is unavailable. TypeScript and production build passed, and 85 unit tests passed on Node 24.22.0. Browser and live Chrome/WhatsApp/Drive checks remain unrun. `BUILD.txt` records the source/evidence and `SHA256SUMS` records the ZIP digest. To update, back up the configured manifest, replace files in the same unpacked folder, restore its OAuth block into the new manifest, then Reload; preserve extension storage.
