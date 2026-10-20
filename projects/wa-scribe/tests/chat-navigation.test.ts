import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenChat } from "../src/whatsapp";

const adapter = vi.hoisted(() => ({
  accountId: vi.fn<() => string | null>(),
  inspect: vi.fn<() => Promise<{ ok: true; chat: OpenChat; rendered: number } | { ok: false; reason: string }>>(),
}));

vi.mock("../src/whatsapp", () => ({
  accountId: adapter.accountId,
  inspectWhatsAppResolved: adapter.inspect,
}));

import { openWhatsAppChat } from "../src/chat-navigation";

const expected: OpenChat = { accountId: "15551234567@c.us", chatId: "15550001111@c.us", name: "Family chat" };

function inspection(chat: OpenChat) {
  return { ok: true as const, chat, rendered: 2 };
}

function sidebarFixture(titles: string[][]): { clicks: number; selectorCalls: string[] } {
  let clicks = 0;
  const selectorCalls: string[] = [];
  const labels = titles.map((title) => {
    const row = {
      isConnected: true,
      getClientRects: () => [1],
      closest: () => null,
      contains: () => true,
      click: () => { clicks += 1; },
    };
    return title.map((value) => ({
      isConnected: true,
      getClientRects: () => [1],
      getAttribute: (name: string) => name === "title" ? value : null,
      closest: (selector: string) => selector === "[role='row'], [role='listitem']" ? row : null,
    }));
  }).flat();
  const sidebar = {
    querySelectorAll: (selector: string) => {
      selectorCalls.push(selector);
      return selector === "[title]" ? labels : [];
    },
    contains: () => true,
  };
  vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
  vi.stubGlobal("document", {
    querySelector: (selector: string) => selector === "#pane-side" ? sidebar : null,
    querySelectorAll: (selector: string) => selector === "#pane-side" ? [sidebar] : [],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return { get clicks() { return clicks; }, selectorCalls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("openWhatsAppChat", () => {
  it("returns immediately when account and conversation identity are already verified", async () => {
    adapter.accountId.mockReturnValue(expected.accountId);
    adapter.inspect.mockResolvedValue(inspection(expected));
    const sidebar = sidebarFixture([]);

    await openWhatsAppChat(expected);

    expect(adapter.inspect).toHaveBeenCalledOnce();
    expect(sidebar.selectorCalls).toEqual([]);
  });

  it("refuses to navigate when the active account does not match", async () => {
    adapter.accountId.mockReturnValue("15559999999@c.us");
    adapter.inspect.mockResolvedValue(inspection(expected));
    const sidebar = sidebarFixture([[expected.name]]);

    await expect(openWhatsAppChat(expected)).rejects.toThrow("account changed");

    expect(adapter.inspect).not.toHaveBeenCalled();
    expect(sidebar.clicks).toBe(0);
  });

  it("refuses duplicate exact title hints instead of selecting either chat", async () => {
    adapter.accountId.mockReturnValue(expected.accountId);
    adapter.inspect.mockResolvedValue({ ok: false, reason: "No verified conversation." });
    const sidebar = sidebarFixture([[expected.name], [expected.name]]);

    await expect(openWhatsAppChat(expected)).rejects.toThrow("More than one visible WhatsApp chat");

    expect(sidebar.clicks).toBe(0);
    expect(sidebar.selectorCalls).toContain("[title]");
    expect(sidebar.selectorCalls).not.toContain("#main");
  });

  it("honors an already aborted Stop signal before inspecting or changing the page", async () => {
    adapter.accountId.mockReturnValue(expected.accountId);
    const controller = new AbortController();
    controller.abort();

    await expect(openWhatsAppChat(expected, controller.signal)).rejects.toThrow("stopped");

    expect(adapter.inspect).not.toHaveBeenCalled();
  });
});
