import { describe, expect, it } from "vitest";
import { downloadPass, type ObservedMessage } from "../src/download";
import type { Binding, ChatExport, Timestamp } from "../src/model";

const binding: Binding = { accountId: "acct-1", chatId: "chat-1", destinationId: "dest-1", generation: "g1" };
const minute: Timestamp = { display: "09:41", precision: "minute", timeZone: null, instant: null };
const notes = "## Notes\n\nKeep these bytes.\n";

function observed(id: string, text = id, baseline = text): ObservedMessage {
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

function pass(chat: ChatExport | null, markdown: string | null, ids: string[], contiguous: boolean, order: "verified" | "unknown" = "verified") {
  return downloadPass({
    prefix: notes,
    markdown,
    chat,
    binding,
    chatKey: "c7a18d2f",
    displayName: "Class 3A",
    observed: ids.map((id) => observed(id, `text ${id}`, `base ${id}`)),
    order,
    contiguous,
    requestedScope: "recent",
  });
}

describe("download reconciliation", () => {
  it("inserts older and middle history without a timestamp cutoff or a duplicate", () => {
    const first = pass(null, null, ["m40", "m42"], false);
    expect(first.phase).toBe("updated");
    expect(first.chat?.messages.map((message) => message.id)).toEqual(["m40", "m42"]);
    expect(first.chat?.coverage.gaps).toEqual([{ afterId: "m40", beforeId: "m42", reason: "unverified-between" }]);
    expect(first.markdown?.startsWith(notes)).toBe(true);

    const second = pass(first.chat, first.markdown, ["m42", "m43", "m44"], true);
    expect(second.inserted).toEqual(["m43", "m44"]);
    expect(second.chat?.messages.map((message) => message.id)).toEqual(["m40", "m42", "m43", "m44"]);
    expect(second.chat?.coverage.gaps).toContainEqual({ afterId: "m40", beforeId: "m42", reason: "unverified-between" });

    const repeat = pass(second.chat, second.markdown, ["m42", "m43", "m44"], true);
    expect(repeat.phase).toBe("unchanged");
    expect(repeat.markdown).toBe(second.markdown);

    const fourth = pass(second.chat, second.markdown, ["m10", "m11", "m40", "m41", "m42"], true);
    expect(fourth.chat?.messages.map((message) => message.id)).toEqual(["m10", "m11", "m40", "m41", "m42", "m43", "m44"]);
    expect(fourth.chat?.coverage.gaps.some((gap) => gap.afterId === "m40" && gap.beforeId === "m42")).toBe(false);
    expect(fourth.markdown?.startsWith(notes)).toBe(true);
  });

  it("keeps same-timestamp ids distinct and pauses when order or a disjoint window is unknown", () => {
    const distinct = downloadPass({
      prefix: notes,
      markdown: null,
      chat: null,
      binding,
      chatKey: "c7a18d2f",
      displayName: "Class 3A",
      observed: [observed("m40", "Same", "a"), observed("m41", "Same", "b")],
      order: "verified",
      contiguous: true,
      requestedScope: "recent",
    });
    expect(distinct.chat?.messages.map((message) => message.id)).toEqual(["m40", "m41"]);

    const saved = distinct.chat;
    const unknown = pass(saved, distinct.markdown, ["m40", "m99"], true, "unknown");
    expect(unknown.phase).toBe("paused");
    expect(unknown.reason).toBe("unknown-order");
    expect(unknown.markdown).toBe(distinct.markdown);

    const disjoint = pass(saved, distinct.markdown, ["m10", "m11"], true);
    expect(disjoint.phase).toBe("paused");
    expect(disjoint.reason).toBe("disjoint");
    expect(disjoint.chat?.messages.map((message) => message.id)).toEqual(["m40", "m41"]);
  });

  it("preserves wording and notes, and keeps a locally deleted block tombstoned", () => {
    const first = pass(null, null, ["m40", "m42"], true);
    expect(first.chat).not.toBeNull();
    if (!first.chat || !first.markdown) return;
    const edited = pass(first.chat, first.markdown, ["m40", "m42"], true);
    const changed = downloadPass({
      prefix: notes,
      markdown: edited.markdown,
      chat: edited.chat,
      binding,
      chatKey: "c7a18d2f",
      displayName: "Class 3A",
      observed: [observed("m40", "replacement", "edited"), observed("m42", "text m42", "base m42")],
      order: "verified",
      contiguous: true,
      requestedScope: "recent",
    });
    expect(changed.chat?.messages[0]?.text).toBe("text m40");
    expect(changed.chat?.messages[0]?.sourceBaseline).toBe("edited");
    expect(changed.markdown?.startsWith(notes)).toBe(true);

    if (!first.markdown) return;
    const parts = first.markdown.split("### message");
    const without = `${parts[0] ?? ""}### message${parts[1] ?? ""}`;
    const removed = downloadPass({
      prefix: notes,
      markdown: without,
      chat: first.chat,
      binding,
      chatKey: "c7a18d2f",
      displayName: "Renamed",
      observed: [observed("m40", "text m40", "base m40"), observed("m42", "resurrected", "new")],
      order: "verified",
      contiguous: true,
      requestedScope: "recent",
    });
    expect(removed.chat?.messages.map((message) => message.id)).toEqual(["m40"]);
    expect(removed.chat?.tombstones).toEqual([{ messageId: "m42", reason: "local-deletion" }]);
    expect(removed.chat?.displayName).toBe("Renamed");
    expect(removed.chat?.chatKey).toBe("c7a18d2f");
    expect(removed.markdown).not.toContain("resurrected");
  });

  it("pauses on a partial local edit or an export from another binding", () => {
    const first = pass(null, null, ["m40", "m42"], true);
    expect(first.chat).not.toBeNull();
    if (!first.chat || !first.markdown) return;

    const partialEdit = first.markdown.replace("text m40", "my partial note");
    const edited = pass(first.chat, partialEdit, ["m40", "m42"], true);
    expect(edited.phase).toBe("paused");
    expect(edited.reason).toBe("local-edit");
    expect(edited.markdown).toBe(partialEdit);
    expect(edited.chat).toEqual(first.chat);

    const foreign = { ...first.chat, accountId: "acct-other" };
    const mismatched = pass(foreign, first.markdown, ["m40", "m42"], true);
    expect(mismatched.phase).toBe("paused");
    expect(mismatched.reason).toBe("binding-mismatch");
    expect(mismatched.markdown).toBe(first.markdown);
  });
});
