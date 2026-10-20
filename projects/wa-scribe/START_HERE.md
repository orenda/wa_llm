# Installable alpha: owner verification next

The integrated source is on `codex/wa-scribe-complete`. For source `acdb65c`, the owner authorized typecheck/unit tests: TypeScript and all 85 unit tests passed on Node 24.22.0. The production ZIP includes that source. Browser tests, CI and live Google/WhatsApp operations remain unrun.

[Install the ZIP and configure Google Drive](docs/INSTALL.md). The panel can add the currently open WhatsApp conversation, select known chats, run bounded Download/Edit, stop, recover a staged Drive generation, start fresh, and delete owned export files after confirmation. Media with unverified originals remains explicitly unavailable. If stable account/chat identity is unavailable, the adapter pauses instead of guessing.

The 0.1.1 repair addresses the owner's alpha review: fresh cannot clear unresolved work, bounded coverage is recorded consistently, old/retained folder links remain accessible, and job controls/polling reflect the running operation. See [the repair record](docs/reviews/ALPHA-40a334e.md) and run `tests/review-repro.test.ts` with the pinned toolchain before a pilot.

The owner runs the tests listed in INSTALL.md and then the low-sensitivity Chrome/Drive checks. Do not copy historical passing counts into this delivery's results or claim a verified v1 release. Earlier draft/review records are retained under docs/reviews/ for traceability.
