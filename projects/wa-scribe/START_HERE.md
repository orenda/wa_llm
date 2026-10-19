# Current coding assignment: T03 followup fixes

T03 is submitted at `9f5ad6398d71ccd5903be91082dda9c14a147881` in draft PR #35. The earlier P1 outcome findings are resolved; one P1 account-display race and two P2 corner cases remain. Read the [followup review and fix assignment](docs/reviews/T03-9f5ad63.md). Continue on `cursor/wa-scribe-t03-e20a`, run all required checks and CI after fixing those cases, and return for review. The live Google gate remains blocked/unrun. Do not start T04. The initial prompt below is historical context; use the followup assignment for this iteration.

## Initial T03 assignment

Start from `codex/wa-scribe-t03-handoff` in `orenda/wa_llm`. That branch includes T01 and the accepted T02 commit `500480a1ac30b8d9a0cfdaa41e168a9ac1991e74`, plus its [review record](docs/reviews/T02-500480a.md). It can be used without waiting for PR #34 to merge. Work in `projects/wa-scribe/`.

Read [AGENTS](AGENTS.md), the [T03 assignment](docs/tasks/T03.md), and the [completion template](docs/AGENT_HANDOFF.md). T03 is ready to implement. Live Google consent and Drive behavior remain unverified.

## Copy this prompt

```text
Repository: https://github.com/orenda/wa_llm
Starting branch: codex/wa-scribe-t03-handoff
Project directory: projects/wa-scribe/

T02 is accepted at 500480a1ac30b8d9a0cfdaa41e168a9ac1991e74.
Read AGENTS.md and docs/tasks/T03.md, including its linked contracts.
Implement T03 only: Chrome identity connection, authenticated account display,
a separately clicked bounded synthetic Drive create/read/update probe,
offline tests, and docs/GOOGLE_SETUP.md with exact owner-operated steps.

Use only the drive.file OAuth scope, Chrome's token cache, a stable extension
ID, and an isolated owned test root. No credentials in files or logs. Connect
must not write files. Preserve unknown mutation outcomes without blind replay.
Keep code compact, dependencies and accepted format unchanged, and Python
files/CI untouched. No scraper, real chats, full Drive adapter, sync, or jobs.

Run typecheck, test:unit, test:browser, and build; report actual results and
CI at the submitted SHA. Automatic tests must not contact Google/WhatsApp.
Prepare setup and manual probe instructions even if the owner's Chrome or
Google configuration is unavailable. Do not claim mocks prove live OAuth.

Return docs/AGENT_HANDOFF.md's completion report with exact base/head SHAs,
changed behavior/files, test counts, and live/blocked/unrun evidence.
Stop for coordinator review. Do not self-approve, merge, publish, or start T04.
```

## Obtain the files

Use an existing authorized checkout, preserving local changes. Otherwise:

```bash
git clone --branch codex/wa-scribe-t03-handoff https://github.com/orenda/wa_llm.git
cd wa_llm/projects/wa-scribe
```

No additional Git worktree is required. Use the pinned Node/npm versions and existing package scripts described in [README](README.md). At accepted T02, 20 unit tests and 2 browser tests passed, along with typecheck/build. Report new actual counts rather than copying this baseline. The account owner supplies Google configuration and explicitly runs consent/probe in their Chrome; implementation can be reviewed while that live gate is blocked, but T03 cannot be called fully accepted yet.
