# Current assignment: T03 fixes, then staged stack review

T01 and T02 are accepted. T03 remains at `9f5ad6398d71ccd5903be91082dda9c14a147881` with [three remaining review findings](docs/reviews/T03-9f5ad63.md). T04–T13 exist as stacked draft prototypes; see the [cumulative review and repair order](docs/reviews/STACK-b4ff2b8.md). They are not accepted or ready for the pilot. Production still has no WhatsApp reader or working export.

## Copy this prompt

```text
Repository: https://github.com/orenda/wa_llm
Project directory: projects/wa-scribe/
Continue branch: cursor/wa-scribe-t03-e20a
Base: 9f5ad6398d71ccd5903be91082dda9c14a147881

Read AGENTS.md and docs/tasks/T03.md. Read the coordinating review at:
https://github.com/orenda/wa_llm/blob/codex/wa-scribe-stack-review/projects/wa-scribe/docs/reviews/T03-9f5ad63.md

Fix T03 only: bind each probe to the account shown by its initiating panel;
bind warning acknowledgment to the actual pending operation revision;
notify/refresh reopened Busy panels on exceptions and worker loss.
Write meaningful production-wiring and failure-sequence regressions.
Preserve the existing unknown-write handling and only drive.file scope.
Keep code compact, avoid new frameworks/dependencies, and leave the accepted
codec, Python project, and CI unchanged. All automatic tests stay offline.

Run typecheck, test:unit, test:browser, and build plus CI. Return exact base/head
SHAs, changed behavior/files, actual test counts/results, and unrun live gates.
Stop for coordinator review. Do not merge, publish, restack other branches,
start another ticket, or call T04–T13 complete in this submission.
```

The review files are on `codex/wa-scribe-stack-review`. To read them without changing an existing working branch, fetch that branch and use `git show FETCH_HEAD:projects/wa-scribe/docs/reviews/T03-9f5ad63.md`. Preserve local changes and use the existing checkout; no extra Git worktree is needed.

After T03 review, repair/review dependent tickets in the order recorded in the stack review. Restacking is a separate coordinated step. Google console configuration and the user's Chrome consent remain prerequisites for live proof; test passing cannot supply missing production code or a missing account session.
