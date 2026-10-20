# Owner checks for the installable alpha

Follow [INSTALL.md](INSTALL.md). The owner's first Chrome check is blocked by conversation-ID detection with visible messages. Use the 0.1.2 Identity diagnostic before proceeding. TypeScript and all 93 unit tests passed on Node 24.22.0 for `6745c9d`; browser/live export checks remain unverified.

Start with one low-sensitivity chat, Download mode, Rendered messages, and 20 messages. Record version/Chrome/OS/WhatsApp locale and visible outcomes without sharing message text, account IDs, tokens or private links.

- Load the unpacked ZIP, then reload WhatsApp Web and open the panel from the extension icon.
- Without OAuth configuration, Add current chat and Refresh work; Drive connection/export stays unavailable.
- Configure the public client ID using the fixed extension ID. Replace the downloaded manifest, reload, Connect, and verify the authenticated Google account.
- Run the optional synthetic probe separately if desired. Connect itself must create no files.
- Add the open conversation and Sync. Open the export and inspect transcript.md and sync.json. Only the selected conversation may appear.
- Repeat the same pass. Verify no duplicate IDs, no fabricated timestamp precision, and explicit partial history/media limitations.
- Add Notes above ## Transcript, preserving CRLF if desired. Repeat and compare exact Notes bytes.
- Partially edit a generated message. Both modes must preserve it and pause. Do not accept a successful overwrite.
- Remove one whole generated block, then repeat with unambiguous alignment. Verify its tombstone persists.
- Change source wording. Download keeps the saved wording; Edit changes only a locally unchanged block. An absent DOM row is not a deletion.
- Try older loaded history at small limits. Newly revealed old/middle IDs must not be discarded by last-sync timestamps. Unverified gaps/order remain partial or paused.
- Stop, unselect the active chat, switch chats, close/reload the tab, and restart Chrome at separate boundaries. Collection never resumes without a click; pending Drive generations remain explicit.
- Recover an interrupted generation only after reconnecting the bound Google account. A changed transcript/sidecar must pause recovery rather than erase edits.
- While a save or cleanup is unresolved, Start fresh must fail without changing the staged content or IDs, including after restarting the worker. Once resolved, Start fresh keeps the previous Open export link until a replacement is published, exposes archived root links and does not silently inherit tombstones.
- Compare the panel's coverage reason with `sync.json` after rendered, message-, byte- and time-limited passes and an identical resync. None is a complete-archive claim.
- Confirm Delete on one generation. Only recorded transcript/sidecar files are trashed; folders, foreign children and untracked media remain. A retained-folder link stays available. Interrupted deletion must remain retryable and block sync of that old generation.
- During a long multi-chat job, Recover/Start fresh/Delete stay disabled and polling continues past two minutes; Stop, Refresh and unselect remain available.
- Register a second chat. A selected chat not currently open reports a pause rather than navigating by name; another chat's result remains independent.
- Verify each media envelope reports unavailable/unsupported originals honestly; thumbnails and view-once media must never become successful original links.

Run the automatic commands in INSTALL.md yourself. Do not treat the historical passing counts from earlier drafts as this alpha's results. Full v1/live-media acceptance remains open until capability evidence exists.
