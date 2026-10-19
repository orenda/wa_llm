# wa-scribe

A proposed Chrome extension that exports explicitly selected WhatsApp Web chats to Markdown and original media in Google Drive. Connection starts inside the user's signed-in Chrome browser. Sync runs only on a user action.

This is a separate project inside the `wa_llm` Git repository at `projects/wa-scribe/`. Its package, source, tests, and build outputs live here. It shares repository history and licensing with the parent; the Python bot has its own runtime and dependencies.

**Status: coded through T13 on stacked draft branches. T01 and T02 are accepted. T03 is accepted as-is. Live Google, real WhatsApp, and the pilot are left for owner testing. This is not a v1 claim.** See the [pilot checklist](docs/PILOT.md), [Google setup](docs/GOOGLE_SETUP.md), and the [T02 review record](docs/reviews/T02-500480a.md). Without the owner's OAuth client ID and extension public key, the panel says Google setup is missing. The production build does not read WhatsApp Web.

## Start here

- Give another coding agent [START_HERE.md](START_HERE.md): it includes the current starting branch, T03 instructions, and a copyable prompt.
- Coding agent: read [AGENTS.md](AGENTS.md), then execute one assignment from [the backlog](docs/BACKLOG.md).
- Reviewer: use [the review checklist](docs/CODE_REVIEW.md) on the exact submitted commit.
- Product contract: [spec](docs/SPEC.md), [edge cases](docs/EDGECASES.md), and [test plan](docs/TESTPLAN.md).
- Delivery sequence: [development plan](docs/DEVELOPMENT.md).
- Copyable assignment and completion format: [agent handoff](docs/AGENT_HANDOFF.md).

## Scope

Google Drive is first. Local-folder export follows later. The extension does not send messages, run a model, or require a server logged into WhatsApp. It is independent of the earlier Python bot.

Use TypeScript, a Manifest V3 extension, a small DOM-based side panel, npm, Vite, Vitest, and Playwright. Keep the implementation direct and compact. Avoid application frameworks and generic infrastructure until a concrete task requires them.

## Work and review

The coding backlog through T13 is implemented. The next work is the owner checklist in [PILOT.md](docs/PILOT.md). From the repository root, enter `projects/wa-scribe/` before running project commands.

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

`npm run build` writes the production unpacked extension to `dist/`. Load that directory from `chrome://extensions` with Developer mode on. `dist-test/` is the test build, which adds the local fixture origin; do not load it as the product. `node scripts/package-release.mjs` zips the production `dist/` to `release/wa-scribe.zip` and does not publish.

### Evidence

- **Automatic:** `typecheck`, `test:unit`, `test:browser`, and `build` run locally against the fixture page. They do not call Google or WhatsApp. `test:browser` loads the built unpacked extension in Chromium.
- **Configured CI:** [`.github/workflows/wa-scribe.yml`](../../.github/workflows/wa-scribe.yml) runs those commands on Node `24.22.0`. A green local run is not a completed remote CI run.
- **Unrun:** real WhatsApp, the live selector diagnostic, Google OAuth, Drive writes, and the user pilot. Those stay **real WhatsApp not verified**.

Coding agents implement one small ticket, submit the diff and real test output, and return it to the coordinating agent for review. They do not self-approve, merge, or publish. Each revised commit receives a fresh review. There is no background review service or branch protection configured by these documents.

## Browser checks

Synthetic tests run without Google or WhatsApp credentials. OAuth, actual WhatsApp page behavior, and the final pilot need explicit user actions in the user's Chrome. Drive requires an OAuth client bound to a stable extension ID; Chrome sign-in alone does not grant the Drive permission.

See the parent repository's [LICENSE](../../LICENSE). This project has not been publicly released as an extension.
