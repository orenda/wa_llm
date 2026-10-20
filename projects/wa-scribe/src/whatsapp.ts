import type { ObservedMessage } from "./download";
import type { AttachmentSlot } from "./model";
import { resolveLocalMessageKeys, type LocalMessageKey } from "./local-identity";

export type OpenChat = { accountId: string; chatId: string; name: string };
export type CollectedChat = {
  chat: OpenChat;
  messages: ObservedMessage[];
  order: "verified" | "unknown";
  contiguous: boolean;
  stopReason: string;
  deletedIds: string[];
};

type MessageKey = LocalMessageKey;
type Inspection = { ok: true; chat: OpenChat; rendered: number } | { ok: false; reason: string };
const MESSAGE_ID = /^(true|false)_([^_]+)_([^\s]+)$/;
const JID = /^\d+(?:-\d+)?(?::\d+)?@(?:c\.us|g\.us|lid|s\.whatsapp\.net)$/;
const ACCOUNT_JID = /^\d+(?::\d+)?@(?:c\.us|lid|s\.whatsapp\.net)$/;

function accountId(): string | null {
  // These two values identify the account. Session/credential storage is never inspected.
  const identities = new Set<string>();
  for (const key of ["last-wid", "last-wid-md"]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const value: unknown = ACCOUNT_JID.test(raw) ? raw : JSON.parse(raw);
      const id = typeof value === "string" ? value :
        typeof value === "object" && value !== null && "_serialized" in value && typeof value._serialized === "string" ? value._serialized : null;
      if (id && ACCOUNT_JID.test(id)) identities.add(id.replace(/:\d+@/, "@").replace(/@s\.whatsapp\.net$/, "@c.us"));
    } catch {
      // Missing/inaccessible identity is handled by inspectWhatsApp; no fallback identity is invented.
    }
  }
  return identities.size === 1 ? [...identities][0] ?? null : null;
}

function messageKey(row: Element, resolved?: ReadonlyMap<string, MessageKey>): MessageKey | null {
  const id = row.getAttribute("data-id") ?? "";
  const local = resolved?.get(id);
  if (local) return local;
  const match = MESSAGE_ID.exec(id);
  if (!match?.[2] || !JID.test(match[2]) || !match[3]) return null;
  const sender = /_(\d+(?::\d+)?@(?:c\.us|lid|s\.whatsapp\.net))$/.exec(match[3]);
  return { id, chatId: match[2], outgoing: match[1] === "true", senderId: sender?.[1] ?? null };
}

function messageRows(main: Element, resolved?: ReadonlyMap<string, MessageKey>): HTMLElement[] {
  const seen = new Set<string>();
  return Array.from(main.querySelectorAll<HTMLElement>("[data-id]")).filter((row) => {
    const key = messageKey(row, resolved);
    if (row.closest("[data-testid='quoted-message']") || !key || seen.has(key.id)) return false;
    seen.add(key.id);
    return true;
  });
}

function idStructure(row: Element) {
  const value = (row.getAttribute("data-id") ?? "").slice(0, 256);
  const separators: Record<string, string> = { "_": "underscore", "@": "at", ".": "dot", ":": "colon", "-": "dash", "/": "slash", "%": "percent",
    "{": "open-object", "}": "close-object", "[": "open-array", "]": "close-array", '"': "quote", ",": "comma", "\\": "backslash" };
  const shape = Array.from(value, (char) => separators[char] ?? (/\s/u.test(char) ? "space" : "value"))
    .filter((kind, index, kinds) => kind !== "value" || kinds[index - 1] !== "value").slice(0, 64);
  return { shape, directionPrefix: /^(true|false)_/.test(value), whitespace: /\s/u.test(value), percentEncoding: /%[0-9a-f]{2}/i.test(value),
    knownJidMarkers: ["c.us", "g.us", "lid", "s.whatsapp.net"].filter((domain) => value.includes(`@${domain}`)),
    hasText: row.querySelector(".selectable-text") !== null, hasEnvelope: row.querySelector("[data-pre-plain-text]") !== null };
}

function identityDiagnostic(main: Element, recognizedRows: number, conversationIds: number) {
  const candidates = Array.from(main.querySelectorAll("[data-id]"));
  const structures = new Map<string, ReturnType<typeof idStructure> & { count: number }>();
  for (const row of candidates.slice(0, 64)) {
    if (row.closest("[data-testid='quoted-message']")) continue;
    const structure = idStructure(row), signature = JSON.stringify(structure), previous = structures.get(signature);
    if (previous) previous.count += 1;
    else if (structures.size < 6) structures.set(signature, { ...structure, count: 1 });
  }
  let quotedRows = 0, invalidShape = 0, unsupportedChatIds = 0;
  for (const row of candidates) {
    if (row.closest("[data-testid='quoted-message']")) { quotedRows += 1; continue; }
    const match = MESSAGE_ID.exec(row.getAttribute("data-id") ?? "");
    if (!match?.[2]) invalidShape += 1;
    else if (!JID.test(match[2])) unsupportedChatIds += 1;
  }
  // Only counts, fixed enum tokens and booleans; no DOM values, text, names or IDs.
  return { dataIds: candidates.length, recognizedRows, quotedRows, invalidShape, unsupportedChatIds,
    conversationIds, messageBubbles: main.querySelectorAll(".message-in, .message-out").length,
    textEnvelopes: main.querySelectorAll("[data-pre-plain-text]").length, selectableTextNodes: main.querySelectorAll(".selectable-text").length,
    structures: [...structures.values()] };
}

function inspect(main: HTMLElement | null, resolved?: ReadonlyMap<string, MessageKey>): Inspection {
  if (!main || document.querySelectorAll("#main").length !== 1) return { ok: false, reason: "Open a WhatsApp conversation first." };
  const account = accountId();
  if (!account) return { ok: false, reason: "WhatsApp did not expose a verifiable account ID. Sign in and reload WhatsApp Web." };
  const rows = messageRows(main, resolved);
  const ids = new Set(rows.map((row) => messageKey(row, resolved)?.chatId).filter((id): id is string => id !== undefined));
  if (ids.size !== 1) {
    const reason = ids.size === 0 ? "No supported message-based conversation ID was found in the open chat." : "The open chat contains multiple message-based conversation IDs.";
    return { ok: false, reason: `${reason} Identity diagnostic: ${JSON.stringify(identityDiagnostic(main, rows.length, ids.size))}` };
  }
  const chatId = [...ids][0];
  if (!chatId) return { ok: false, reason: "No stable conversation ID is available." };
  const header = main.querySelector<HTMLElement>("header span[title], header [data-testid='conversation-info-header-chat-title']");
  return { ok: true, chat: { accountId: account, chatId, name: header?.getAttribute("title") || header?.textContent || chatId }, rendered: rows.length };
}

export function inspectWhatsApp(): Inspection {
  return inspect(document.querySelector<HTMLElement>("#main"));
}

function rowSignature(main: HTMLElement): string {
  return JSON.stringify(Array.from(main.querySelectorAll("[data-id]"), (row) => row.getAttribute("data-id")));
}

// Selection is a change detector only; durable identity always comes from full message keys.
function watchContext(main: HTMLElement, freezeRows = false) {
  const account = accountId(), sidebar = document.querySelector("#pane-side");
  const selected = () => Array.from(document.querySelectorAll("#pane-side [aria-selected='true'], #pane-side [data-selected='true']"));
  const selection = selected();
  const originalIds = freezeRows ? rowSignature(main) : null;
  let changed = false;
  const observer = new MutationObserver(() => { changed = true; });
  if (sidebar) observer.observe(sidebar, { subtree: true, attributes: true, attributeFilter: ["aria-selected", "data-selected"] });
  return {
    current: () => {
      if (observer.takeRecords().length) changed = true;
      const current = selected();
      return !changed && document.querySelector("#main") === main && document.querySelectorAll("#main").length === 1 &&
        document.querySelector("#pane-side") === sidebar && accountId() === account &&
        current.length === selection.length && current.every((node, index) => node === selection[index]) &&
        (originalIds === null || rowSignature(main) === originalIds);
    },
    close: () => observer.disconnect(),
  };
}

async function resolveWindow(main: HTMLElement, signal?: AbortSignal) {
  const context = watchContext(main, true);
  const keys = new Map<string, MessageKey>();
  try {
    const opaque = Array.from(main.querySelectorAll("[data-id]"))
      .filter((row) => !row.closest("[data-testid='quoted-message']"))
      .map((row) => row.getAttribute("data-id") ?? "").filter((id) => /^(?:[0-9a-f]{20}|[0-9a-f]{32})$/i.test(id));
    if (opaque.length) {
      const local = await resolveLocalMessageKeys(opaque, signal);
      if (!local.ok) return { ok: false as const, reason: local.reason };
      for (const [raw, key] of local.keys) keys.set(raw, key);
    }
    if (signal?.aborted || !context.current()) return { ok: false as const, reason: "The WhatsApp account, conversation or rendered messages changed during identity lookup. Try again with the chat left open." };
    const result = inspect(main, keys);
    return result.ok ? { ...result, keys } : result;
  } finally { context.close(); }
}

export async function inspectWhatsAppResolved(): Promise<Inspection> {
  const main = document.querySelector<HTMLElement>("#main");
  if (!main || !accountId()) return inspectWhatsApp();
  const result = await resolveWindow(main);
  return result.ok ? { ok: true, chat: result.chat, rendered: result.rendered } : result;
}

function bodyText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof HTMLBRElement) return "\n";
  if (node instanceof HTMLImageElement) return node.alt;
  const children = Array.from(node.childNodes).map(bodyText).join("");
  return node instanceof HTMLDivElement && node.nextSibling ? `${children}\n` : children;
}

function attachmentMarkers(row: Element): AttachmentSlot[] {
  const viewOnce = Array.from(row.querySelectorAll("[data-icon*='view-once'], [data-testid*='view-once']")).some((node) => !node.closest("[data-testid='quoted-message']"));
  if (viewOnce) return [{ slot: 1, attachment: { state: "unsupported", detail: "View-once content was not opened." } }];
  const media = Array.from(row.querySelectorAll("img:not(.emoji), video, audio, [data-testid='document-thumb'], [data-icon*='document']"))
    .filter((node) => !node.closest("[data-testid='quoted-message'], [data-testid='avatar']"));
  if (!media.length) return [];
  // Rendered images can be thumbnails. Their bytes are never reported as saved originals.
  const outer = media.filter((node) => !media.some((parent) => parent !== node && parent.contains(node)));
  return outer.slice(0, 32).map((_, index): AttachmentSlot => ({ slot: index + 1, attachment: { state: "unavailable", limitation: "This rendered attachment has no verified original bytes. It was not downloaded." } }));
}

async function readWindow(main: HTMLElement, expected: OpenChat, signal?: AbortSignal): Promise<{ messages: ObservedMessage[]; deletedIds: string[]; limitation: string | null; binding: string }> {
  const current = await resolveWindow(main, signal);
  if (!current.ok || document.querySelector("#main") !== main || current.chat.accountId !== expected.accountId || current.chat.chatId !== expected.chatId) {
    throw new Error("The WhatsApp account or selected conversation changed. Collection stopped before mixing content.");
  }
  const messages: ObservedMessage[] = [];
  const deletedIds: string[] = [];
  let limitation: string | null = null;
  for (const bubble of Array.from(main.querySelectorAll(".message-in, .message-out, [data-pre-plain-text]"))) {
    if (bubble.closest("[data-testid='quoted-message']")) continue;
    const keyed = bubble.closest("[data-id]") ?? bubble.querySelector("[data-id]");
    if (!keyed || !main.contains(keyed) || !messageKey(keyed, current.keys)) limitation = "unidentified-message";
  }
  for (const row of messageRows(main, current.keys)) {
    const key = messageKey(row, current.keys);
    if (!key || key.chatId !== expected.chatId) throw new Error("A rendered message belongs to another chat.");
    const copyable = (row.matches("[data-pre-plain-text]") ? [row] : Array.from(row.querySelectorAll<HTMLElement>("[data-pre-plain-text]")))
      .find((node) => !node.closest("[data-testid='quoted-message']"));
    const pre = copyable?.getAttribute("data-pre-plain-text") ?? "";
    const match = /^\[([^\]]+)\]\s*(.*):\s*$/su.exec(pre);
    const deleted = Array.from(row.querySelectorAll("[data-icon='recalled'], [data-icon='recalled-out'], [data-testid='recalled']")).some((node) => !node.closest("[data-testid='quoted-message']"));
    const parts = Array.from(row.querySelectorAll<HTMLElement>(".selectable-text"))
      .filter((node) => !node.parentElement?.closest(".selectable-text") && !node.closest("[data-testid='quoted-message']"));
    const body = parts.map(bodyText).join("\n");
    const quote = row.querySelector<HTMLElement>("[data-testid='quoted-message']");
    const quoted = quote ? bodyText(quote).replace(/\r\n?/g, "\n").split("\n").map((line) => `> ${line}`).join("\n") : "";
    const text = [quoted, body].filter((part) => part !== "").join("\n\n").replace(/\r\n?/g, "\n");
    const attachments = attachmentMarkers(row);
    if (!match && !deleted) { limitation = "unsupported-message-envelope"; continue; }
    if (!text && !attachments.length && !deleted) { limitation = "unloaded-message"; continue; }
    if (deleted) {
      deletedIds.push(key.id);
      attachments.push({ slot: attachments.length + 1, attachment: { state: "unavailable", limitation: "WhatsApp reports this message deleted; original content is unavailable." } });
    }
    messages.push({
      id: key.id,
      sender: { key: key.outgoing ? expected.accountId : key.senderId, name: match?.[2] || (key.outgoing ? "You" : "Unknown sender") },
      timestamp: { display: match?.[1] ?? "", precision: match ? "display-only" : "unknown", timeZone: null, instant: null },
      sequence: "verified",
      text,
      attachments,
      sourceBaseline: JSON.stringify({ text, attachments, deleted }),
    });
  }
  return { messages, deletedIds, limitation, binding: rowSignature(main) };
}

/** Join only when observed windows give one unambiguous ordering. */
function joinWindows(saved: ObservedMessage[], observed: ObservedMessage[]): ObservedMessage[] | null {
  if (!saved.length) return observed;
  const existing = new Set(saved.map((message) => message.id));
  if (!observed.some((message) => existing.has(message.id))) return null;
  const values = new Map([...saved, ...observed].map((message) => [message.id, message]));
  const edges = new Map([...values.keys()].map((id) => [id, new Set<string>()]));
  const degree = new Map([...values.keys()].map((id) => [id, 0]));
  for (const window of [saved, observed]) for (let index = 1; index < window.length; index += 1) {
    const before = window[index - 1]?.id, after = window[index]?.id;
    if (!before || !after || edges.get(before)?.has(after)) continue;
    edges.get(before)?.add(after); degree.set(after, (degree.get(after) ?? 0) + 1);
  }
  const result: ObservedMessage[] = [];
  while (degree.size) {
    const ready = [...degree].filter(([, count]) => count === 0);
    if (ready.length !== 1) return null;
    const id = ready[0]?.[0], message = id ? values.get(id) : undefined;
    if (!id || !message) return null;
    result.push(message); degree.delete(id);
    for (const after of edges.get(id) ?? []) degree.set(after, (degree.get(after) ?? 0) - 1);
  }
  return result;
}

function scrollContainer(main: HTMLElement): HTMLElement | null {
  const sample = Array.from(main.querySelectorAll<HTMLElement>("[data-pre-plain-text]")).find((node) => !node.closest("[data-testid='quoted-message']")) ?? messageRows(main)[0];
  for (let node = sample?.parentElement; node && main.contains(node); node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

export async function collectWhatsApp(input: {
  expected: OpenChat;
  limit: number;
  maxMs: number;
  scope: "visible" | "loaded";
  signal?: AbortSignal;
  onProgress?: (count: number) => void;
}): Promise<CollectedChat> {
  const main = document.querySelector<HTMLElement>("#main");
  if (!main) throw new Error("Open the selected WhatsApp conversation first.");
  const limit = Number.isFinite(input.limit) ? Math.min(Math.max(Math.floor(input.limit), 1), 500) : 500;
  const deadline = Date.now() + (Number.isFinite(input.maxMs) ? Math.min(Math.max(input.maxMs, 1_000), 60_000) : 24_000);
  const scroller = scrollContainer(main), originalTop = scroller?.scrollTop;
  const context = watchContext(main);
  let messages: ObservedMessage[] = [], deletedIds: string[] = [], upperId: string | null = null;
  let verifiedRows: string | null = null;
  let stopReason = input.scope === "visible" ? "visible-window" : "history-boundary-unverified";
  let contiguous = true, idle = 0;
  try {
    while (true) {
      if (input.signal?.aborted) { stopReason = "stopped"; break; }
      if (!context.current()) throw new Error("The selected WhatsApp conversation changed.");
      const window = await readWindow(main, input.expected, input.signal);
      if (!context.current()) throw new Error("The selected WhatsApp conversation changed.");
      verifiedRows = window.binding;
      if (upperId === null) upperId = window.messages.at(-1)?.id ?? null;
      const cutoff = window.messages.findIndex((message) => message.id === upperId);
      const observed = cutoff >= 0 ? window.messages.slice(0, cutoff + 1) : window.messages;
      const merged = joinWindows(messages, observed);
      if (!merged) { stopReason = "unverified-history-overlap"; contiguous = false; break; }
      idle = merged.length === messages.length ? idle + 1 : 0;
      messages = merged;
      let bytes = 0;
      const bounded: ObservedMessage[] = [];
      for (const message of [...messages].reverse()) {
        bytes += new TextEncoder().encode(JSON.stringify(message)).byteLength;
        if (bytes > 128 * 1024) break;
        bounded.unshift(message);
      }
      const overBytes = bounded.length !== messages.length;
      if (overBytes) messages = bounded;
      deletedIds = [...new Set([...deletedIds, ...window.deletedIds])];
      input.onProgress?.(messages.length);
      if (overBytes) { stopReason = "byte-budget"; break; }
      if (window.limitation) { stopReason = window.limitation; contiguous = false; break; }
      if (messages.length >= limit) { messages = messages.slice(-limit); stopReason = "message-budget"; break; }
      if (input.scope === "visible") break;
      if (Date.now() >= deadline) { stopReason = "time-budget"; break; }
      if (!scroller) { stopReason = "history-scroll-unavailable"; break; }
      if (idle >= 3) break;
      scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.max(scroller.clientHeight * 0.7, 160));
      await wait(450, input.signal);
    }
  } finally {
    if (scroller && originalTop !== undefined && context.current() && rowSignature(main) === verifiedRows) scroller.scrollTop = originalTop;
    context.close();
  }
  const kept = new Set(messages.map((message) => message.id));
  return { chat: input.expected, messages, order: "verified", contiguous, stopReason, deletedIds: deletedIds.filter((id) => kept.has(id)) };
}
