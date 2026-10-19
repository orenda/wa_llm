# T03 review — changes requested

Reviewed draft PR [#35](https://github.com/orenda/wa_llm/pull/35), exact HEAD `aabe84dd325db8efa875222d1a2aa8dfd30a0e07`, against base `be999de9632c9e8dd10ac3ba5e5c5920e873549d`. T01 and T02 remain accepted. T03 is not accepted at this SHA, and its live Google consent/Drive gate is separately blocked.

## Findings

1. **P1 — a mutating 5xx does not establish a rejected write.** `src/drive.ts:211–213` clears `pendingMutation` for every non-2xx response. A server or gateway failure can follow an applied mutation. Reproduction: let the fake server create the test folder, then return HTTP 503 or 504. The code reports `http-error`, stores `pendingMutation: false`, and later restore reports Connected without an unresolved-artifacts warning. The HTTP status is known; the write outcome is still unknown. Preserve uncertainty for mutating 5xx, retain the status separately, stop the attempt, and do not replay it. GET failures need no mutation uncertainty. Add apply-then-5xx tests and restore assertions. [Drive's error guidance](https://developers.google.com/workspace/drive/api/guides/handle-errors#500_502_503_504_errors) does not give a rollback guarantee for these errors.

2. **P1 — failure of a new attempt clears an older unresolved outcome.** `src/drive.ts:297–299` stages a new root creation using the prior record; the error branches at `:208` and `:212` then persist that record with `pendingMutation: false`. Start with an old root/file and `pendingMutation: true`; reject the next explicit fresh-root POST with 401 or 403. The immediate response still warns, but storage is now false and a later restore reports Connected with no warning. No evidence resolved the old operation. Preserve the older pending state/known IDs when a new attempt fails, distinguishing the current request from the inherited unresolved state with minimal data. Regression sequence: lost first mutation → rejected fresh attempt → restore. Do not add a general transaction/retry engine or guess that old artifacts were rolled back.

3. **P2 — a stale panel receives the prior-artifacts warning after the new mutation.** `src/drive.ts:292–299` discovers an old pending operation and immediately sends the fresh folder POST; `src/panel.ts:27–35` displays the warning only when the entire request returns. Example: two panel pages show Connected; panel A has an unknown mutation; panel B still shows Connected and clicks Run. The new folder request starts before B displays any warning. A controlled sequence reproduced `new-folder-POST: noticeShown=false`, followed by `panel-reply: noticeShown=true`. Send a preflight warning before starting a new attempt when the initiating panel has not seen the current unresolved state. Bind any acknowledgment to that state so another panel's stale result cannot bypass it. Do not automatically start a new test as part of refreshing status. Add a stale-panel regression.

4. **P2 — reopening the panel during a probe leaves it permanently Busy.** `src/panel.ts:20–23` disables both controls for `busy`, but the panel has no subsequent status refresh or completion notification. Start a probe, close its panel, then reopen it while the worker is still running. The new panel's startup restore returns Busy; the original reply belongs to the closed page, so the reopened page stays disabled after the probe ends. Restore usable status with a small bounded refresh or completion notification, never automatically rerunning consent/probe. Add a regression proving Busy clears after completion.

## Verification

Coordinator checks on pinned Node 24.22.0/npm 11.19.1, from `projects/wa-scribe/`:

| Check | Outcome |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npm run test:unit` | 5 files, 31 passed; no failures or skips. |
| `npm run test:browser` | 2 passed; real unpacked extensions and local fixture, no failures or skips. |
| `npm run build` | Passed. |
| Targeted reviewer probes | Reproduced applied-mutation/5xx uncertainty loss, old-pending → new-403 → restore state loss, and warning-after-POST ordering using unchanged source copies outside the checkout and synthetic I/O only. |
| Production artifact scan | No `ya29.`, `client_secret`, private-key header, or `refresh_token` match in the unconfigured `dist/`. |

Both GitHub Actions runs passed at the reviewed SHA: [39314642608](https://github.com/orenda/wa_llm/actions/runs/39314642608) and [39314606701](https://github.com/orenda/wa_llm/actions/runs/39314606701). The configured OAuth browser path and real Google consent/Drive operations are unrun. Passing unconfigured-shell browser tests does not prove the configured integration. Python, dependencies/lockfile, accepted codec, and CI were unchanged by the implementation.

The OAuth scope, authenticated Drive account lookup, Chrome callback identity API, public-key setup, and narrow service URLs have no additional blocking finding from this review. This is source inspection and offline evidence, not live verification.

## Coding-agent assignment

Continue on `cursor/wa-scribe-t03-e20a` from the reviewed HEAD. Read `AGENTS.md`, `docs/tasks/T03.md`, and this review. Fix these four findings with compact direct state handling and meaningful failure-sequence/UI tests. Keep automatic tests offline and preserve the Chrome token cache, single `drive.file` scope, separate Connect/Run actions, isolated new test roots, and manual cleanup. No new dependencies, generic retry/journal framework, scraper, full Drive adapter, T04, or changes to the accepted codec/Python/CI. Update the setup guide if warnings/status semantics change.

Run all four npm checks and CI; report exact base/head SHAs, counts, actual outcomes, and remaining live prerequisites. Return for coordinator review and stop. Correcting the code does not satisfy the live gate: the owner still needs the Cloud project/Drive API, consent/test-user configuration as applicable, stable public extension key and bound OAuth client, then explicitly runs the steps in `docs/GOOGLE_SETUP.md` in their own signed-in Chrome. Do not request tokens in chat, merge, or publish.
