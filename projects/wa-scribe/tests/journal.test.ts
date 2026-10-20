import { describe, expect, it } from "vitest";
import { commitChat, JOURNAL_SCHEMA, MAX_JOURNAL_BYTES, recover, stopCommit, type Desk, type Journal } from "../src/journal";
import type { Binding } from "../src/model";

const binding: Binding = { accountId: "acct-1", chatId: "chat-1", destinationId: "dest-1", generation: "g1" };

function desk(): Desk {
  return { markdown: "old-md", metadata: "old-meta", mediaIds: ["keep", "orphan"] };
}

function commit(failAt: Journal["step"] | null, extra: Partial<Parameters<typeof commitChat>[0]> = {}) {
  return commitChat({
    desk: desk(),
    journal: null,
    binding,
    operationId: "op-1",
    generation: "g2",
    markdown: "new-md",
    metadata: "new-meta",
    cleanupIds: ["orphan"],
    unknownMutation: false,
    failAt,
    capturedMarkdown: "old-md",
    currentMarkdown: "old-md",
    ...extra,
  });
}

describe("per-chat journal", () => {
  it("finishes a crash between transcript and metadata without reading it as a deletion", () => {
    const crashed = commit("markdown");
    expect(crashed.desk).toEqual({ markdown: "new-md", metadata: "old-meta", mediaIds: ["keep", "orphan"] });
    expect(crashed.phase).toBe("recovery-required");
    const recovered = recover(crashed.desk, crashed.journal, binding);
    expect(recovered.phase).toBe("committed");
    expect(recovered.journal).toBeNull();
    expect(recovered.desk).toEqual({ markdown: "new-md", metadata: "new-meta", mediaIds: ["keep"] });
  });

  it("keeps cleanup retryable and blocks a newer generation while a mutation is unknown", () => {
    const cleanup = commit("cleanup");
    expect(cleanup.desk.mediaIds).toEqual(["keep", "orphan"]);
    const done = recover(cleanup.desk, cleanup.journal, binding);
    expect(done.desk.mediaIds).toEqual(["keep"]);

    const unknown = commit(null, { unknownMutation: true });
    expect(unknown.phase).toBe("recovery-required");
    expect(unknown.desk.mediaIds).toEqual(["keep", "orphan"]);
    const newer = commitChat({
      desk: unknown.desk,
      journal: unknown.journal,
      binding,
      operationId: "op-2",
      generation: "g3",
      markdown: "newer",
      metadata: "newer-meta",
      cleanupIds: [],
      unknownMutation: false,
      failAt: null,
      capturedMarkdown: null,
      currentMarkdown: null,
    });
    expect(newer.phase).toBe("blocked");
    expect(newer.desk).toEqual(unknown.desk);
    const reread = recover(unknown.desk, unknown.journal, binding);
    expect(reread.phase).toBe("recovery-required");
    expect(reread.journal?.unknownMutation).toBe(true);
  });

  it("aborts on a detected edit, pauses an incompatible schema, and does not roll back a stopped write", () => {
    const edited = commit(null, { currentMarkdown: "user-changed" });
    expect(edited.phase).toBe("aborted");
    expect(edited.desk.markdown).toBe("old-md");

    const foreign: Journal = {
      schema: JOURNAL_SCHEMA + 1,
      binding,
      operationId: "op-9",
      generation: "g9",
      step: "markdown",
      markdown: "x",
      metadata: "y",
      cleanupIds: ["keep"],
      unknownMutation: false,
    };
    const paused = recover(desk(), foreign, binding);
    expect(paused.phase).toBe("paused");
    expect(paused.desk).toEqual(desk());
    expect(paused.journal).toBe(foreign);

    const stopped = stopCommit(commit("markdown").desk, commit("markdown").journal);
    expect(stopped.desk.markdown).toBe("new-md");
    expect(stopped.phase).toBe("recovery-required");
    expect(MAX_JOURNAL_BYTES).toBeGreaterThan(1000);
  });

  it("preserves Notes byte-for-byte through recovery and pauses for a different binding", () => {
    const notes = "## Notes\r\n\r\nKeep my exact bytes.  \r\n";
    const noteCommit = commit("markdown", { markdown: `${notes}new transcript` });
    const recovered = recover(noteCommit.desk, noteCommit.journal, binding);
    expect(recovered.desk.markdown?.slice(0, notes.length)).toBe(notes);

    const crashed = commit("markdown");
    const otherBinding = { ...binding, accountId: "acct-other" };
    expect(recover(crashed.desk, crashed.journal, otherBinding)).toMatchObject({ phase: "recovery-required", desk: crashed.desk });
  });
});
