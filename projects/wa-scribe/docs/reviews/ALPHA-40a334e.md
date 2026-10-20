# Alpha review repairs

The owner supplied the review of `40a334e` (0.1.0). Its findings were verified by reading the installed export path. The review's reported test failures are external evidence; this repair did not rerun them because the owner reserved tests for themselves.

## Changes in 0.1.1

- Start fresh refuses pending saves, deletion and retired-generation cleanup before changing any state. Completed generations retain their exact prior export link until replacement publication. Archived chat roots and retained folders are accessible from the panel across worker restarts.
- The collector's stop reason reaches Download/Edit and `sync.json`. Panel status derives from the resulting coverage, including publication/recovery. Repeated identical data reports Unchanged with its existing partial coverage. Legacy rendered/loaded metadata with a null reason is also treated as partial. Verified ordering is not complete-history evidence.
- Two probe assertions retain the complete stored-object contract while checking the new pending revision and account fields.
- Local-edit pauses identify conflicting message IDs. Delete confirmation describes recorded transcript/sidecar deletion and retained folders/media accurately. Conflicting controls are disabled during jobs; polling continues while a job exists with one in-flight state request and one timer.

## Regression source and validation

`tests/review-repro.test.ts` calls the installed `handleApp` worker with fake Chrome storage/ports and a simulated Drive boundary. It covers staged data/ID retention and recovery across restart, fresh refusal during cleanup/deletion, durable export links, persisted collector reasons and panel status, unchanged resync, retained deletion handles and local-edit conflict IDs. These cases exercise `export-service.ts`, rather than using the dormant ticket modules as proof of the installed alpha.

TypeScript checks and the production build are the only executed implementation checks for this repair. No tests, browser probes, CI or live Google/WhatsApp operations were run. The ZIP is an alpha for owner testing; original media remains unavailable. Older operations already discarded by 0.1.0 cannot be reconstructed by these guards.
