import { accountId, inspectWhatsAppResolved } from "./whatsapp";
import type { OpenChat } from "./whatsapp";

type NavigationTarget = OpenChat & { aliases?: readonly string[]; allowNameNavigation?: boolean };
type Result = Awaited<ReturnType<typeof inspectWhatsAppResolved>>;

const SIDEBAR_ROWS = "[role='row'], [role='listitem']";
const SEARCH_BOXES = "[contenteditable='true'][role='textbox'], input[role='combobox'], input[type='search']";
const DEADLINE_MS = 12_000;

function stopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Chat navigation stopped.");
}

function guard(expected: NavigationTarget, signal?: AbortSignal): void {
  stopped(signal);
  if (accountId() !== expected.accountId) throw new Error("The WhatsApp account changed. Chat navigation stopped.");
}

function visible(node: Element): boolean {
  if (!node.isConnected || node.closest("[hidden], [aria-hidden='true']")) return false;
  const style = getComputedStyle(node);
  return style.display !== "none" && style.visibility !== "hidden" && node.getClientRects().length > 0;
}

function displayHints(target: NavigationTarget): Set<string> {
  return new Set([target.name, ...(target.aliases ?? [])].filter((value) => value.trim() !== ""));
}

function matchingRows(sidebar: Element, hints: ReadonlySet<string>, target: NavigationTarget): HTMLElement[] {
  const rows = new Set<HTMLElement>();
  for (const label of Array.from(sidebar.querySelectorAll<HTMLElement>("[title]"))) {
    const title = label.getAttribute("title");
    const phone = /^(\d+)@(?:c\.us|s\.whatsapp\.net)$/.exec(target.chatId)?.[1];
    const phoneMatch = title !== null && phone !== undefined && /^\+?[\d ()-]{7,32}$/.test(title) && title.replace(/\D/g, "") === phone;
    if (!title || (!hints.has(title) && !phoneMatch) || !visible(label)) continue;
    const row = label.closest<HTMLElement>(SIDEBAR_ROWS);
    if (row && sidebar.contains(row) && visible(row)) rows.add(row);
  }
  return [...rows];
}

function requireUniqueRow(rows: HTMLElement[]): HTMLElement | null {
  if (rows.length > 1) throw new Error("More than one visible WhatsApp chat matches the saved display name.");
  return rows[0] ?? null;
}

function getSearchBox(sidebar: Element): HTMLElement {
  const matches = Array.from(sidebar.querySelectorAll<HTMLElement>(SEARCH_BOXES)).filter(visible);
  if (matches.length !== 1) throw new Error("WhatsApp's sidebar search field is unavailable or ambiguous.");
  const box = matches[0];
  if (!box) throw new Error("WhatsApp's sidebar search field is unavailable or ambiguous.");
  return box;
}

function typeSearch(box: HTMLElement, value: string, expected: NavigationTarget, signal?: AbortSignal): void {
  guard(expected, signal);
  box.focus();
  guard(expected, signal);
  if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
    box.setSelectionRange(0, box.value.length);
    guard(expected, signal);
    box.setRangeText(value, 0, box.value.length, "end");
    guard(expected, signal);
    box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    return;
  }

  const selection = window.getSelection();
  if (!selection) throw new Error("WhatsApp's sidebar search field cannot be edited safely.");
  const range = document.createRange();
  range.selectNodeContents(box);
  guard(expected, signal);
  selection.removeAllRanges();
  guard(expected, signal);
  selection.addRange(range);
  guard(expected, signal);
  if (!document.execCommand("insertText", false, value)) {
    throw new Error("WhatsApp's sidebar search field rejected the search text.");
  }
  guard(expected, signal);
  box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

function clearSearch(box: HTMLElement, expected: NavigationTarget, beforeMutation: () => void): void {
  if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
    beforeMutation();
    box.setRangeText("", 0, box.value.length, "end");
  } else {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(box);
    beforeMutation();
    selection.removeAllRanges();
    beforeMutation();
    selection.addRange(range);
    beforeMutation();
    document.execCommand("delete", false);
  }
  beforeMutation();
  box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContent" }));
}

function matches(result: Result, expected: NavigationTarget): boolean {
  return result.ok && result.chat.accountId === expected.accountId && result.chat.chatId === expected.chatId;
}

function verified(result: Result, expected: NavigationTarget): void {
  if (result.ok && result.chat.accountId !== expected.accountId) {
    throw new Error("The WhatsApp account changed. Chat navigation stopped.");
  }
  if (result.ok && result.chat.chatId !== expected.chatId) {
    throw new Error("WhatsApp opened a different conversation. Chat navigation stopped.");
  }
}

function assertResolvedAccount(result: Result, expected: NavigationTarget): void {
  if (result.ok && result.chat.accountId !== expected.accountId) {
    throw new Error("The WhatsApp account changed. Chat navigation stopped.");
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Chat navigation stopped."));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new Error("Chat navigation stopped."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function pollSidebar(target: NavigationTarget, sidebar: Element, deadline: number, signal?: AbortSignal): Promise<HTMLElement> {
  while (Date.now() < deadline) {
    guard(target, signal);
    const row = requireUniqueRow(matchingRows(sidebar, displayHints(target), target));
    if (row) return row;
    await wait(Math.min(150, Math.max(1, deadline - Date.now())), signal);
  }
  throw new Error("The requested chat did not appear in WhatsApp's sidebar search.");
}

async function pollConversation(target: NavigationTarget, oldChatId: string | null, deadline: number, signal?: AbortSignal): Promise<void> {
  while (Date.now() < deadline) {
    guard(target, signal);
    const result = await inspectWhatsAppResolved();
    guard(target, signal);
    assertResolvedAccount(result, target);
    if (matches(result, target)) return;
    if (result.ok && result.chat.chatId !== oldChatId) verified(result, target);
    await wait(Math.min(150, Math.max(1, deadline - Date.now())), signal);
  }
  throw new Error("WhatsApp did not verify the requested conversation after navigation.");
}

export async function openWhatsAppChat(expected: NavigationTarget, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  guard(expected, signal);
  const current = await inspectWhatsAppResolved();
  guard(expected, signal);
  assertResolvedAccount(current, expected);
  if (matches(current, expected)) return;
  if (expected.allowNameNavigation === false) throw new Error("This chat's name is ambiguous. Open it once in WhatsApp Web before syncing.");

  const sidebar = document.querySelector("#pane-side");
  if (!sidebar || document.querySelectorAll("#pane-side").length !== 1) {
    throw new Error("WhatsApp's unique chat sidebar is unavailable.");
  }

  let search: HTMLElement | null = null;
  let trustedInput = false;
  const trackTrustedInput = (event: Event) => { if (event.isTrusted) trustedInput = true; };
  document.addEventListener("pointerdown", trackTrustedInput, true);
  document.addEventListener("keydown", trackTrustedInput, true);
  document.addEventListener("click", trackTrustedInput, true);
  try {
    let row = requireUniqueRow(matchingRows(sidebar, displayHints(expected), expected));
    if (!row) {
      const side = document.querySelector("#side");
      const searchBox = getSearchBox(side && side.contains(sidebar) && !side.querySelector("#main") ? side : sidebar);
      search = searchBox;
      guard(expected, signal);
      const phone = /^(\d+)@(?:c\.us|s\.whatsapp\.net)$/.exec(expected.chatId)?.[1];
      typeSearch(searchBox, expected.name === expected.chatId && phone ? phone : expected.name, expected, signal);
      row = await pollSidebar(expected, sidebar, deadline, signal);
    }

    guard(expected, signal);
    row.click();
    await pollConversation(expected, current.ok ? current.chat.chatId : null, deadline, signal);
  } finally {
    document.removeEventListener("pointerdown", trackTrustedInput, true);
    document.removeEventListener("keydown", trackTrustedInput, true);
    document.removeEventListener("click", trackTrustedInput, true);
    if (search && !signal?.aborted && !trustedInput && accountId() === expected.accountId) {
      clearSearch(search, expected, () => {
        if (trustedInput) throw new Error("Chat navigation stopped after user input.");
        guard(expected, signal);
      });
    }
  }
}
