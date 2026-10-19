# T04–T13 stack review — changes requested

Reviewed cumulative HEAD `b4ff2b864bcd2a3e993d64d7cd4f16ad2a5080cb`, based on T03 `9f5ad6398d71ccd5903be91082dda9c14a147881`. This is a review of the aggregate code and interfaces, not separate acceptance of every historical commit. No PR was merged or published by this review. T01/T02 retain their earlier acceptance. The handoff's T03 acceptance label does not resolve the independent [T03 findings](T03-9f5ad63.md), which remain in the unchanged code.

The checks pass, but the stack is not ready for a WhatsApp pilot. Findings below were reproduced with synthetic inputs, source copies or a TypeScript import loader outside the checkout. No real account, chat, or Drive file was touched. P0 follows this repository's review definition for demonstrated data loss, identity/privacy failures, or unsafe recovery; it describes the intended workflow's risk, not an incident involving user files. Most later helpers have no production caller yet.

## Findings, ordered by severity

### R01 — P0: recovery overwrites post-interruption Notes

T08, `src/journal.ts:43–48`: after a simulated crash at the Markdown boundary, edit the current Notes, then call `recover`. It replaces the edited document with the staged Markdown and returns Committed. Retain expected pre/post-write versions in the journal and verify current content before any recovery write or cleanup. Unexpected content must remain intact with a conflict/recovery result. Test the Notes edit between crash and recovery, not just uninterrupted journal replay.

### R02 — P0: unchanged Download/Edit discards partial local edits

T06/T07, `src/download.ts:102`, `:161–171`, `src/edit.ts:53–57`: equal block count bypasses local-content checks; rendering reconstructs old metadata wording. Save `m1="original"`, change its body locally to `"my local edit"`, and observe unchanged source. Both Download and Edit return Unchanged while returning Markdown that restores `"original"`. Preserve current generated regions where alignment is proven; otherwise pause. An Unchanged result must preserve actual input bytes, not merely compare two regenerated documents.

### R03 — P0: another chat's rows enter the selected snapshot

T05, `src/source.ts:95`: the reader verifies the first main container's account/chat, then extracts articles from the entire document. A selected chat-1 container plus an unselected chat-2 container produces a chat-1 snapshot containing both messages, including chat-2's private text. Restrict extraction to the verified selected container and reject mixed/ambiguous ownership. Add a two-container fixture and an assertion that unselected text never enters the snapshot.

### R04 — P0: mismatched export bindings mix account/chat data

T06, `src/download.ts:223–227`: existing account/chat/destination/generation fields silently override `input.binding`. Supply metadata for A, binding B, one overlapping ID, and a new B message. The result includes B content under A's binding. Validate all binding fields before reconciliation and require source expectation, binding, and existing metadata to agree. Add a separate regression for each mismatched field; no output mutation on mismatch.

### R05 — P0: same-operation retry discards unresolved journal state

T08, `src/journal.ts:69–89`: an unresolved journal blocks a different generation or operation, but the same pair may replace `unknownMutation: true` with caller-supplied false. The reproduced retry commits replacement text, drops the journal, and removes cleanup media without resolving the old mutation. Pause every unresolved operation until supported evidence resolves it; matching IDs do not authorize replay or replacement. Test same-operation/same-generation retries as well as newer-operation rejection.

### R06 — P0: Edit loses local ownership on repeat or source deletion

T07, `src/edit.ts:45`, `:48–55`: a local/source conflict preserves local wording once, then the identical next Edit replaces it with the already-observed source wording and reports no conflict. Separately, a positive source deletion skips a locally edited block before checking local changes and deletes the local text without a conflict. Preserve unresolved local ownership/baselines across passes; check current block fingerprints before every source update or deletion. Add both sequences, including sender/attachment/header changes rather than body-only comparisons.

### R07 — P0: late completion can resolve a different file or export root

T04, `src/files.ts:126–136`: `applyLate` checks operation/account but not the original root, expected parent, or update target. A pending update to `note-1` accepts `other-file`, adds it to ownership, and clears the actual pending update. A pending root-1 operation also resolves into a current root-2 tree. Validate all original bindings, generation/operation evidence, expected update identity and parent before resolving uncertainty. Preserve pending state on every mismatch.

### R08 — P0: media enrichment overwrites a locally edited marker

T11, `src/media.ts:79–84`: change a pending attachment limitation locally, then pass a successful retry to `enrich`. It replaces that region without checking a committed marker baseline or current block fingerprint. Compare the current region with the committed baseline before replacing it, and preserve/report conflict on local change. Tombstone suppression alone does not cover local edits.

### R09 — P1: Drive file creation does not use a valid upload protocol

T04, `src/files.ts:196–205`, `:208–212`: a create sends metadata JSON, a newline, and raw file bytes to the metadata-only `/drive/v3/files` endpoint, without multipart framing or content type. For `# hello\n`, the body is invalid JSON and the protocol-aware fake returns 400. Use a documented Drive upload protocol, preserve MIME/content-type headers through the transport, and assert the captured wire request, metadata parents, and exact binary bytes. The [official create reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create) distinguishes metadata and upload endpoints. Do not defer a malformed request to owner testing.

### R10 — P1: partial history overlap invents order and clears a gap

T06, `src/download.ts:56–71`, `:117–125`: save `[a,c]` with `contiguous: false`, then observe contiguous `[a,b]`. Actual output is `[a,c,b]`, no gaps, `sourceOrder: verified`. It violates the observed adjacency and never established the relation from b to c. Merge verified adjacency/anchor evidence, retaining or subdividing unbridged gaps. Add this sequence across repeated passes rather than only full-overlap examples.

### R11 — P1: an old callback releases a different job's writer

T09, `src/jobs.ts:97–101`: stop job-1, start job-2, then deliver `markSaved(job-1)`. It marks the stopped job committed and unconditionally clears `writerId`. Starting job-3 then succeeds while job-2 is still collecting. Validate lifecycle, binding/generation and writer ownership before completion/release. Apply the same guard to stop/disconnect callbacks; stale callbacks must not release another job. Persistence and one actual writer boundary are still required before the same-profile guarantee can be accepted.

### R12 — P1: the alpha reports Updated after a refused commit

T10, `src/alpha.ts:70–75`: with an unresolved journal for a different operation, `commitChat` returns recovery-required and leaves the desk empty, but the alpha reports Updated and populated message IDs. Propagate the commit/recovery phase and report saved success only after a coherent commit. Test blocked, aborted, paused, and recovery outcomes through this caller.

### R13 — P1: byte count is treated as proof of an original attachment

T11, `src/media.ts:15–22`, `:67–75`: arbitrary 80-byte data labeled PNG and a tiny valid PNG are classified Original and returned as Saved. No verified original-resource or completeness evidence exists in the input; a thumbnail/truncated response can therefore become a successful original link. Separate format sniffing from original/completeness evidence supplied by the browser adapter. Without that evidence, retain an honest unverified/unavailable state; a size threshold or self-computed hash is insufficient.

### R14 — P1: repeated fresh starts collide

T12, `src/lifecycle.ts:18–23`: every `freshExport("root-1")` returns `root-1-fresh` and `root-1-g2`. A second recovery attempt selects the same supposedly new tree/generation. Allocate a genuinely new destination root and generation, record the returned identities, and retain prior trees. Test two fresh starts after failures against existing roots; concatenating a Drive ID does not create a new root.

### R15 — P1: checkpoint restoration lacks validity and binding checks

T12, `src/lifecycle.ts:27–29`: every non-null value becomes Restored, including unsupported version 999 and a different account. The helper has no expected binding or content validation, and no production validator wraps it. Restore only a validated checkpoint for the expected account/chat/destination/generation after resolving compatible pending state. Preserve recovery-required and all original files on invalid input.

### R16 — P1: ticket completion claims omit required production code

`README.md:7`, `START_HERE.md:1` describe coding through T13 as complete. `src/manifest.ts:76` registers no production content script or WhatsApp access; the reader understands only invented fixture attributes. `jobs.ts` has no production caller or persistent state boundary. `src/content.ts:29–38` runs fixture alpha with hard-coded identities and a new empty desk on each page load; `alpha.ts` never calls Drive. Media/lifecycle helpers are unused except the Edit-warning string, and `src/panel.html:42–43` leaves Edit/Delete disabled with no chat-selection, Download, Stop, unmark or recovery workflow. T08 is an in-memory desk/journal reducer, not a persistent destination transaction implementation. These are missing implementations, beyond unrun live checks. Relabel the branches as unaccepted prototypes, reopen the missing acceptance work, and implement one reviewed vertical slice before the owner pilot. Keep existing drafts available; no need to discard them.

## Verification and limits

On Node 24.22.0/npm 11.19.1 at the cumulative HEAD, the coordinator reproduced:

- `npm run typecheck`: passed.
- `npm run test:unit`: 16 files, 64 passed, no failures or skips. This includes the T12 cases requested for rerun; historical per-ticket local runs were not all independently repeated.
- `npm run test:browser`: 2 passed, no failures or skips, real unpacked extension/local fixture.
- `npm run build`: passed.
- `node scripts/package-release.mjs`: created five-file ZIP; Python `zipfile.testzip()` verified CRCs/structure. The manifest has no production content script, and Edit/Delete remain disabled. A valid ZIP is not export feature acceptance.
- Every submitted T04–T13 SHA has both push/PR wa-scribe CI runs completed successfully. T13 runs: [39335679508](https://github.com/orenda/wa_llm/actions/runs/39335679508), [39335663613](https://github.com/orenda/wa_llm/actions/runs/39335663613).
- Python source/dependencies, accepted codec, npm lockfile, and CI are unchanged by T04–T13.

The edge-case catalog verifies ID-to-test-text references. It does not establish all 42 behavioral contracts: the failure sequences above pass outside that suite while violating those contracts. Add production-behavior regressions, not more keyword/count checks. Live OAuth, actual Drive writes/protection, real WhatsApp identity/selectors/media, measured budgets and the pilot remain unrun. The owner cannot manually test export controls that do not exist.

## Stack identities

| Ticket | Draft PR | Exact head |
| --- | --- | --- |
| T03 | [35](https://github.com/orenda/wa_llm/pull/35) | `9f5ad6398d71ccd5903be91082dda9c14a147881` |
| T04 | [36](https://github.com/orenda/wa_llm/pull/36) | `29833331384139401657e6486ef2c1d7f2132c4c` |
| T05 | [37](https://github.com/orenda/wa_llm/pull/37) | `416c6f09befacdcd07e373a5d42f9aafab71ecf0` |
| T06 | [38](https://github.com/orenda/wa_llm/pull/38) | `bed2b4aff57b71f3f9dfe632145f33cb8eebdc64` |
| T07 | [39](https://github.com/orenda/wa_llm/pull/39) | `c5801008f5e1151fb5064453a724f989e89da303` |
| T08 | [40](https://github.com/orenda/wa_llm/pull/40) | `408aad9bee1e6a96f7889bbea681d404828bd7ef` |
| T09 | [41](https://github.com/orenda/wa_llm/pull/41) | `a0f05d9b71d8ca722231167d39a311a023f71447` |
| T10 | [42](https://github.com/orenda/wa_llm/pull/42) | `6c31743e58fe0c1c05f0e63ee94eaa1f2946f435` |
| T11 | [43](https://github.com/orenda/wa_llm/pull/43) | `745fa2d69eba351b58dc41109bcb40c6c2b3b8dc` |
| T12 | [44](https://github.com/orenda/wa_llm/pull/44) | `b1df08fb0aa6e9e5ee562ab8004d7448b5ea3d58` |
| T13 | [45](https://github.com/orenda/wa_llm/pull/45) | `b4ff2b864bcd2a3e993d64d7cd4f16ad2a5080cb` |

## Repair order and current assignment

1. **Current assignment: T03 fixes only.** Continue on `cursor/wa-scribe-t03-e20a` from `9f5ad6398d71ccd5903be91082dda9c14a147881`, following [its three exact findings](T03-9f5ad63.md). Enforce the panel's expected account before writes; bind warning acknowledgment to a durable operation revision; complete/refresh Busy panels on caught failure and worker loss. Run all four npm checks and CI, submit the exact SHA and stop. Do not add another ticket or merge/publish.
2. After review, repair T04 R07/R09, then restack its dependents without overwriting existing work. Each updated SHA needs its own review. Establish valid raw-file I/O and known/unknown outcome behavior before using the adapter in transactions.
3. Repair T05 R03 and T06/T07 R02/R04/R06/R10 as separate bounded submissions. Regressions must exercise actual privacy boundaries and sequential histories/local conflicts. Scope the real WhatsApp diagnostic/identity capability separately from the fixture reader; a live gate does not authorize guessing selectors or IDs.
4. Repair T08 R01/R05, then supply the required persistent journal/destination boundary. Repair T09 R11 and persist its guarded lifecycle. Review before T10 orchestration.
5. Repair T10 R12 and implement an actual one-chat text Download-to-Drive flow behind explicit selection and user action. First prove it offline end to end using the real adapters with controlled external boundaries; then prepare the owner-operated capability pass.
6. Repair T11 R08/R13 and T12 R14/R15, adding actual staged-byte, deletion/recovery and UI integration in small submissions. Preserve original evidence, local ownership, generations and tombstones at each boundary.
7. T13 hardening and a pilot follow working, accepted behavior. Retain the ZIP/checklist as useful draft artifacts; do not treat catalog IDs, disabled buttons, or file packaging as release readiness.

Keep code compact and direct, add no frameworks or new dependencies without a concrete reviewed need, preserve unrelated files, and use the project completion template. Real Google configuration/consent remains an owner action; do not request tokens in chat or automatically operate accounts from a handoff document. No live probe or publication was performed during this review.
