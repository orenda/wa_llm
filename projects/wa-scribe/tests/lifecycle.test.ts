import { describe, expect, it } from "vitest";
import { accountChanged, aggregate, deleteExport, editModeWarning, freshExport, restoreCheckpoint, richMarker } from "../src/lifecycle";
import type { Binding } from "../src/model";

const binding: Binding = { accountId: "acct-1", chatId: "chat-1", destinationId: "dest-1", generation: "g1" };

const files = [
  { id: "md", generation: "g1", kind: "transcript" as const },
  { id: "meta", generation: "g1", kind: "metadata" as const },
  { id: "pic", generation: "g1", kind: "media" as const },
  { id: "old", generation: "g0", kind: "media" as const },
  { id: "notes-foreign", generation: "g1", kind: "foreign" as const },
];

describe("pause, delete, and recovery", () => {
  it("warns before Edit and deletes only the selected generation", () => {
    expect(editModeWarning()).toContain("Finish editing");
    const done = deleteExport(files, "g1");
    expect(done.deleted).toEqual(["md", "meta", "pic"]);
    expect(done.foreign).toEqual(["old", "notes-foreign"]);
    const partial = deleteExport(files, "g1", 1);
    expect(partial.deleted).toEqual(["md"]);
    expect(partial.remaining).toEqual(["meta", "pic"]);
  });

  it("starts a fresh generation beside the old tree and can restore a checkpoint", () => {
    const fresh = freshExport("root-1");
    expect(fresh.previousRoot).toBe("root-1");
    expect(fresh.rootId).toBeNull();
    expect(fresh.rootPlan).toBe("allocate-new-root");
    expect(fresh.warning).toContain("tombstones");
    expect(restoreCheckpoint(JSON.stringify({ generation: "g1" }), binding)).toEqual({ phase: "recovery-required" });
    expect(restoreCheckpoint(null, binding)).toEqual({ phase: "recovery-required" });
    expect(accountChanged("acct-1", "acct-2").paused).toBe(true);
  });

  it("marks rich items without opening them and does not turn one failed chat into success", () => {
    expect(richMarker("view-once", "visible caption").opened).toBe(false);
    expect(richMarker("quote", "quoted line").text).toBe("quoted line");
    expect(richMarker("poll", "Lunch?").limitation).toContain("unsupported");
    const summary = aggregate([
      { chatId: "chat-1", result: "complete for requested scope" },
      { chatId: "chat-2", result: "partial" },
    ]);
    expect(summary).toEqual({ overall: "partial", failed: ["chat-2"] });
  });
});
