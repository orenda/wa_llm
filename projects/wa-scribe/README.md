# wa-scribe

Read the [investigation handoff](docs/HANDOFF-2026-10-22.md) before further capture work. The owner still prefers Chromium; attachment capture and history remain unproven. The [research prompt](docs/RESEARCH_PROMPT.md) is the next investigation, not an approved switch to Baileys.

Current direction: a **local macOS prototype** controlling a dedicated, visible Chromium window through Playwright. All exports stay in a folder on your Mac. There is no Google Drive integration or extension setup in this workflow.

[Download and launch the Mac prototype](docs/LOCAL_MAC.md). It accepts Node.js 24.x or 26.x; the launcher installs the locked dependencies and Chromium on first use. Scan WhatsApp's QR code once, refresh the local chat checklist, select chats, and Sync. Default output: `~/Documents/wa-scribe`. Use each chat's Open folder button to inspect its current export.

The first capability pilot covers two conversations opened automatically, a rendered message window, original photo/PDF downloads, a repeated pass and restart. Each download must match the selected message's plaintext file hash. Missing evidence remains unavailable. This is a prototype awaiting the owner's real Mac/WhatsApp check; build success is not that evidence.

The app reuses the Markdown format and reconciliation rules. New local files live under `local/`. A durable pending journal and immutable generations preserve interrupted saves; Recover is explicit. Existing extension exports and state are not imported or changed. No messages are sent.

## Development

Development and CI pin Node 24.22.0 for reproducibility; the launcher also accepts other stable 24.x and 26.x releases.

```bash
cd projects/wa-scribe
npm ci
npx playwright install chromium
npm run typecheck
npm run local:build
npm run local
```

`npm run test:unit` covers pure logic and the local filesystem store. `npm run test:local` builds the local adapter and runs fixture browser checks. Those tests were left for the owner, as requested. The local app's Google-free dependency path is separate from the historical extension entrypoints.

Read [AGENTS.md](AGENTS.md) for coding rules and [LOCAL_MAC.md](docs/LOCAL_MAC.md) for the current scope. The existing extension backlog/spec and earlier reviews remain under `docs/` as historical records. The extension ZIP under `install/` is the earlier 0.1.6 alpha; the Mac prototype ZIP is under `local-macos/`.

The Python bot and its workflow remain independent. See the parent repository's [LICENSE](../../LICENSE).
