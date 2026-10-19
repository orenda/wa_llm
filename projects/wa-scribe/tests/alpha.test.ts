import { describe, expect, it } from "vitest";
import { runTextDownload } from "../src/alpha";
import type { Binding } from "../src/model";

const binding: Binding = { accountId: "acct-1", chatId: "chat-1", destinationId: "root-1", generation: "g1" };
const html = `
<main data-account-id="acct-1" data-chat-id="chat-1" data-order="verified">
  <article data-message-id="m40" data-sender-name="Dana" data-time-display="09:41" data-time-precision="minute" data-sequence="verified">Hello</article>
  <article data-message-id="m41" data-sender-name="Dana" data-time-display="09:42" data-time-precision="minute" data-sequence="verified">Again</article>
</main>`;

describe("one-chat text download alpha", () => {
  it("writes the selected fixture chat once and skips an unselected chat", () => {
    const first = runTextDownload({
      html,
      expected: { accountId: "acct-1", chatId: "chat-1" },
      prefix: "",
      binding,
      chatKey: "c7a18d2f",
      displayName: "Fixture",
      desk: { markdown: null, metadata: null, mediaIds: [] },
      journal: null,
      chat: null,
    });
    expect(first.phase).toBe("updated");
    expect(first.ids).toEqual(["m40", "m41"]);
    expect(first.desk.markdown).toContain("Hello");
    expect(first.desk.metadata).toContain("m40");
    expect(first.journal).toBeNull();

    const repeat = runTextDownload({
      html,
      expected: { accountId: "acct-1", chatId: "chat-1" },
      prefix: "",
      binding,
      chatKey: "c7a18d2f",
      displayName: "Fixture",
      desk: first.desk,
      journal: null,
      chat: null,
    });
    expect(repeat.desk.markdown).toBe(first.desk.markdown);

    const other = runTextDownload({
      html,
      expected: { accountId: "acct-1", chatId: "chat-9" },
      prefix: "",
      binding,
      chatKey: "c7a18d2f",
      displayName: "Fixture",
      desk: { markdown: null, metadata: null, mediaIds: [] },
      journal: null,
      chat: null,
    });
    expect(other.phase).toBe("paused");
    expect(other.desk.markdown).toBeNull();
  });
});