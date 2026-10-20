# Installable alpha: owner verification next

The integrated source is on `codex/wa-scribe-complete`. The owner asked the coordinating agent to implement directly and explicitly said not to run tests. No tests, probes, CI or live Google/WhatsApp operations were run for this delivery. Build and TypeScript checks are separate from those tests.

[Install the ZIP and configure Google Drive](docs/INSTALL.md). The panel can add the currently open WhatsApp conversation, select known chats, run bounded Download/Edit, stop, recover a staged Drive generation, start fresh, and delete owned export files after confirmation. Media with unverified originals remains explicitly unavailable. If stable account/chat identity is unavailable, the adapter pauses instead of guessing.

The 0.1.1 repair addresses the owner's alpha review: fresh cannot clear unresolved work, bounded coverage is recorded consistently, old/retained folder links remain accessible, and job controls/polling reflect the running operation. See [the repair record](docs/reviews/ALPHA-40a334e.md) and run `tests/review-repro.test.ts` with the pinned toolchain before a pilot.

The owner runs the tests listed in INSTALL.md and then the low-sensitivity Chrome/Drive checks. Do not copy historical passing counts into this delivery's results or claim a verified v1 release. Earlier draft/review records are retained under docs/reviews/ for traceability.
