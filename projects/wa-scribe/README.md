# wa-scribe

A proposed Chrome extension that exports explicitly selected WhatsApp Web chats to Markdown and original media in Google Drive. Connection starts inside the user's signed-in Chrome browser. Sync runs only on a user action.

This is a separate project inside the `wa_llm` Git repository at `projects/wa-scribe/`. Its package, source, tests, and build outputs live here. It shares repository history and licensing with the parent; the Python bot has its own runtime and dependencies.

**Status: installable 0.1.0 alpha.** The production panel connects the selected-chat DOM adapter, bounded collection, Drive text export, Download/Edit, Stop, persistent recovery, fresh export, and owned-file deletion. [Download/install instructions](docs/INSTALL.md). Build and TypeScript checks were run; tests and live Google/WhatsApp checks were deliberately not run at the owner's request. Media without verified original bytes is explicitly unavailable. This is not a verified v1 release.

## Start here

- Install and test the alpha using [INSTALL.md](docs/INSTALL.md); [START_HERE.md](START_HERE.md) records the current delivery and verification boundary.
- Coding agent: read [AGENTS.md](AGENTS.md), then execute one assignment from [the backlog](docs/BACKLOG.md).
- Reviewer: use [the review checklist](docs/CODE_REVIEW.md) on the exact submitted commit.
- Product contract: [spec](docs/SPEC.md), [edge cases](docs/EDGECASES.md), and [test plan](docs/TESTPLAN.md).
- Delivery sequence: [development plan](docs/DEVELOPMENT.md).
- Copyable assignment and completion format: [agent handoff](docs/AGENT_HANDOFF.md).

## Scope

Google Drive is first. Local-folder export follows later. The extension does not send messages, run a model, or require a server logged into WhatsApp. It is independent of the earlier Python bot.

Use TypeScript, a Manifest V3 extension, a small DOM-based side panel, npm, Vite, Vitest, and Playwright. Keep the implementation direct and compact. Avoid application frameworks and generic infrastructure until a concrete task requires them.

## Work and review

The owner requested direct implementation and reserved all tests for themselves. Historical review records remain under `docs/reviews/`; their findings motivated this implementation and are not test evidence for it. Use `codex/wa-scribe-complete` for the integrated source. From the repository root, enter `projects/wa-scribe/` before running project commands.

Prerequisites: Node `24.22.0` (see `.node-version`; npm `11.19.1` is the npm shipped with that release) and a Chromium build Playwright can launch.

```text
cd projects/wa-scribe
npm ci
npx playwright install chromium
npm run typecheck
npm run test:unit
npm run test:browser
npm run build
```

`npm run build` writes the production unpacked extension to `dist/`. Load that directory from `chrome://extensions` with Developer mode on. `dist-test/` is the test build, which adds the local fixture origin; do not load it as the product. `node scripts/package-release.mjs` zips production files and does not publish. A prebuilt copy is in `install/wa-scribe.zip`; Google OAuth can be configured through the installed panel without Node or rebuilding.

### Evidence

- **This delivery:** TypeScript checks and production build only. No unit/browser tests, targeted executable probes, CI, Google consent, or live WhatsApp/Drive operations were run.
- **Available for the owner:** `test:unit` and `test:browser`; test sources were updated for the changed contracts but have not been executed. Automatic tests must not call real Google or WhatsApp.
- **Configured CI:** [`.github/workflows/wa-scribe.yml`](../../.github/workflows/wa-scribe.yml) runs those commands on Node `24.22.0`. A green local run is not a completed remote CI run.
- **Unrun:** real WhatsApp, the live selector diagnostic, Google OAuth, Drive writes, and the user pilot. Those stay **real WhatsApp not verified**.

Coding agents implement one small ticket, submit the diff and real test output, and return it to the coordinating agent for review. They do not self-approve, merge, or publish. Each revised commit receives a fresh review. There is no background review service or branch protection configured by these documents.

## Browser checks

Synthetic tests run without Google or WhatsApp credentials. OAuth, actual WhatsApp page behavior, and the final pilot need explicit user actions in the user's Chrome. Drive requires an OAuth client bound to a stable extension ID; Chrome sign-in alone does not grant the Drive permission.

See the parent repository's [LICENSE](../../LICENSE). This project has not been publicly released as an extension.
