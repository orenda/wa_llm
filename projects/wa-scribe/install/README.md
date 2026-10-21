# Chrome install

[Download wa-scribe.zip](https://github.com/orenda/wa_llm/blob/codex/wa-scribe-complete/projects/wa-scribe/install/wa-scribe.zip?raw=true), extract it, then open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select the extracted folder containing `manifest.json`.

Follow [the install and Google Drive setup guide](../docs/INSTALL.md), also included inside the ZIP as `INSTALL.md`. No Node or build tools are needed to install this package. Reload WhatsApp Web after loading the extension.

Version **0.1.6 alpha** adds the cached chat checklist, automatic conversation switching and verified original attachment downloads to Drive. Google setup is bundled: click Connect Google Drive and approve consent. Limits: 8 MiB per file, 32 MiB and 128 files per generation. Unsupported originals remain marked unavailable.

Update by replacing files from the full ZIP in the **same unpacked folder**, then Reload the extension and WhatsApp Web. Keep extension storage; do not remove/reinstall. Typecheck and the production build passed on Node 24.22.0. Unit/browser tests were left for the owner; live compatibility remains unverified. See `BUILD.txt` for the exact source and `SHA256SUMS` for the ZIP digest.
