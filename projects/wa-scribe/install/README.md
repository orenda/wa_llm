# Chrome install

[Download wa-scribe.zip](https://github.com/orenda/wa_llm/blob/codex/wa-scribe-complete/projects/wa-scribe/install/wa-scribe.zip?raw=true), extract it, then open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select the extracted folder containing `manifest.json`.

Follow [the install and Google Drive setup guide](../docs/INSTALL.md), also included inside the ZIP as `INSTALL.md`. No Node or build tools are needed to install this package. Reload WhatsApp Web after loading the extension.

Version **0.1.1 alpha** exports text; unverified original media is unavailable. TypeScript and production build passed. Tests and live Chrome/WhatsApp/Drive checks were not run, at the owner's request. `SHA256SUMS` records the packaged file's digest. To update, keep the same unpacked folder and configured OAuth block, replace the package files, then Reload; preserve extension storage.
