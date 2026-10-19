# Next coding assignment: T02

This is the handoff entry point for another coding agent. Start from `codex/wa-scribe-t02-handoff` in `orenda/wa_llm`. That branch includes the accepted T01 fix commit `49b528a` and its review record; it does not require waiting for PR #33 to merge. The project is `projects/wa-scribe/` inside the repository. T02 is ready, not implemented.

Read the [coding rules](AGENTS.md), [T02 assignment and acceptance criteria](docs/tasks/T02.md), and [completion template](docs/AGENT_HANDOFF.md). The [T01 review](docs/reviews/T01-49b528a.md) records the accepted baseline. The [review checklist](docs/CODE_REVIEW.md) explains how the coordinating agent will review the result.

## Copy this prompt

```text
Repository: https://github.com/orenda/wa_llm
Starting branch: codex/wa-scribe-t02-handoff
Project directory: projects/wa-scribe/

Read the project's AGENTS.md and docs/tasks/T02.md, including its linked
contract sections. T01 has passed review. Implement T02 only: normalized
message data, versioned metadata validation, a reversible Markdown codec,
docs/FORMAT.md, and golden unit tests. Preserve Notes/prefix bytes exactly;
keep message IDs in metadata and return explicit errors for ambiguity.

Work inside projects/wa-scribe/. Keep the existing shell, toolchain, package
files, and CI unchanged. Use a couple of compact pure TypeScript modules.
No new dependencies, I/O, OAuth, Drive calls, DOM scraping, downloads, jobs,
metadata reconstruction, or Download/Edit reconciliation in this task.

Run the existing typecheck, test:unit, test:browser, and build scripts.
Test multiline/RTL/heading-like bodies, duplicate-looking messages, exact
Notes preservation, invalid metadata/version/binding, and malformed Markdown.
Automatic tests must not contact real Google or WhatsApp services.

Return the completion template from docs/AGENT_HANDOFF.md: diff, commit/base
SHA (or explicitly uncommitted), exact test commands/results/counts, and any
blocked or unrun checks. Stop for coordinating-agent review before anyone
depends on the new format. Do not self-approve, merge, or start later tickets.
```

## Obtain the files

Use an existing authorized checkout where available. Otherwise:

```bash
git clone --branch codex/wa-scribe-t02-handoff https://github.com/orenda/wa_llm.git
cd wa_llm/projects/wa-scribe
```

An existing checkout should fetch and switch to that branch while preserving its local changes. No additional Git worktree is required. The agent needs repository access if the repository is private.

The package/scripts exist and were verified for T01: seven unit cases and two browser tests passed at the accepted SHA. T02 adds format cases; report the resulting counts rather than copying the baseline. Real Google connection, WhatsApp compatibility, and future tickets remain unverified.
