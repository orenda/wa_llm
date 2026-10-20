import { describe, expect, it } from "vitest";
import { downloadPass, type ObservedMessage } from "../src/download";
import { editPass } from "../src/edit";
import type { Binding, Timestamp } from "../src/model";

const binding: Binding = { accountId: "acct-1", chatId: "chat-1", destinationId: "dest-1", generation: "g1" };
const minute: Timestamp = { display: "09:41", precision: "minute", timeZone: null, instant: null };
const notes = "## Notes\n\nKeep these bytes.\n";

function observed(id: string, text: string, baseline = text): ObservedMessage {
  return {
    id,
    sender: { key: "dana", name: "Dana" },
    timestamp: minute,
    sequence: "verified",
    text,
    attachments: [],
    sourceBaseline: baseline,
  };
}

function run(mode: "download" | "edit", ids: { id: string; text: string }[], deleted: string[] = []) {
  const observedMessages = ids.map((item) => observed(item.id, item.text));
  const common = {
    prefix: notes,
    markdown: null as string | null,
    chat: null,
    binding,
    chatKey: "c7a18d2f",
    displayName: "Class 3A",
    observed: observedMessages,
    order: "verified" as const,
    contiguous: true,
    requestedScope: "recent",
  };
  return mode === "download" ? downloadPass(common) : editPass({ ...common, deletedIds: deleted });
}

describe("edit reconciliation", () => {
  it("preserves wording on download and applies it on a later edit", () => {
    const saved = run("download", [
      { id: "m1", text: "original" },
      { id: "m2", text: "stay" },
    ]);
    expect(saved.chat).not.toBeNull();
    if (!saved.chat || !saved.markdown) return;
    const ignored = downloadPass({
      prefix: notes,
      markdown: saved.markdown,
      chat: saved.chat,
      binding,
      chatKey: "c7a18d2f",
      displayName: "Class 3A",
      observed: [observed("m1", "changed", "changed"), observed("m2", "stay", "stay")],
      order: "verified",
      contiguous: true,
      requestedScope: "recent",
    });
    expect(ignored.chat?.messages[0]?.text).toBe("original");
    expect(ignored.chat?.messages[0]?.sourceBaseline).toBe("changed");
    const edited = editPass({
      prefix: notes,
      markdown: ignored.markdown,
      chat: ignored.chat,
      binding,
      chatKey: "c7a18d2f",
      displayName: "Class 3A",
      observed: [observed("m1", "changed", "changed"), observed("m2", "stay", "stay")],
      deletedIds: [],
      order: "verified",
      contiguous: true,
      requestedScope: "recent",
    });
    expect(edited.chat?.messages.map((message) => message.text)).toEqual(["changed", "stay"]);
    expect(edited.markdown?.startsWith(notes)).toBe(true);
    const badge = editPass({
      prefix: notes,
      markdown: edited.markdown,
      chat: edited.chat,
      binding,
      chatKey: "c7a18d2f",
      displayName: "Class 3A",
      observed: [observed("m1", "changed", "changed"), observed("m2", "stay", "stay")],
      deletedIds: [],
      order: "verified",
      contiguous: true,
      requestedScope: "recent",
    });
    expect(badge.phase).toBe("unchanged");
    expect(badge.markdown).toBe(edited.markdown);
  });

  it("removes a positively deleted message, keeps an absent one, and reports a local conflict", () => {
    const saved = run("edit", [
      { id: "m1", text: "one" },
      { id: "m2", text: "two" },
    ]);
    expect(saved.chat).not.toBeNull();
    if (!saved.chat || !saved.markdown) return;
    const removed = editPass({
      prefix: notes,
      markdown: saved.markdown,
      chat: saved.chat,
      binding,
      chatKey: "c7a18d2f",
      displayName: "Class 3A",
      observed: [observed("m1", "one")],
      deletedIds: ["m1"],
      order: "verified",
      contiguous: true,
      requestedScope: "recent",
    });
    expect(removed.chat?.messages.map((message) => message.id)).toEqual(["m2"]);
    expect(removed.chat?.tombstones).toEqual([]);
    expect(removed.markdown).not.toContain("\none\n");

    const absent = editPass({
      prefix: notes,
      markdown: saved.markdown,
      chat: saved.chat,
      binding,
      chatKey: "c7a18d2f",
      displayName: "Class 3A",
      observed: [observed("m1", "one")],
      deletedIds: [],
      order: "verified",
      contiguous: true,
      requestedScope: "recent",
    });
    expect(absent.chat?.messages.map((message) => message.id)).toEqual(["m1", "m2"]);

    const local = saved.markdown.replace("one", "local note");
    const conflict = editPass({
      prefix: notes,
      markdown: local,
      chat: saved.chat,
      binding,
      chatKey: "c7a18d2f",
      displayName: "Class 3A",
      observed: [observed("m1", "source change", "source change"), observed("m2", "two", "two")],
      deletedIds: [],
      order: "verified",
      contiguous: true,
      requestedScope: "recent",
    });
    expect(conflict.conflicts).toEqual(["m1"]);
    expect(conflict.phase).toBe("paused");
    expect(conflict.reason).toBe("local-edit");
    expect(conflict.chat?.messages[0]?.text).toBe("one");
    expect(conflict.markdown).toBe(local);
  });
});
