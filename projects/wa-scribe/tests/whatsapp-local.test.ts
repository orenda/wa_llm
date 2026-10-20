import { afterEach, describe, expect, it, vi } from "vitest";
import { collectWhatsApp, inspectWhatsAppResolved } from "../src/whatsapp";
import { resolveLocalMessageKeys, type LocalMessageKey, type LocalIdentityResult } from "../src/local-identity";
import type { AttachmentSlot } from "../src/model";

vi.mock("../src/local-identity", () => ({ resolveLocalMessageKeys: vi.fn() }));

const ACCOUNT = "15551234567@c.us";
const CHAT = "120363000000000000@g.us";
const OTHER_CHAT = "15550001111@c.us";
const OPAQUE = "0123456789abcdef0123";

function envelope(value: string, owner: object, quoted = false) {
  return {
    getAttribute: (name: string) => name === "data-pre-plain-text" ? value : null,
    closest: (selector: string) => selector === "[data-testid='quoted-message']" && quoted ? {} : null,
    querySelector: (selector: string) => selector === "[data-id]" ? owner : null,
    matches: (selector: string) => selector === "[data-pre-plain-text]",
  };
}

function keyedRow(id: string, options: { envelope?: string; nestedEnvelopes?: string[]; quote?: boolean; text?: string; scrollParent?: object; attachment?: boolean } = {}) {
  const quote = options.quote ? {
    nodeType: 1,
    childNodes: [{ nodeType: 3, textContent: "Quoted foreign message" }],
    closest: () => null,
  } : null;
  const text = options.text ? {
    nodeType: 1,
    childNodes: [{ nodeType: 3, textContent: options.text }],
    nextSibling: null,
    closest: () => null,
  } : null;
  const media = { closest: () => null, contains: () => false };
  const row = {
    parentElement: options.scrollParent,
    getAttribute: (name: string) => name === "data-id" ? id : name === "data-pre-plain-text" ? options.envelope ?? null : null,
    closest: (selector: string) => selector === "[data-id]" ? row :
      selector === "[data-testid='quoted-message']" && options.quote ? {} : null,
    querySelector: (selector: string) => selector === "[data-testid='quoted-message']" ? quote : null,
    querySelectorAll: (selector: string) => selector === ".selectable-text" && text ? [text] :
      selector === "[data-pre-plain-text]" ? (options.nestedEnvelopes ?? []).map((value, index) => envelope(value, row, index === 0)) :
      selector === "img:not(.emoji), video, audio, [data-testid='document-thumb'], [data-icon*='document']" && options.attachment ? [media] : [],
    matches: (selector: string) => selector === "[data-pre-plain-text]" && Boolean(options.envelope),
  };
  return row;
}

type Main = ReturnType<typeof makeMain>["main"];

type Context = {
  main: Main;
  setMain: (main: Main) => void;
  setRows: (rows: ReturnType<typeof keyedRow>[]) => void;
  setAccount: (account: string) => void;
  select: (node: object) => void;
  deselect: () => void;
};

class FakeMutationObserver implements MutationObserver {
  private readonly callback: MutationCallback;
  constructor(callback: MutationCallback) {
    this.callback = callback;
    lastObserver = this;
  }
  observe(_target: Node, _options?: MutationObserverInit): void {}
  disconnect(): void {}
  takeRecords(): MutationRecord[] { return []; }
  notify(): void { this.callback([], this); }
}

let lastObserver: FakeMutationObserver | null = null;

function makeMain(rows: ReturnType<typeof keyedRow>[], onDataRowsRead: () => void = () => undefined) {
  let currentRows = rows;
  const main = {
    querySelectorAll: (selector: string) => {
      if (selector === "[data-id]") onDataRowsRead();
      return selector === "[data-id]" ? currentRows :
      selector === "[data-pre-plain-text]" ? currentRows.flatMap<object>((row) => row.matches("[data-pre-plain-text]") ? [row] : row.querySelectorAll("[data-pre-plain-text]")) :
      selector === ".message-in, .message-out" ? [] :
      selector === ".message-in, .message-out, [data-pre-plain-text]" ? currentRows.flatMap<object>((row) => row.matches("[data-pre-plain-text]") ? [row] : row.querySelectorAll("[data-pre-plain-text]")) : [];
    },
    querySelector: () => null,
    contains: () => true,
  };
  return { main, setRows: (next: ReturnType<typeof keyedRow>[]) => { currentRows = next; } };
}

function installPage(rows: ReturnType<typeof keyedRow>[], account = ACCOUNT, onDataRowsRead: () => void = () => undefined): Context {
  let { main, setRows } = makeMain(rows, onDataRowsRead);
  let currentAccount = account;
  let selection: object[] = [];
  const sidebar = {};
  vi.stubGlobal("document", {
    querySelector: (selector: string) => selector === "#main" ? main : selector === "#pane-side" ? sidebar : null,
    querySelectorAll: (selector: string) => selector === "#main" ? [main] :
      selector === "#pane-side [aria-selected='true'], #pane-side [data-selected='true']" ? selection : [],
  });
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === "last-wid" ? currentAccount : null });
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
  return {
    main,
    setMain: (next) => { main = next; },
    setRows: (next) => setRows(next),
    setAccount: (next) => { currentAccount = next; },
    select: (node) => { selection = [node]; },
    deselect: () => { selection = []; },
  };
}

function makeScroller(afterScroll?: () => void) {
  let top = 200, writes = 0;
  const scroller = {
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = value; writes += 1; afterScroll?.(); },
    clientHeight: 100,
    scrollHeight: 500,
  };
  return { scroller, writes: () => writes };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve: (value: T) => resolve(value) };
}

function key(raw: string, chatId: string): LocalMessageKey {
  return { id: `false_${chatId}_${raw}`, chatId, outgoing: false, senderId: null };
}

afterEach(() => {
  lastObserver = null;
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("WhatsApp local message identity", () => {
  it("resolves opaque message IDs to the full canonical chat identity", async () => {
    installPage([keyedRow(OPAQUE)]);
    vi.mocked(resolveLocalMessageKeys).mockResolvedValue({ ok: true, keys: new Map([[OPAQUE, key(OPAQUE, CHAT)]]) });

    const result = await inspectWhatsAppResolved();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.chat).toEqual({ accountId: ACCOUNT, chatId: CHAT, name: CHAT });
    expect(resolveLocalMessageKeys).toHaveBeenCalledWith([OPAQUE], undefined);
  });

  it("accepts canonical IDs without opening the local identity database", async () => {
    installPage([keyedRow(`false_${CHAT}_message`)]);

    const result = await inspectWhatsAppResolved();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.chat.chatId).toBe(CHAT);
    expect(resolveLocalMessageKeys).not.toHaveBeenCalled();
  });

  it("rejects canonical and resolved IDs that point to different chats", async () => {
    installPage([keyedRow(`false_${CHAT}_message`), keyedRow(OPAQUE)]);
    vi.mocked(resolveLocalMessageKeys).mockResolvedValue({ ok: true, keys: new Map([[OPAQUE, key(OPAQUE, OTHER_CHAT)]]) });

    const result = await inspectWhatsAppResolved();

    expect(result.ok).toBe(false);
  });

  it.each(["account", "main", "raw IDs", "sidebar selection"])("rejects a %s change while local identity lookup is pending", async (change) => {
    const context = installPage([keyedRow(OPAQUE)]);
    const pending = deferred<LocalIdentityResult>();
    vi.mocked(resolveLocalMessageKeys).mockReturnValue(pending.promise);

    const inspection = inspectWhatsAppResolved();
    if (change === "account") context.setAccount("15559999999@c.us");
    if (change === "main") context.setMain(makeMain([keyedRow(OPAQUE)]).main);
    if (change === "raw IDs") context.setRows([keyedRow("fedcba9876543210fedc")]);
    if (change === "sidebar selection") context.select({});
    pending.resolve({ ok: true, keys: new Map([[OPAQUE, key(OPAQUE, CHAT)]]) });

    expect((await inspection).ok).toBe(false);
  });

  it("rejects a sidebar selection that changes away and back during lookup", async () => {
    const context = installPage([keyedRow(OPAQUE)]);
    const selected = {};
    context.select(selected);
    const pending = deferred<LocalIdentityResult>();
    vi.mocked(resolveLocalMessageKeys).mockReturnValue(pending.promise);

    const inspection = inspectWhatsAppResolved();
    context.select({});
    context.select(selected);
    lastObserver?.notify();
    pending.resolve({ ok: true, keys: new Map([[OPAQUE, key(OPAQUE, CHAT)]]) });

    expect((await inspection).ok).toBe(false);
  });
});

describe("WhatsApp collection with local identities", () => {
  it("collects envelope rows without message bubbles and excludes quoted foreign IDs", async () => {
    const canonicalId = `false_${CHAT}_canonical-message`;
    const row = keyedRow(canonicalId, { envelope: "[10:15, 2/3/2026] Alice:", text: "visible body" });
    const quoted = keyedRow(`false_${OTHER_CHAT}_quoted-message`, { quote: true, envelope: "[09:00, 2/3/2026] Bob:", text: "quoted body" });
    const page = installPage([row, quoted]);
    vi.stubGlobal("Node", class { static readonly TEXT_NODE = 3; });
    vi.stubGlobal("HTMLBRElement", class {});
    vi.stubGlobal("HTMLImageElement", class {});
    vi.stubGlobal("HTMLDivElement", class {});

    const result = await collectWhatsApp({ expected: { accountId: ACCOUNT, chatId: CHAT, name: "Group" }, limit: 10, maxMs: 1_000, scope: "visible" });

    expect(result.messages.map((message) => message.id)).toEqual([canonicalId]);
    expect(result.messages[0]?.text).toBe("visible body");
    expect(JSON.stringify(result)).not.toContain("quoted body");
    expect(page.main.querySelectorAll(".message-in, .message-out")).toHaveLength(0);
  });

  it("chooses the real envelope after a quoted envelope and preserves its sender and time", async () => {
    const canonicalId = `false_${CHAT}_nested-envelope`;
    const row = keyedRow(canonicalId, {
      nestedEnvelopes: ["[08:00, 1/2/2026] Quoted Person:", "[10:15, 2/3/2026] Real Sender:"],
      text: "message body",
    });
    installPage([row]);
    vi.stubGlobal("Node", class { static readonly TEXT_NODE = 3; });
    vi.stubGlobal("HTMLBRElement", class {});
    vi.stubGlobal("HTMLImageElement", class {});
    vi.stubGlobal("HTMLDivElement", class {});

    const result = await collectWhatsApp({ expected: { accountId: ACCOUNT, chatId: CHAT, name: "Group" }, limit: 10, maxMs: 1_000, scope: "visible" });

    expect(result.messages[0]?.sender.name).toBe("Real Sender");
    expect(result.messages[0]?.timestamp.display).toBe("10:15, 2/3/2026");
  });

  it("retains identified body text without an envelope and leaves its timestamp unknown", async () => {
    const canonicalId = `false_${CHAT}_missing-envelope`;
    installPage([keyedRow(canonicalId, { text: "Body remains available." })]);
    vi.stubGlobal("Node", class { static readonly TEXT_NODE = 3; });
    vi.stubGlobal("HTMLBRElement", class {});
    vi.stubGlobal("HTMLImageElement", class {});
    vi.stubGlobal("HTMLDivElement", class {});

    const result = await collectWhatsApp({ expected: { accountId: ACCOUNT, chatId: CHAT, name: "Group" }, limit: 10, maxMs: 1_000, scope: "visible" });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.id).toBe(canonicalId);
    expect(result.messages[0]?.text).toBe("Body remains available.");
    expect(result.messages[0]?.timestamp).toEqual({ display: "", precision: "unknown", timeZone: null, instant: null });
    expect(result.stopReason).toBe("unsupported-message-envelope");
    expect(result.contiguous).toBe(false);
  });

  it("strips bidi marks from a valid message prefix before reading sender and display time", async () => {
    const canonicalId = `false_${CHAT}_bidi-envelope`;
    installPage([keyedRow(canonicalId, { envelope: "\u200e[10:15, 2/3/2026] \u200eReal Sender:\u200f", text: "Bidi prefix body." })]);
    vi.stubGlobal("Node", class { static readonly TEXT_NODE = 3; });
    vi.stubGlobal("HTMLBRElement", class {});
    vi.stubGlobal("HTMLImageElement", class {});
    vi.stubGlobal("HTMLDivElement", class {});

    const result = await collectWhatsApp({ expected: { accountId: ACCOUNT, chatId: CHAT, name: "Group" }, limit: 10, maxMs: 1_000, scope: "visible" });

    expect(result.messages[0]?.sender.name).toBe("Real Sender");
    expect(result.messages[0]?.timestamp).toEqual({ display: "10:15, 2/3/2026", precision: "display-only", timeZone: null, instant: null });
    expect(result.messages[0]?.text).toBe("Bidi prefix body.");
  });

  it("keeps the resolved canonical ID when collecting opaque message rows", async () => {
    const page = installPage([keyedRow(OPAQUE, { envelope: "[10:15, 2/3/2026] Alice:", text: "opaque body" })]);
    vi.mocked(resolveLocalMessageKeys).mockResolvedValue({ ok: true, keys: new Map([[OPAQUE, key(OPAQUE, CHAT)]]) });
    vi.stubGlobal("Node", class { static readonly TEXT_NODE = 3; });
    vi.stubGlobal("HTMLBRElement", class {});
    vi.stubGlobal("HTMLImageElement", class {});
    vi.stubGlobal("HTMLDivElement", class {});

    const result = await collectWhatsApp({ expected: { accountId: ACCOUNT, chatId: CHAT, name: "Group" }, limit: 10, maxMs: 1_000, scope: "visible" });

    expect(result.messages.map((message) => message.id)).toEqual([key(OPAQUE, CHAT).id]);
    expect(resolveLocalMessageKeys).toHaveBeenCalledWith([OPAQUE], undefined);
    expect(page.main.querySelectorAll("[data-id]")).toHaveLength(1);
  });

  it("does not restore a scroller after a wrong-chat collection fails", async () => {
    const scroll = makeScroller();
    const row = keyedRow(`false_${CHAT}_wrong-target`, { envelope: "[10:15, 2/3/2026] Alice:", text: "body", scrollParent: scroll.scroller });
    installPage([row]);
    vi.stubGlobal("getComputedStyle", () => ({ overflowY: "auto" }));

    await expect(collectWhatsApp({ expected: { accountId: ACCOUNT, chatId: OTHER_CHAT, name: "Other" }, limit: 10, maxMs: 1_000, scope: "visible" })).rejects.toThrow();

    expect(scroll.writes()).toBe(0);
  });

  it("does not restore a scroller after account changes during async identity lookup", async () => {
    const scroll = makeScroller();
    const context = installPage([keyedRow(OPAQUE, { envelope: "[10:15, 2/3/2026] Alice:", text: "body", scrollParent: scroll.scroller })]);
    const pending = deferred<LocalIdentityResult>();
    vi.mocked(resolveLocalMessageKeys).mockReturnValue(pending.promise);
    vi.stubGlobal("getComputedStyle", () => ({ overflowY: "auto" }));

    const collection = collectWhatsApp({ expected: { accountId: ACCOUNT, chatId: CHAT, name: "Group" }, limit: 10, maxMs: 1_000, scope: "visible" });
    context.setAccount("15559999999@c.us");
    pending.resolve({ ok: true, keys: new Map([[OPAQUE, key(OPAQUE, CHAT)]]) });

    await expect(collection).rejects.toThrow();
    expect(scroll.writes()).toBe(0);
  });

  it("does not restore a scroller when identity resolution fails", async () => {
    const scroll = makeScroller();
    installPage([keyedRow(OPAQUE, { envelope: "[10:15, 2/3/2026] Alice:", text: "body", scrollParent: scroll.scroller })]);
    vi.mocked(resolveLocalMessageKeys).mockResolvedValue({ ok: false, reason: "No complete local identity." });
    vi.stubGlobal("getComputedStyle", () => ({ overflowY: "auto" }));

    await expect(collectWhatsApp({ expected: { accountId: ACCOUNT, chatId: CHAT, name: "Group" }, limit: 10, maxMs: 1_000, scope: "visible" })).rejects.toThrow();

    expect(scroll.writes()).toBe(0);
  });

  it("does not move the user's scroll position after Stop interrupts collection", async () => {
    const scroll = makeScroller();
    installPage([keyedRow(`false_${CHAT}_stopped`, { envelope: "[10:15, 2/3/2026] Alice:", text: "body", scrollParent: scroll.scroller })]);
    vi.stubGlobal("getComputedStyle", () => ({ overflowY: "auto" }));
    vi.stubGlobal("Node", class { static readonly TEXT_NODE = 3; });
    vi.stubGlobal("HTMLBRElement", class {});
    vi.stubGlobal("HTMLImageElement", class {});
    vi.stubGlobal("HTMLDivElement", class {});
    const controller = new AbortController();

    await collectWhatsApp({ expected: { accountId: ACCOUNT, chatId: CHAT, name: "Group" }, limit: 10,
      maxMs: 1_000, scope: "visible", signal: controller.signal, onProgress: () => controller.abort() });

    expect(scroll.writes()).toBe(0);
  });

  it.each([
    { label: "same source baseline", text: "shared body", retained: true },
    { label: "changed source baseline", text: "edited body", retained: false },
  ])("keeps media from the first history window across an overlapping $label window at the time budget", async ({ text, retained }) => {
    let now = 0;
    let expireAtNextRowsRead = false;
    let swapped = false;
    let overlapRead = false;
    let captures = 0;
    const scroll = makeScroller(() => { now = 999; });
    const page = installPage([
      keyedRow(`false_${CHAT}_overlap-media`, { envelope: "[10:15, 2/3/2026] Alice:", text: "shared body", scrollParent: scroll.scroller, attachment: true }),
    ], ACCOUNT, () => {
      if (expireAtNextRowsRead) { now = 1_000; expireAtNextRowsRead = false; overlapRead = true; }
    });
    vi.stubGlobal("getComputedStyle", () => ({ overflowY: "auto" }));
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("Node", class { static readonly TEXT_NODE = 3; });
    vi.stubGlobal("HTMLBRElement", class {});
    vi.stubGlobal("HTMLImageElement", class {});
    vi.stubGlobal("HTMLDivElement", class {});

    const result = await collectWhatsApp({
      expected: { accountId: ACCOUNT, chatId: CHAT, name: "Group" }, limit: 10, maxMs: 1_000, scope: "loaded",
      onProgress: () => {
        if (swapped) return;
        swapped = true;
        page.setRows([
          keyedRow(`false_${CHAT}_overlap-media`, { envelope: "[10:15, 2/3/2026] Alice:", text, scrollParent: scroll.scroller, attachment: true }),
        ]);
        expireAtNextRowsRead = true;
      },
      captureMedia: async (): Promise<AttachmentSlot[]> => {
        captures += 1;
        return [{ slot: 1, attachment: {
          state: "saved", name: "report.pdf", relativePath: "media/report.pdf", mediaType: "application/pdf",
        } }];
      },
    });

    expect(result.stopReason).toBe("time-budget");
    expect(swapped).toBe(true);
    expect(overlapRead).toBe(true);
    expect(captures).toBe(1);
    expect(result.messages[0]?.text).toBe(text);
    const attachment = result.messages[0]?.attachments[0]?.attachment;
    if (retained) {
      expect(attachment).toEqual({ state: "saved", name: "report.pdf", relativePath: "media/report.pdf", mediaType: "application/pdf" });
    } else {
      expect(attachment?.state).toBe("unavailable");
      expect(attachment).not.toMatchObject({ relativePath: "media/report.pdf" });
    }
  });
});
