import { createHash } from "node:crypto";
import type { Download, Locator, Page } from "@playwright/test";
import type { AttachmentSlot } from "../src/model";
import type { CollectedChat, OpenChat } from "../src/whatsapp";
import type {} from "./page-entry";

export type LocalInspection = Awaited<ReturnType<Window["waScribeLocal"]["inspect"]>>;
export type LocalCatalog = Awaited<ReturnType<Window["waScribeLocal"]["catalog"]>>;
export type NavigationTarget = OpenChat & { aliases?: readonly string[] };
export type CaptureOptions = {
  limit: number;
  scope: "visible" | "loaded";
  signal?: AbortSignal;
  onProgress?: (count: number) => void;
  skipMediaIds?: ReadonlySet<string>;
  knownAttachments?: ReadonlyMap<string, readonly AttachmentSlot[]>;
};
export type StashOriginal = (bytes: Uint8Array, name: string, mediaType: string | null) => Promise<AttachmentSlot["attachment"]>;

const MAX_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_MARKERS = "[data-icon='download'], [data-testid='download'], [data-testid='download-button'], [aria-label='Download'], [title='Download'], a[download]";
const PDF_VIEWER = "iframe[data-testid='pdf-viewer-iframe']";
const VIEWERS = `:is([data-testid='media-viewer'], [role='dialog']:has([data-icon='x-viewer'])):not(:has(${PDF_VIEWER})):not(#main *):not(#pane-side *):not([data-testid='media-viewer'] *):not([role='dialog'] *)`;
const UNRELATED_DIALOGS = `[role='dialog']:not([data-testid='media-viewer']):not([data-testid='media-viewer'] *):not(:has([data-testid='media-viewer'], [data-icon='x-viewer'], ${PDF_VIEWER})):not(#main *):not(#pane-side *)`;
const capturing = new WeakSet<Page>();

function stopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Collection stopped.");
}

function cssString(value: string): string {
  return `"${Array.from(value, (char) => /[\x00-\x1f\x7f]/u.test(char)
    ? `\\${char.charCodeAt(0).toString(16)} ` : char === "\\" || char === '"' ? `\\${char}` : char).join("")}"`;
}

function sameChat(actual: OpenChat, expected: OpenChat): boolean {
  return actual.accountId === expected.accountId && actual.chatId === expected.chatId;
}

export async function listChats(page: Page): Promise<LocalCatalog> {
  return page.evaluate(() => window.waScribeLocal.catalog());
}

export async function inspectPage(page: Page): Promise<LocalInspection> {
  return page.evaluate(() => window.waScribeLocal.inspect());
}

async function guardAccount(page: Page, expected: OpenChat, signal?: AbortSignal): Promise<void> {
  stopped(signal);
  if (await page.evaluate(() => window.waScribeLocal.account()) !== expected.accountId) {
    throw new Error("The WhatsApp account changed. Collection stopped.");
  }
  stopped(signal);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
  stopped(signal);
}

async function matchingLabel(page: Page, expected: NavigationTarget): Promise<Locator | null> {
  const hints = [...new Set([expected.name, ...(expected.aliases ?? [])].filter((name) => name.trim()))];
  const labels = page.locator("#pane-side [title]");
  const phone = /^(\d+)@(?:c\.us|s\.whatsapp\.net)$/.exec(expected.chatId)?.[1] ?? null;
  // Labels are navigation hints only. The conversation's canonical ID is checked after clicking.
  const matches = await labels.evaluateAll((nodes, input) => {
    const rows = new Set<Element>();
    const indices: number[] = [];
    nodes.forEach((node, index) => {
      const title = node.getAttribute("title") ?? "";
      const phoneMatch = input.phone !== null && /^\+?[\d ()-]{7,32}$/.test(title) && title.replace(/\D/g, "") === input.phone;
      if (!input.hints.includes(title) && !phoneMatch) return;
      const row = node.closest("[role='row'], [role='listitem']");
      if (!row || rows.has(row) || node.closest("[hidden], [aria-hidden='true']")) return;
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      if (!rect.width || !rect.height || style.visibility === "hidden" || style.display === "none") return;
      rows.add(row); indices.push(index);
    });
    return indices;
  }, { hints, phone });
  if (matches.length > 1) throw new Error("More than one visible WhatsApp chat matches this chat's navigation hints.");
  return matches[0] === undefined ? null : labels.nth(matches[0]);
}

export async function openChat(page: Page, expected: NavigationTarget, signal?: AbortSignal): Promise<OpenChat> {
  await guardAccount(page, expected, signal);
  if (await page.locator(UNRELATED_DIALOGS).filter({ visible: true }).count()) {
    throw new Error("Close the open WhatsApp dialog before navigating to a chat.");
  }
  await dismissKnownViewers(page, expected, signal);
  const before = await inspectPage(page);
  if (before.ok && sameChat(before.chat, expected)) return before.chat;
  if (before.ok && before.chat.accountId !== expected.accountId) throw new Error("The WhatsApp account changed.");
  if (await page.locator("#pane-side").count() !== 1) throw new Error("WhatsApp's unique chat sidebar is unavailable.");
  const deadline = Date.now() + 12_000;
  let label = await matchingLabel(page, expected), search: Locator | null = null;
  if (!label) {
    const side = page.locator("#side");
    const root = await side.count() === 1 && await side.locator("#pane-side").count() === 1 && await side.locator("#main").count() === 0
      ? side : page.locator("#pane-side");
    search = root.locator("[contenteditable='true'][role='textbox'], input[role='combobox'], input[type='search']").filter({ visible: true });
    if (await search.count() !== 1) throw new Error("WhatsApp's sidebar search field is unavailable or ambiguous.");
    const phone = /^(\d+)@(?:c\.us|s\.whatsapp\.net)$/.exec(expected.chatId)?.[1];
    await guardAccount(page, expected, signal);
    await search.fill(expected.name === expected.chatId && phone ? phone : expected.name, { timeout: 3_000 });
    while (!label && Date.now() < deadline) {
      await guardAccount(page, expected, signal);
      label = await matchingLabel(page, expected);
      if (!label) await delay(150, signal);
    }
  }
  if (!label) throw new Error("The requested chat did not appear in WhatsApp's sidebar search.");
  await guardAccount(page, expected, signal);
  await label.click({ timeout: 3_000 });
  while (Date.now() < deadline) {
    await guardAccount(page, expected, signal);
    const current = await inspectPage(page);
    if (current.ok && sameChat(current.chat, expected)) {
      if (search) {
        await search.fill("", { timeout: 3_000 });
        await guardAccount(page, expected, signal);
        const cleared = await inspectPage(page);
        if (!cleared.ok || !sameChat(cleared.chat, expected)) throw new Error("The conversation changed while clearing WhatsApp search.");
      }
      return current.chat;
    }
    if (current.ok && (!before.ok || current.chat.chatId !== before.chat.chatId)) {
      throw new Error("WhatsApp opened a different conversation. Collection stopped.");
    }
    await delay(150, signal);
  }
  throw new Error("WhatsApp did not verify the requested conversation after navigation.");
}

function visibleViewers(page: Page): Locator {
  return page.locator(`${VIEWERS}, ${PDF_VIEWER}`).filter({ visible: true });
}

function controls(root: Locator, markers: string): Locator {
  return root.locator(markers).locator("xpath=ancestor-or-self::*[self::button or @role='button' or (self::a and @download)][1]").filter({ visible: true });
}

async function dismissKnownViewers(page: Page, expected: OpenChat, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await guardAccount(page, expected, signal);
    const viewers = visibleViewers(page);
    const count = await viewers.count();
    if (!count) return;
    if (count > 1) throw new Error("More than one WhatsApp media or PDF viewer is open. Close the viewers before continuing.");
    const viewer = viewers.first();
    try {
      await page.keyboard.press("Escape");
    } catch {
      throw new Error("WhatsApp's media or PDF viewer is still blocking the page. Close it before continuing.");
    }
    await page.waitForTimeout(250);
    await guardAccount(page, expected, signal);
    const pdfFrame = page.locator(PDF_VIEWER).filter({ visible: true });
    if (await pdfFrame.count()) {
      await pdfFrame.evaluate((node) => {
        if (node instanceof HTMLIFrameElement) node.blur();
      });
      try { await page.keyboard.press("Escape"); }
      catch { throw new Error("WhatsApp's media or PDF viewer is still blocking the page. Close it before continuing."); }
      await page.waitForTimeout(250);
      await guardAccount(page, expected, signal);
    }
    if (await visibleViewers(page).count()) {
      const pdfFrame = page.locator(PDF_VIEWER).filter({ visible: true });
      const parent = await pdfFrame.count() ? pdfFrame.locator("xpath=..") : null;
      const closeRoot = parent && await parent.evaluate((node) => !["BODY", "HTML", "MAIN"].includes(node.tagName) &&
        node.id !== "main" && node.id !== "pane-side" && !node.closest("#main, #pane-side") && !node.querySelector("#main, #pane-side"))
        ? parent : viewer;
      const close = controls(closeRoot, "[data-icon='x-viewer'], [data-icon='x'], [aria-label='Close'], [title='Close']");
      if (await close.count() === 1) {
        try { await close.click({ timeout: 1_000 }); }
        catch { throw new Error("WhatsApp's media or PDF viewer is still blocking the page. Close it before continuing."); }
        await page.waitForTimeout(250);
      }
    }
    await guardAccount(page, expected, signal);
    if (!await visibleViewers(page).count()) return;
  }
  throw new Error("WhatsApp's media or PDF viewer is still blocking the page. Close it before continuing.");
}

async function within<T>(operation: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Collection stopped."));
      timer = setTimeout(() => reject(new Error("The attachment time budget was reached.")), Math.max(1, deadline - Date.now()));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

async function readDownload(download: Download, deadline: number, signal?: AbortSignal): Promise<Uint8Array> {
  let abandoned = false;
  const obtaining = download.createReadStream();
  // If Stop wins before Chromium supplies the stream, release that late stream too.
  void obtaining.then((stream) => { if (abandoned) stream?.destroy(); }, () => undefined);
  let stream: Awaited<ReturnType<Download["createReadStream"]>> | null = null;
  try {
    stream = await within(obtaining, deadline, signal);
    if (!stream) throw new Error("WhatsApp did not deliver readable original bytes.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reading = (async () => {
      if (!stream) throw new Error("The original download stream is unavailable.");
      for await (const chunk of stream) {
        const bytes = chunk instanceof Uint8Array ? chunk : null;
        if (!bytes) throw new Error("WhatsApp delivered an unsupported original stream.");
        size += bytes.byteLength;
        if (size > MAX_BYTES) throw new Error("The attachment exceeds the 8 MiB local prototype limit.");
        chunks.push(bytes);
      }
    })();
    await within(reading, deadline, signal);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    abandoned = true;
    stream?.destroy();
    await download.cancel();
    await download.delete();
  }
}

async function captureOriginal(page: Page, expected: OpenChat, message: CollectedChat["messages"][number], deadline: number, signal?: AbortSignal): Promise<{
  bytes: Uint8Array; name: string; mediaType: string | null; verify: () => Promise<void>;
}> {
  const initial = await page.evaluate((id) => window.waScribeLocal.row(id), message.id);
  if (!initial.ok || initial.text !== message.text) throw new Error("The attachment's keyed message changed before download.");
  const row = page.locator(`#main [data-id=${cssString(initial.rawId)}]`);
  if (await row.count() !== 1 || !await row.isVisible() || !await row.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return bounds.bottom > 0 && bounds.right > 0 && bounds.top < innerHeight && bounds.left < innerWidth;
  })) throw new Error("The attachment is outside the current visible conversation window.");
  const metadata = await page.evaluate((id) => window.waScribeLocal.original(id), message.id);
  if (!metadata.ok) throw new Error(metadata.reason);
  const verify = async () => {
    stopped(signal);
    const inspection = await inspectPage(page);
    stopped(signal);
    const current = await page.evaluate((id) => window.waScribeLocal.row(id), message.id);
    stopped(signal);
    const original = await page.evaluate((id) => window.waScribeLocal.original(id), message.id);
    if (!inspection.ok || !sameChat(inspection.chat, expected) || !current.ok || current.rawId !== initial.rawId ||
        current.text !== message.text || !original.ok || JSON.stringify(original.value) !== JSON.stringify(metadata.value) ||
        await row.count() !== 1 || await row.locator("[data-icon*='view-once'], [data-testid*='view-once'], [data-icon='recalled'], [data-icon='recalled-out'], [data-testid='recalled']").count()) {
      throw new Error("The attachment's account, conversation, message or original metadata changed.");
    }
    stopped(signal);
  };
  let cleanupViewer = false;
  let downloadWaiting: Promise<{ ok: true; download: Download } | { ok: false }> | null = null;
  let consumedDownload: Download | null = null;
  try {
    await verify();
    if (await visibleViewers(page).count()) throw new Error("Close the existing WhatsApp media viewer before capturing attachments.");
    const pending: { download: Download | null } = { download: null };
    const waiting = page.waitForEvent("download", {
      timeout: Math.max(1, Math.min(8_000, deadline - Date.now())),
    })
      .then((download) => { pending.download = download; return { ok: true as const, download }; }, () => ({ ok: false as const }));
    downloadWaiting = waiting;
    cleanupViewer = true;
    let buttons = controls(row, DOWNLOAD_MARKERS);
    if (await buttons.count() === 0) {
      const documentTile = row.locator("[data-testid='document-thumb']").filter({ visible: true });
      if (await documentTile.count() === 1) {
        await verify();
        try { await documentTile.click({ timeout: Math.max(1, Math.min(2_000, deadline - Date.now())) }); }
        catch { throw new Error("WhatsApp's PDF preview could not be opened safely."); }
        const viewerDeadline = Math.min(deadline, Date.now() + 2_000);
        const pdfViewer = page.locator(PDF_VIEWER).filter({ visible: true });
        while (Date.now() < viewerDeadline && !pending.download && await pdfViewer.count() === 0) await delay(100, signal);
        if (!pending.download) {
          if (await pdfViewer.count() !== 1) throw new Error("WhatsApp's PDF preview did not open a recognized viewer; the original is unavailable.");
          const pdfBody = page.frameLocator(PDF_VIEWER).locator("body");
          buttons = controls(pdfBody, DOWNLOAD_MARKERS);
          if (await buttons.count() === 0) {
            const parent = pdfViewer.locator("xpath=..");
            const safeParent = await parent.evaluate((node) => !["BODY", "HTML", "MAIN"].includes(node.tagName) &&
              node.id !== "main" && node.id !== "pane-side" && !node.closest("#main, #pane-side") && !node.querySelector("#main, #pane-side"));
            if (safeParent) buttons = controls(parent, DOWNLOAD_MARKERS);
          }
        }
      } else {
        const image = row.locator("img:not(.emoji)").filter({ visible: true });
        if (await image.count() !== 1 || await row.locator("video, audio").count()) throw new Error("This attachment has no supported individual original download control.");
        await verify();
        await image.click({ timeout: Math.max(1, Math.min(2_000, deadline - Date.now())) });
        const viewerDeadline = Math.min(deadline, Date.now() + 2_000);
        while (Date.now() < viewerDeadline) {
          const viewers = visibleViewers(page);
          if (await viewers.count() === 1) break;
          if (await viewers.count() > 1) break;
          await delay(100, signal);
        }
        if (!pending.download) {
          if (await visibleViewers(page).count() !== 1) throw new Error("WhatsApp's original image viewer is unavailable or ambiguous.");
          buttons = controls(visibleViewers(page).first(), DOWNLOAD_MARKERS);
        }
      }
    }
    if (!pending.download && await buttons.count() !== 1) {
      throw new Error("The original download control is unavailable or ambiguous.");
    }
    await verify();
    let received: Awaited<typeof waiting>;
    if (pending.download) {
      received = { ok: true, download: pending.download };
    } else {
      try {
        await buttons.click({ timeout: Math.max(1, Math.min(2_000, deadline - Date.now())) });
        received = await within(waiting, deadline, signal);
      } catch (cause) {
        // The outer cleanup drains and deletes any late native download before another pass can start.
        throw new Error("WhatsApp's original download was stopped or its control changed.", { cause });
      }
    }
    if (!received.ok) throw new Error("WhatsApp did not deliver an original download within the time limit.");
    const name = metadata.value.name ?? received.download.suggestedFilename();
    consumedDownload = received.download;
    const bytes = await readDownload(received.download, deadline, signal);
    await verify();
    if (createHash("sha256").update(bytes).digest("hex") !== metadata.value.digest.toLowerCase() ||
        metadata.value.size !== null && bytes.byteLength !== metadata.value.size) {
      throw new Error("The downloaded bytes did not match this message's original hash and size.");
    }
    if (!name.trim() || name.length > 256 || name.includes("://") || /[\x00-\x1f\x7f/\\:]/u.test(name)) {
      throw new Error("WhatsApp did not supply a safe original filename.");
    }
    return { bytes, name, mediaType: metadata.value.mediaType, verify };
  } finally {
    try {
      // Keep the pass serialized until a triggered download arrives or its handled wait expires.
      if (downloadWaiting && !consumedDownload) {
        const late = await downloadWaiting;
        if (late.ok) {
          await late.download.cancel();
          await late.download.delete();
        }
      }
    } finally {
      if (cleanupViewer) await dismissKnownViewers(page, expected);
    }
  }
}

export async function capturePass(page: Page, expected: OpenChat, options: CaptureOptions, stash: StashOriginal): Promise<CollectedChat> {
  if (capturing.has(page)) throw new Error("Another attachment capture is already using this WhatsApp page.");
  capturing.add(page);
  try {
    await guardAccount(page, expected, options.signal);
    const deadline = Date.now() + 24_000;
    // The prototype captures one rendered window so UI media navigation cannot invalidate a live collector observer.
    const collected = await page.evaluate((input) => window.waScribeLocal.collect(input), {
      expected, limit: Math.min(50, Math.max(1, options.limit)), maxMs: 12_000, scope: "visible" as const,
    });
    if (options.scope === "loaded") collected.stopReason = "local-prototype-visible-window";
    options.onProgress?.(collected.messages.length);
    const deleted = new Set(collected.deletedIds);
    for (const message of collected.messages) {
      if (options.signal?.aborted || Date.now() >= deadline) { collected.stopReason = options.signal?.aborted ? "stopped" : "time-budget"; break; }
      if (!message.attachments.length || deleted.has(message.id) || options.skipMediaIds?.has(message.id)) continue;
      const known = options.knownAttachments?.get(message.id);
      if (known?.some((entry) => entry.attachment.state === "saved" || entry.attachment.state === "opaque")) {
        message.attachments = message.attachments.map((entry) => known.find((item) => item.slot === entry.slot &&
          (item.attachment.state === "saved" || item.attachment.state === "opaque")) ?? entry);
        continue;
      }
      if (message.attachments.some((entry) => entry.attachment.state === "unsupported")) continue;
      if (message.attachments.length !== 1) {
        message.attachments = message.attachments.map((entry) => ({ slot: entry.slot, attachment: {
          state: "unavailable", limitation: "Individual originals in this media group could not be identified safely.",
        } }));
        continue;
      }
      try {
        const original = await captureOriginal(page, expected, message, deadline, options.signal);
        stopped(options.signal);
        const attachment = await stash(original.bytes, original.name, original.mediaType);
        await original.verify();
        message.attachments = [{ slot: message.attachments[0]?.slot ?? 1, attachment }];
      } catch (cause) {
        // A failed external download preserves the message and its explicit attachment limitation.
        const limitation = cause instanceof Error && !cause.message.includes("\n") && cause.message.length < 240
          ? cause.message : "WhatsApp's original attachment download could not be verified.";
        message.attachments = message.attachments.map((entry) => ({ slot: entry.slot, attachment: { state: "unavailable", limitation } }));
      }
      const current = await inspectPage(page);
      if (!current.ok || !sameChat(current.chat, expected)) throw new Error("The WhatsApp account or conversation changed during attachment capture.");
      options.onProgress?.(collected.messages.length);
    }
    if (options.signal?.aborted) collected.stopReason = "stopped";
    await guardAccount(page, expected, options.signal?.aborted ? undefined : options.signal);
    const final = await inspectPage(page);
    if (!final.ok || !sameChat(final.chat, expected)) throw new Error("The WhatsApp account or conversation changed before capture completed.");
    return collected;
  } finally { capturing.delete(page); }
}
