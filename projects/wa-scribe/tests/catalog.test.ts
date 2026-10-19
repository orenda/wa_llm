import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, acceptRevision, classifyMissingFile, containsSignedUrl, stageAttachment } from "../src/media";

const root = fileURLToPath(new URL("..", import.meta.url));

type Coverage = { id: string; file: string; needle: string; live: string };

const coverage: Coverage[] = [
  { id: "H01", file: "tests/download.test.ts", needle: "inserts older and middle history", live: "Older WhatsApp history after earlier syncs is left for owner testing." },
  { id: "H02", file: "tests/download.test.ts", needle: "unverified-between", live: "A real gap between two saved messages is left for owner testing." },
  { id: "H03", file: "tests/download.test.ts", needle: "disjoint window is unknown", live: "Joining two real inspected windows is left for owner testing." },
  { id: "H04", file: "tests/jobs.test.ts", needle: "above-upper-anchor", live: "Messages that arrive while scrolling a real chat are left for owner testing." },
  { id: "H05", file: "tests/jobs.test.ts", needle: "source-disconnected", live: "A spinner or timeout on WhatsApp is left for owner testing." },
  { id: "H06", file: "tests/download.test.ts", needle: "disjoint window is unknown", live: "A vanished resume anchor on WhatsApp is left for owner testing." },
  { id: "H07", file: "tests/download.test.ts", needle: "locally deleted block tombstoned", live: "A tombstoned message reappearing in WhatsApp is left for owner testing." },
  { id: "H08", file: "tests/edit.test.ts", needle: "positively deleted", live: "An old source edit or delete-for-everyone is left for owner testing." },
  { id: "H09", file: "tests/download.test.ts", needle: "same-timestamp ids distinct", live: "Timezone, DST, and Today/Yesterday labels are left for owner testing." },
  { id: "H10", file: "tests/source.test.ts", needle: "does not match the selected conversation", live: "A real chat switch during collection is left for owner testing." },
  { id: "C01", file: "tests/jobs.test.ts", needle: "partial-commit", live: "WhatsApp disconnecting while Drive still works is left for owner testing." },
  { id: "C02", file: "tests/jobs.test.ts", needle: "pending-save", live: "Drive disconnecting after collection is left for owner testing." },
  { id: "C03", file: "tests/files.test.ts", needle: "lost response", live: "A live Drive write whose response is lost is left for owner testing." },
  { id: "C04", file: "tests/files.test.ts", needle: "aborted write stopped", live: "A late live write after a newer plan is left for owner testing." },
  { id: "C05", file: "tests/journal.test.ts", needle: "crash between transcript and metadata", live: "Killing the browser between transcript and metadata is left for owner testing." },
  { id: "C06", file: "tests/files.test.ts", needle: "rate limits", live: "Live token expiry, quota, and rate limits are left for owner testing." },
  { id: "C07", file: "tests/jobs.test.ts", needle: "stops and unmarks", live: "Closing the browser during an upload is left for owner testing." },
  { id: "C08", file: "tests/drive.test.ts", needle: "pauses a changed account", live: "A real Google or WhatsApp account change is left for owner testing." },
  { id: "C09", file: "tests/jobs.test.ts", needle: "allows one writer", live: "Two devices using one export are not excluded. Same-profile exclusion is only the local writer check." },
  { id: "C10", file: "tests/files.test.ts", needle: "name-adoption", live: "Renaming or deleting the live Drive folder is left for owner testing." },
  { id: "C11", file: "tests/journal.test.ts", needle: "aborts on a detected edit", live: "A fingerprint check does not close a concurrent Notes edit. That race is left for owner testing." },
  { id: "C12", file: "tests/journal.test.ts", needle: "incompatible schema", live: "Updating the extension while a journal is pending is left for owner testing." },
  { id: "C13", file: "tests/jobs.test.ts", needle: "unmarks without deleting", live: "Unmark or delete while a live transfer is queued is left for owner testing." },
  { id: "C14", file: "tests/journal.test.ts", needle: "cleanup retryable", live: "Attachment cleanup failing after Edit is left for owner testing." },
  { id: "M01", file: "tests/media.test.ts", needle: "m7-01.bin", live: "An unknown MIME from WhatsApp is left for owner testing." },
  { id: "M02", file: "tests/media.test.ts", needle: "state: \"pending\"", live: "A message with no delivered bytes is left for owner testing." },
  { id: "M03", file: "tests/source.test.ts", needle: "unidentified row", live: "A WhatsApp row with no stable id is left for owner testing." },
  { id: "M04", file: "tests/media.test.ts", needle: "error-page", live: "A thumbnail or login page from WhatsApp is left for owner testing." },
  { id: "M05", file: "tests/media.test.ts", needle: "not.toContain(\"://\")", live: "An expired blob or signed URL on WhatsApp is left for owner testing." },
  { id: "M06", file: "tests/catalog.test.ts", needle: "attachment byte budget", live: "The 32 MiB attachment budget is provisional and was not measured on WhatsApp." },
  { id: "M07", file: "tests/media.test.ts", needle: "without renumbering", live: "A real album with one failed slot is left for owner testing." },
  { id: "M08", file: "tests/catalog.test.ts", needle: "revision-changed", live: "Caption or media changing during a live transfer is left for owner testing." },
  { id: "M09", file: "tests/download.test.ts", needle: "local-deletion", live: "Deleting a local block before a media retry is left for owner testing." },
  { id: "M10", file: "tests/media.test.ts", needle: "Caption stays", live: "A later retry enriching one slot is left for owner testing." },
  { id: "M11", file: "tests/catalog.test.ts", needle: "missing-bytes", live: "Removing an owned media file from Drive is left for owner testing." },
  { id: "M12", file: "tests/media.test.ts", needle: "shouldRetry(\"unsupported\"", live: "Unsupported formats are not retried until the owner asks." },
  { id: "X01", file: "tests/lifecycle.test.ts", needle: "quoted line", live: "A reply to a message outside the selected chat is left for owner testing." },
  { id: "X02", file: "tests/lifecycle.test.ts", needle: "unsupported", live: "Polls, reactions, contacts, and locations are left for owner testing." },
  { id: "X03", file: "tests/lifecycle.test.ts", needle: "view-once", live: "View-once media must not be opened. A live example is left for owner testing." },
  { id: "X04", file: "tests/format.test.ts", needle: "ambiguous-markdown", live: "Notes that look like headings in a real export are left for owner testing." },
  { id: "X05", file: "tests/lifecycle.test.ts", needle: "tombstones", live: "Reinstall with Drive files still present is left for owner testing." },
  { id: "X06", file: "tests/lifecycle.test.ts", needle: "one failed chat", live: "A 2–3 chat pilot with one failed chat is left for owner testing." },
];

describe("edge-case catalog", () => {
  it("names every catalog id and the test that covers it", () => {
    const text = readFileSync(new URL("../docs/EDGECASES.md", import.meta.url), "utf8");
    const ids = [...text.matchAll(/^\| ((?:H|C|M|X)\d{2}) \|/gm)].map((match) => match[1] ?? "");
    expect(ids).toEqual(coverage.map((row) => row.id));
    for (const row of coverage) {
      expect(row.live.length).toBeGreaterThan(0);
      expect(readFileSync(new URL(`../${row.file}`, import.meta.url), "utf8")).toContain(row.needle);
    }
  });

  it("stops an over-budget transfer and keeps an empty text document", () => {
    const over = stageAttachment({
      chatKey: "c7a18d2f",
      messageId: "m7",
      slot: 1,
      name: "long.mp4",
      claimedType: "video/mp4",
      bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
      tombstoned: false,
    });
    expect(over).toEqual({ limited: "attachment byte budget" });
    const empty = stageAttachment({
      chatKey: "c7a18d2f",
      messageId: "m7",
      slot: 2,
      name: "empty.txt",
      claimedType: "text/plain",
      bytes: new Uint8Array(),
      tombstoned: false,
    });
    expect(empty).toMatchObject({ attachment: { state: "saved", relativePath: "media/c7a18d2f/m7-02.txt" } });
  });

  it("defers a changed revision and reports a missing file without deleting the message", () => {
    expect(acceptRevision("rev-1", "rev-2", false)).toEqual({ deferred: "revision-changed" });
    expect(acceptRevision("rev-1", "rev-1", true)).toEqual({ suppressed: true });
    expect(acceptRevision("rev-1", "rev-1", false)).toEqual({ link: true });
    expect(classifyMissingFile(false, false)).toEqual({ availability: "missing-bytes", messageDeleted: false });
    expect(classifyMissingFile(false, true)).toEqual({ availability: "suppressed", messageDeleted: false });
    expect(containsSignedUrl("https://example.invalid/object")).toBe(true);
    expect(containsSignedUrl("media/c7a18d2f/m7-01.bin")).toBe(false);
    expect(root.endsWith("wa-scribe/")).toBe(true);
  });
});
