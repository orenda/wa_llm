import { describe, expect, it } from "vitest";
import { enrich, sampleErrorPage, shouldRetry, slotPath, stageAttachment } from "../src/media";
import type { MessageDraft, Timestamp } from "../src/model";

const minute: Timestamp = { display: "09:41", precision: "minute", timeZone: null, instant: null };
const encoder = new TextEncoder();

function message(attachments: MessageDraft["attachments"] = []): MessageDraft {
  return {
    id: "m7",
    sender: { key: null, name: "Dana" },
    timestamp: minute,
    sequence: "verified",
    text: "Caption stays",
    limitation: null,
    attachments,
    sourceBaseline: "caption",
    savedWordingBaseline: "caption",
  };
}

describe("attachment slots", () => {
  it("keeps an unknown original opaque and rejects a thumbnail or error page", () => {
    const opaque = stageAttachment({
      chatKey: "c7a18d2f",
      messageId: "m7",
      slot: 1,
      name: "clip",
      claimedType: null,
      bytes: encoder.encode("wa-s-bytes-original"),
      tombstoned: false,
    });
    expect(opaque).toMatchObject({ slot: 1, attachment: { state: "opaque", relativePath: "media/c7a18d2f/m7-01.bin" } });
    expect(JSON.stringify(opaque)).not.toContain("://");
    const thumb = stageAttachment({
      chatKey: "c7a18d2f",
      messageId: "m7",
      slot: 1,
      name: "thumb",
      claimedType: "image/jpeg",
      bytes: encoder.encode("tiny"),
      tombstoned: false,
    });
    expect(thumb).toMatchObject({ attachment: { state: "unavailable", limitation: "thumbnail" } });
    const page = stageAttachment({
      chatKey: "c7a18d2f",
      messageId: "m7",
      slot: 1,
      name: "page",
      claimedType: "text/html",
      bytes: sampleErrorPage(),
      tombstoned: false,
    });
    expect(page).toMatchObject({ attachment: { state: "unavailable", limitation: "error-page" } });
    expect(stageAttachment({ chatKey: "c7a18d2f", messageId: "m7", slot: 2, name: "x", claimedType: null, bytes: null, tombstoned: true })).toEqual({
      suppressed: true,
    });
  });

  it("fills a missing album slot later without renumbering or changing wording", () => {
    const pending = stageAttachment({ chatKey: "c7a18d2f", messageId: "m7", slot: 2, name: "gap", claimedType: null, bytes: null, tombstoned: false });
    expect(pending).toMatchObject({ slot: 2, attachment: { state: "pending" } });
    const saved = message([
      { slot: 1, attachment: { state: "saved", name: "a.jpg", mediaType: "image/jpeg", relativePath: slotPath("c7a18d2f", "m7", 1, "jpg") } },
      pending as { slot: number; attachment: { state: "pending"; limitation: string } },
      { slot: 3, attachment: { state: "saved", name: "c.jpg", mediaType: "image/jpeg", relativePath: slotPath("c7a18d2f", "m7", 3, "jpg") } },
    ]);
    const filled = stageAttachment({
      chatKey: "c7a18d2f",
      messageId: "m7",
      slot: 2,
      name: "b.jpg",
      claimedType: "image/jpeg",
      bytes: encoder.encode("x".repeat(80)),
      tombstoned: false,
    });
    expect("slot" in filled).toBe(true);
    if (!("slot" in filled)) return;
    const enriched = enrich(saved, filled, false);
    expect("text" in enriched && enriched.text).toBe("Caption stays");
    if (!("attachments" in enriched)) return;
    expect(enriched.attachments.map((entry) => entry.slot)).toEqual([1, 2, 3]);
    expect(enriched.attachments[1]?.attachment.state).toBe("saved");
    expect(shouldRetry("unsupported", 0, false)).toBe(false);
    expect(shouldRetry("pending", 1, false)).toBe(true);
    expect(shouldRetry("pending", 3, false)).toBe(false);
  });
});