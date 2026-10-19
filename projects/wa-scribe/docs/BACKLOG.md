# Implementation backlog

**T01 and T02 accepted. T03 findings remain; T04–T13 are unaccepted drafts, with correctness fixes and production integration outstanding.** See the [exact-SHA stack review and repair order](reviews/STACK-b4ff2b8.md). T02's [review](reviews/T02-500480a.md) and T01's [review](reviews/T01-49b528a.md) remain the accepted baselines. No real WhatsApp/Drive verification is recorded. Work in `projects/wa-scribe/` inside the `wa_llm` repository. The coordinator reviews each new SHA; a handoff's completion label does not establish that its requirements were implemented or tested.

Product behavior is defined by [SPEC](SPEC.md), [TESTPLAN](TESTPLAN.md), and the [42 edge cases](EDGECASES.md). This backlog orders the work; it does not weaken those contracts. Local-folder export, agents, model calls, and message sending are outside the initial Drive delivery.

| ID | Deliverable | Depends on | Minimum acceptance evidence |
| --- | --- | --- | --- |
| T01 | Extension skeleton and executable test harness — accepted | None | [Accepted review](reviews/T01-49b528a.md); strict check/build and real unpacked-extension interaction on a fixture. |
| T02 | [Data contracts and reversible Markdown format — accepted](tasks/T02.md) | T01 | [Accepted codec review](reviews/T02-500480a.md); golden round trips, prefix preservation, metadata validation, canonical attachment fields, and strict known instants. |
| T03 | [Chrome identity connection and synthetic Drive probe — changes requested](tasks/T03.md) | T01 | [Remaining review findings](reviews/T03-9f5ad63.md), then authorized live consent/Drive evidence. |
| T04 | Minimal Drive file adapter and known/unknown operation outcomes | T02, T03 API shape | Create/read/update by owned IDs, tree-boundary checks, classified failures. Fake tests for fail-before-apply, apply-then-lose-response, apply-late. Live protection evidence remains a gate. C02–C04, C06, C08, C10. |
| T05 | WhatsApp selectors, virtualized fixture, and bounded identity probe | T01, T02 | Non-collecting diagnostic separated from explicit selected-chat probe. Account/chat/message IDs and source order verified or rejected, not invented from the fixture. H09–H10, M03. |
| T06 | Download reconciliation | T02 | New/old/middle insertion, same-timestamp distinct IDs, repeated-pass dedupe, byte-preserved Notes, whole-block tombstones. H01–H03, H06–H09, X04. |
| T07 | Edit reconciliation and local conflicts | T06 | Source edits/deletes only when observed; Download-then-Edit works; local changes/tombstones retained or reported. H07–H08, M09, X04. |
| T08 | Recoverable per-chat commits and bounded pending journal | T02, T04 | Fake-store crash at every boundary; coherent generations; no orphan cleanup before commit; unknown mutation cannot start a newer generation. C02–C05, C07, C11–C12, C14. |
| T09 | Bounded collection/job coordinator and resume | T05, T06, T08 | Persistent same-profile exclusion, frozen bindings/upper anchor, segments/gaps, Stop/unmark, independent source/save states. H04–H06, H10, C01–C02, C07–C09, C13, X06. |
| T10 | One-chat text Download → Drive alpha | T03–T06, T08–T09; relevant live capability evidence | Full fixture flow then user-operated real pass/repeat, no duplicates or unselected output. Record alpha status and actual coverage; no v1 claim. |
| T11 | Attachment staging, unknown types, retries, and enrichment | T02, T04, T07–T09 | M01–M12 with stable slots, validated original bytes, opaque unknown types, bounded resources, retained tombstones. Prove each required media kind separately. |
| T12 | Multi-chat controls, Edit UI, pause/delete/recovery | T07–T11 | Mode warning, own-generation deletion, no stale resurrection, permission/recovery states, rich-content markers. C08–C10, C13–C14, X01–X06. |
| T13 | Hardening, release ZIP, and user pilot checklist | T10–T12 | Full automatic matrix and P0 catalog; build from clean lockfile; opt-in browser/Drive checks; real 2–3-chat pilot recorded truthfully per media kind. |

Split a ticket further if its diff stops being reviewable. Subtickets keep the parent ID (for example T11a unknown-type preservation) and explicit dependency/acceptance scope. Do not bundle all rows into one implementation or one pull request.

## Early feasibility gates

- **Google:** A Cloud project with Drive API and the appropriate consent/test-user configuration, plus a Chrome-extension OAuth client tied to a stable extension ID. No client secret in the extension. The user performs Google consent from signed-in Chrome; automated tests use fakes.
- **Source identity:** T05 must show stable identity/order on the actual user-selected page before T10's live collection. Successful fake selectors are insufficient. Source edit/delete and media observations each need their own evidence.
- **Remote writes:** T04/T08 must prove their chosen operation-identity/version behavior prevents duplicate/stale writes. Never assume timeouts cancel remote requests or a local lock protects another device. Keep unresolved writes paused if the guarantee is unavailable.
- **File contract:** T02 resolves the block grammar and metadata fields before independent agents implement parsers/stores. Do not bury data-loss choices in an implementation.

The coordinator can assign T03 after T01 while T02 contracts are reviewed. T05 waits for T02's accepted types; after T02 acceptance, T04/T06 can run in parallel with clear file ownership and T04's listed API-shape dependency respected. Live gates can remain blocked while offline contract/recovery work continues; an unrun gate is never accepted as a pass.

## Current assignment

Fix **T03 only**, continuing on `cursor/wa-scribe-t03-e20a` from `9f5ad6398d71ccd5903be91082dda9c14a147881`, using its [three-finding assignment](reviews/T03-9f5ad63.md). Return for review with checks and exact SHA. Keep the later draft branches; repair and restack them in the [reviewed dependency order](reviews/STACK-b4ff2b8.md#repair-order-and-current-assignment). The ZIP/catalog/checklist are draft artifacts, not a completed T13 or a pilot pass.
