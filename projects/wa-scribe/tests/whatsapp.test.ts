import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectWhatsApp } from "../src/whatsapp";

type Row = { getAttribute: (name: string) => string | null; closest: (selector: string) => unknown | null };

function row(id: string, quoted = false): Row {
  return {
    getAttribute: (name) => name === "data-id" ? id : null,
    closest: (selector) => quoted && selector === "[data-testid='quoted-message']" ? {} : null,
  };
}

function fixture(ids: string[], options: { bubbleCount?: number; header?: string } = {}): void {
  const rows = ids.map((id) => row(id));
  const header = options.header ? { getAttribute: (name: string) => name === "title" ? options.header ?? null : null } : null;
  const main = {
    querySelectorAll: (selector: string) => selector === "[data-id]" ? rows :
      selector === ".message-in, .message-out" ? Array.from({ length: options.bubbleCount ?? 0 }, () => ({})) : [],
    querySelector: (selector: string) => selector.startsWith("header") ? header : null,
  };
  const documentStub = {
    querySelector: (selector: string) => selector === "#main" ? main : null,
    querySelectorAll: (selector: string) => selector === "#main" ? [main] : [],
  };
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === "last-wid" ? "15551234567@c.us" : null });
}

function diagnostic(result: ReturnType<typeof inspectWhatsApp>): { counts: Record<string, number> } {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected identity inspection to fail.");
  const marker = "Identity diagnostic: ";
  const offset = result.reason.indexOf(marker);
  expect(offset).toBeGreaterThanOrEqual(0);
  const json = result.reason.slice(offset + marker.length);
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Identity diagnostic has an unexpected shape.");
  }
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "number") throw new Error("Identity diagnostic count is not numeric.");
    counts[key] = value;
  }
  return { counts };
}

afterEach(() => vi.unstubAllGlobals());

describe("WhatsApp conversation identity", () => {
  it.each([
    ["direct", "false_15550001111@c.us_ABCD"],
    ["group", "false_120363000000000000@g.us_ABCD"],
    ["LID", "false_987654321@lid_ABCD"],
  ])("accepts a valid %s message identity", (_label, id) => {
    fixture([id], { header: "Private header name" });
    const result = inspectWhatsApp();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chat.chatId).toBe(id.slice("false_".length, id.lastIndexOf("_")));
    expect(result.chat.accountId).toBe("15551234567@c.us");
    expect(result.chat.name).toBe("Private header name");
    expect(result.rendered).toBe(1);
  });

  it("ignores a foreign ID inside a quoted message", () => {
    const quoted = row("false_15559999999@c.us_quote", true);
    const visible = row("false_15550001111@c.us_message");
    const main = {
      querySelectorAll: (selector: string) => selector === "[data-id]" ? [visible, quoted] : [],
      querySelector: () => null,
    };
    vi.stubGlobal("document", { querySelector: (selector: string) => selector === "#main" ? main : null, querySelectorAll: (selector: string) => selector === "#main" ? [main] : [] });
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === "last-wid" ? "15551234567@c.us" : null });
    const result = inspectWhatsApp();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.chat.chatId).toBe("15550001111@c.us");
  });

  it("reports a visible bubble that has no IDs", () => {
    fixture([], { bubbleCount: 1 });
    const counts = diagnostic(inspectWhatsApp()).counts;
    expect(counts.dataIds).toBe(0);
    expect(counts.recognizedRows).toBe(0);
    expect(counts.messageBubbles).toBe(1);
  });

  it("classifies malformed and unsupported chat IDs", () => {
    fixture(["message-without-jid"]);
    expect(diagnostic(inspectWhatsApp()).counts.invalidShape).toBe(1);
    fixture(["false_15550001111@evil.example_message"]);
    expect(diagnostic(inspectWhatsApp()).counts.unsupportedChatIds).toBe(1);
  });

  it("rejects multiple valid conversation IDs and reports unique recognized rows", () => {
    fixture([
      "false_15550001111@c.us_one",
      "true_15550001111@c.us_two",
      "false_15550001111@c.us_one",
      "false_120363000000000000@g.us_three",
    ]);
    const counts = diagnostic(inspectWhatsApp()).counts;
    expect(counts.dataIds).toBe(4);
    expect(counts.recognizedRows).toBe(3);
    expect(counts.conversationIds).toBe(2);
  });

  it("keeps IDs, account identity, and private header text out of diagnostics", () => {
    const ids = ["bad-visible-id-one", "bad-visible-id-two"];
    fixture(ids, { bubbleCount: 1, header: "Secret contact header" });
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === "last-wid" ? "15551234567@c.us" : null });
    const result = inspectWhatsApp();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const secret of [...ids, "15551234567@c.us", "Secret contact header"]) expect(result.reason).not.toContain(secret);
  });
});
