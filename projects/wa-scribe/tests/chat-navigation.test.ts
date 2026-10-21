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

function sidebarFixture(titles: string[][], onDown: () => void = () => undefined): { clicks: number; events: string[]; selectorCalls: string[] } {
  let clicks = 0;
  const events: string[] = [];
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
      getBoundingClientRect: () => ({ left: 10, top: 10, width: 50, height: 20 }),
      dispatchEvent: (event: Event) => { events.push(event.type); if (event.type === "mousedown") onDown(); return true; },
      click: () => { clicks += 1; events.push("click"); },
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
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("MouseEvent", Event);
  vi.stubGlobal("PointerEvent", Event);
  vi.stubGlobal("document", {
    querySelector: (selector: string) => selector === "#pane-side" ? sidebar : null,
    querySelectorAll: (selector: string) => selector === "#pane-side" ? [sidebar] : [],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return { get clicks() { return clicks; }, events, selectorCalls };
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

  it("opens the label's down-handler and verifies the requested identity before returning", async () => {
    const previous = { ...expected, chatId: "15550002222@c.us", name: "Previous chat" };
    let opened = previous;
    adapter.accountId.mockReturnValue(expected.accountId);
    adapter.inspect.mockImplementation(async () => inspection(opened));
    const sidebar = sidebarFixture([[expected.name, expected.name]], () => { opened = expected; });

    await openWhatsAppChat(expected);

    expect(sidebar.events).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    expect(sidebar.clicks).toBe(1);
    expect(adapter.inspect).toHaveBeenCalledTimes(2);
    expect(opened.chatId).toBe(expected.chatId);
  });

  it("rejects a same-title destination with a different canonical conversation ID", async () => {
    const previous = { ...expected, chatId: "15550002222@c.us" };
    let opened = previous;
    adapter.accountId.mockReturnValue(expected.accountId);
    adapter.inspect.mockImplementation(async () => inspection(opened));
    sidebarFixture([[expected.name]], () => { opened = { ...expected, chatId: "15550003333@c.us" }; });

    await expect(openWhatsAppChat(expected)).rejects.toThrow("different conversation");
  });

  it("honors Stop between mouse-down and the remaining activation events", async () => {
    adapter.accountId.mockReturnValue(expected.accountId);
    adapter.inspect.mockResolvedValue(inspection({ ...expected, chatId: "15550002222@c.us" }));
    const controller = new AbortController();
    const sidebar = sidebarFixture([[expected.name]], () => controller.abort());

    await expect(openWhatsAppChat(expected, controller.signal)).rejects.toThrow("stopped");

    expect(sidebar.events).toEqual(["pointerdown", "mousedown"]);
    expect(sidebar.clicks).toBe(0);
    expect(adapter.inspect).toHaveBeenCalledOnce();
  });
});
