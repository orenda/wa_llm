# Research prompt: WhatsApp Web chat export reliability

Copy the prompt below into a research agent. No web research has been performed for this document. Project context: [handoff](HANDOFF-2026-10-22.md) and [current metadata reader](https://github.com/orenda/wa_llm/blob/0321664e8ea6b1454cdbf91688f1db9c3803b1bb/projects/wa-scribe/src/original-metadata.ts).

## Copyable prompt

**Search cutoff: 2026-10-22.** Investigate whether others have encountered and solved the following problems in a local macOS WhatsApp chat export tool. Chromium through Playwright remains the preferred direction. Baileys is an interesting comparison, not an approved migration.

Compare browser DOM extraction with browser wrappers [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) and [WPPConnect](https://github.com/wppconnect-team/wppconnect), and Baileys’ unofficial protocol approach ([WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)). Treat these as unreviewed starting points. Flag private/internal API reliance and maintenance or account risks.

Find dated issue reports and confirmed resolutions for: virtualized history exposing 1–5 messages while rows recycle; opaque 20/32-hex `data-id` values mapped to IndexedDB message keys; `model-storage` schema drift; and expired-history media limits. Our metadata reader's blanket `no supported original hash` error also covers rejected size, filename, MIME type, or missing records. Investigate those cases without assuming a hash is absent. Cover PDF sandbox iframes, Playwright's `download` event, new tabs, toolbar controls and parent messages.

Target a local Chromium/WhatsApp Web workflow with QR login, a chat checklist, local Markdown and available photos/PDFs/media, incremental exports, and accessible history. Cite primary public sources, exact versions/dates, reproduction steps, and evidence. Separate verified behavior from issue claims; state unresolved limits, especially expired media. Do not advise disabling identity checks or presenting thumbnails/truncated bytes as originals.

## Optional search queries

- `site:github.com/pedroslopez/whatsapp-web.js issues virtualized chat history media download`
- `"pdf-viewer-iframe" WhatsApp Playwright download`
- `site:github.com/WhiskeySockets/Baileys issues history sync expired media`
- `WhatsApp Web IndexedDB message key data-id 20 32 hex`
