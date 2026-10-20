# wa-scribe

wa-scribe is a Chrome extension alpha that exports selected WhatsApp Web conversations to a Markdown transcript, JSON sidecar, and verified original media in Google Drive. It connects through the user's signed-in Chrome browser and sync starts only after an explicit action.

**Status: installable 0.1.5 alpha.** The packaged build includes the app's public Google OAuth client ID, so the standard flow is Install → Connect Google Drive → consent. The panel searches a cached chat catalogue and lets you select chats with checkboxes. Sync navigates between selected chats through WhatsApp's normal interface, verifies canonical account/chat IDs, and stops the whole job if the user interacts with WhatsApp during navigation or collection. Opening a chat can mark it read.

Images, PDFs and other original attachments are saved through WhatsApp's normal Download command only when their bytes match the selected message's stored plaintext file hash. Missing evidence, unsupported controls, grouped media and view-once media remain explicitly unavailable. Unknown message envelopes retain the visible body and record unknown sender/time details with partial coverage.

See [INSTALL.md](docs/INSTALL.md) for installation and the owner's two-chat pilot. [START_HERE.md](START_HERE.md) records the current verification boundary. Format v1 and the attachment-link grammar are in [FORMAT.md](docs/FORMAT.md).

This is a separate project in the `wa_llm` repository at `projects/wa-scribe/`; it does not use the earlier Python bot's runtime. The project uses TypeScript, a Manifest V3 extension, npm, Vite, Vitest, and Playwright. It does not send WhatsApp messages, run a model, or keep a server-side WhatsApp session.

Coding agents should read [AGENTS.md](AGENTS.md) and work on one assigned task. Reviewers should use [CODE_REVIEW.md](docs/CODE_REVIEW.md) and the current [backlog](docs/BACKLOG.md). The product contract and edge cases are in [SPEC.md](docs/SPEC.md) and [EDGECASES.md](docs/EDGECASES.md).
