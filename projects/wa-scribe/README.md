# wa-scribe

A proposed Chrome extension that exports explicitly selected WhatsApp Web chats to Markdown and original media in Google Drive. Connection starts inside the user's signed-in Chrome browser. Sync runs only on a user action.

This is a separate project inside the `wa_llm` Git repository at `projects/wa-scribe/`. Its package, source, tests, and build outputs live here. It shares repository history and licensing with the parent; the Python bot has its own runtime and dependencies.

**Status: T01 and T02 accepted; T03 has review fixes, and T04–T13 are unaccepted draft prototypes with missing integration.** See the [stack review and repair order](docs/reviews/STACK-b4ff2b8.md) and [current T03 assignment](docs/reviews/T03-9f5ad63.md). Production has no WhatsApp reader or working export; Edit/Delete remain disabled. The [pilot checklist](docs/PILOT.md) is a future checklist, not the next acceptance step. Google setup and all live checks remain unrun.

## Start here

- Give another coding agent [START_HERE.md](START_HERE.md): it includes the current T03 fix branch, review links, and a copyable prompt.
- Coding agent: read [AGENTS.md](AGENTS.md), then execute one assignment from [the backlog](docs/BACKLOG.md).
- Reviewer: use [the review checklist](docs/CODE_REVIEW.md) on the exact submitted commit.
- Product contract: [spec](docs/SPEC.md), [edge cases](docs/EDGECASES.md), and [test plan](docs/TESTPLAN.md).
- Delivery sequence: [development plan](docs/DEVELOPMENT.md).
- Copyable assignment and completion format: [agent handoff](docs/AGENT_HANDOFF.md).

## Scope

Google Drive is first. Local-folder export follows later. The extension does not send messages, run a model, or require a server logged into WhatsApp. It is independent of the earlier Python bot.

Use TypeScript, a Manifest V3 extension, a small DOM-based side panel, npm, Vite, Vitest, and Playwright. Keep the implementation direct and compact. Avoid application frameworks and generic infrastructure until a concrete task requires them.

## Work and review

The next work is the [T03 fix assignment](docs/reviews/T03-9f5ad63.md), followed by the [staged repair plan](docs/reviews/STACK-b4ff2b8.md#repair-order-and-current-assignment). Passing automatic checks does not close the later tickets' missing production or live gates. From the repository root, enter `projects/wa-scribe/` before running project commands.

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
