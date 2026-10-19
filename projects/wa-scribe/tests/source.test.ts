import { describe, expect, it } from "vitest";
import { diagnose, readSource } from "../src/source";

const page = `
<main data-account-id="acct-1" data-chat-id="chat-1" data-order="verified">
  <article data-message-id="m40" data-sender-key="dana" data-sender-name="Dana" data-time-display="09:41" data-time-precision="minute" data-sequence="verified">Same minute</article>
  <article data-placeholder="unloaded"></article>
  <article data-message-id="m41" data-sender-key="dana" data-sender-name="Dana" data-time-display="09:41" data-time-precision="minute" data-sequence="verified">Same minute</article>
  <article data-message-id="m40" data-sender-key="dana" data-sender-name="Dana" data-time-display="9:41 AM" data-time-precision="display-only" data-sequence="verified">Same minute</article>
</main>`;

describe("source identity", () => {
  it("counts a virtualized fixture without returning message text", () => {
    const report = diagnose(page);
    expect(report).toEqual({ mode: "diagnostic", accountPresent: true, chatPresent: true, rowCount: 4, placeholderCount: 1, rowsMissingId: 0 });
    expect(JSON.stringify(report)).not.toContain("Same minute");
  });

  it("keeps distinct ids and does not invent one for an unidentified row", () => {
    const read = readSource(page);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.snapshot.messages.map((message) => message.id)).toEqual(["m40", "m41"]);
    expect(read.snapshot.messages[0]?.timeDisplay).toBe("09:41");
    const broken = page.replace('data-message-id="m41"', "");
    const rejected = readSource(broken);
    expect(rejected).toMatchObject({ ok: false, reason: "unresolved-row" });
    expect(JSON.stringify(rejected)).not.toContain("msg-");
  });

  it("rejects a batch whose account or chat does not match the selected conversation", () => {
    expect(readSource(page, { accountId: "acct-1", chatId: "chat-9" })).toMatchObject({ ok: false, reason: "chat-mismatch" });
    expect(readSource("<main></main>")).toMatchObject({ ok: false, reason: "missing-account" });
    expect(readSource('<main data-account-id="acct-1" data-chat-id="chat-1"></main>')).toMatchObject({ ok: false, reason: "unknown-order" });
  });
});