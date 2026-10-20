import { contentHello, panelPing } from "./protocol";
import { reportExchange } from "./report";
import { runTextDownload } from "./alpha";
import { diagnose, readSource } from "./source";
import { accountId, collectWhatsApp, inspectWhatsAppResolved } from "./whatsapp";
import { readLocalChatCatalog } from "./chat-catalog";
import { openWhatsAppChat } from "./chat-navigation";
import { captureOriginalAttachment } from "./media-capture";
import { readMessageOriginal } from "./original-metadata";
import type { Attachment, AttachmentSlot } from "./model";

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storedAttachment(value: unknown): Attachment | null {
  if (!objectRecord(value) || (value.state !== "saved" && value.state !== "opaque") || typeof value.name !== "string" ||
      typeof value.relativePath !== "string" || value.relativePath.length > 512 || value.name.length > 256) return null;
  if (value.state === "saved" && typeof value.mediaType === "string") return { state: "saved", name: value.name, relativePath: value.relativePath, mediaType: value.mediaType };
  if (value.state === "opaque" && (value.mediaType === null || typeof value.mediaType === "string")) return { state: "opaque", name: value.name, relativePath: value.relativePath, mediaType: value.mediaType };
  return null;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32_768) binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  return btoa(binary);
}

if (location.origin === "https://web.whatsapp.com") {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !objectRecord(message) || message.protocol !== "wa-scribe.app") return undefined;
    if (message.type === "account") {
      const account = accountId();
      sendResponse(account ? { ok: true, accountId: account } : { ok: false, reason: "Sign in to WhatsApp Web first." });
      return undefined;
    }
    if (message.type === "catalog") {
      const account = accountId();
      if (!account) { sendResponse({ ok: false, reason: "Sign in to WhatsApp Web first." }); return undefined; }
      void readLocalChatCatalog().then((result) => sendResponse(accountId() === account ? { ...result, accountId: account } :
        { ok: false, reason: "The WhatsApp account changed while reading the chat list." }))
        .catch(() => sendResponse({ ok: false, reason: "The local WhatsApp chat list could not be read." }));
      return true;
    }
    if (message.type !== "inspect") return undefined;
    void inspectWhatsAppResolved().then(sendResponse).catch(() => sendResponse({ ok: false, reason: "WhatsApp identity lookup failed. Reload WhatsApp Web and try again." }));
    return true;
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "wa-scribe.app" || port.sender?.id !== chrome.runtime.id) return;
    const controller = new AbortController();
    const pending = new Map<string, { finish: (attachment: Attachment | null) => void; timer: ReturnType<typeof setTimeout> }>();
    let started = false, disconnected = false, transferred = 0;
    const reply = (value: unknown) => { if (!disconnected) port.postMessage(value); };
    const rejectPending = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.finish(null); } pending.clear(); };
    port.onDisconnect.addListener(() => { disconnected = true; controller.abort(); rejectPending(); });
    const interrupt = (event: Event) => {
      if (!event.isTrusted || controller.signal.aborted) return;
      controller.abort(); rejectPending();
      reply({ type: "error", interrupted: true, reason: "Sync stopped because you used WhatsApp. Start again when ready." });
    };
    port.onMessage.addListener((message: unknown) => {
      if (!objectRecord(message)) return;
      if (message.type === "media-ack" && typeof message.requestId === "string") {
        const request = pending.get(message.requestId);
        if (request) { pending.delete(message.requestId); clearTimeout(request.timer); request.finish(message.ok === true ? storedAttachment(message.attachment) : null); }
        return;
      }
      if (started || message.type !== "collect" || !objectRecord(message.expected) || typeof message.expected.accountId !== "string" ||
          typeof message.expected.chatId !== "string" || typeof message.expected.name !== "string" ||
          (message.scope !== "visible" && message.scope !== "loaded") || typeof message.limit !== "number") return;
      started = true;
      const expected = { accountId: message.expected.accountId, chatId: message.expected.chatId, name: message.expected.name };
      const scope = message.scope, limit = message.limit;
      const aliases = Array.isArray(message.aliases) ? message.aliases.filter((value): value is string => typeof value === "string" && value.length <= 256).slice(0, 6) : [];
      const skipIds = new Set(Array.isArray(message.skipIds) ? message.skipIds.filter((value): value is string => typeof value === "string").slice(0, 5000) : []);
      const known = new Map<string, AttachmentSlot[]>();
      for (const entry of Array.isArray(message.knownAttachments) ? message.knownAttachments.slice(0, 5000) : []) {
        if (!objectRecord(entry) || typeof entry.messageId !== "string" || !Array.isArray(entry.attachments)) continue;
        const slots: AttachmentSlot[] = [];
        for (const item of entry.attachments.slice(0, 32)) {
          if (!objectRecord(item) || typeof item.slot !== "number" || !Number.isSafeInteger(item.slot) || item.slot < 1) continue;
          const attachment = storedAttachment(item.attachment);
          if (attachment) slots.push({ slot: item.slot, attachment });
        }
        known.set(entry.messageId, slots);
      }
      const reuseMedia = message.reuseMedia === true;
      const completed = new Map<string, { baseline: string; slot: AttachmentSlot }>();
      for (const type of ["pointerdown", "keydown", "click"]) document.addEventListener(type, interrupt, true);
      void (async () => {
        const navigationName = typeof message.navigationName === "string" ? message.navigationName : expected.name;
        await openWhatsAppChat({ ...expected, name: navigationName, aliases, allowNameNavigation: message.navigationName !== null }, controller.signal);
        const mediaDeadline = Date.now() + 60_000;
        return collectWhatsApp({ expected, scope, limit, maxMs: 60_000, signal: controller.signal,
          onProgress: (count) => reply({ type: "progress", count }),
          captureMedia: async (row, observed, verify) => {
            if (skipIds.has(observed.id)) return observed.attachments;
            const result: AttachmentSlot[] = [];
            for (const entry of observed.attachments) {
              const retained = known.get(observed.id)?.find((item) => item.slot === entry.slot);
              const key = `${observed.id}\0${entry.slot}`;
              const cached = completed.get(key);
              if (cached && cached.baseline !== observed.sourceBaseline) throw new Error("An attachment changed during collection.");
              if (cached || (reuseMedia && retained)) { result.push(cached?.slot ?? retained ?? entry); continue; }
              if (entry.attachment.state === "unsupported" || transferred >= 32 * 1024 * 1024 || Date.now() >= mediaDeadline || controller.signal.aborted) { result.push(retained ?? entry); continue; }
              const original = await readMessageOriginal(observed.id, controller.signal);
              if (!original.ok) { result.push(retained ?? { slot: entry.slot, attachment: { state: "unavailable", limitation: original.reason } }); continue; }
              const captured = await captureOriginalAttachment(row, entry.slot, controller.signal, verify, original.value.digest);
              if (!captured.ok) { result.push(retained ?? { slot: entry.slot, attachment: { state: "unavailable", limitation: captured.reason } }); continue; }
              if (controller.signal.aborted || !(await verify())) throw new Error("Attachment source changed.");
              const checked = await readMessageOriginal(observed.id, controller.signal);
              if (!checked.ok || JSON.stringify(checked.value) !== JSON.stringify(original.value) ||
                  (original.value.size !== null && original.value.size !== captured.bytes.byteLength)) {
                result.push(retained ?? { slot: entry.slot, attachment: { state: "unavailable", limitation: "The original attachment evidence changed or its byte count did not match." } }); continue;
              }
              transferred += captured.bytes.byteLength;
              if (transferred > 32 * 1024 * 1024) { result.push(retained ?? { slot: entry.slot, attachment: { state: "unavailable", limitation: "Attachment pass exceeds 32 MiB." } }); continue; }
              const requestId = crypto.randomUUID();
              const attachment = await new Promise<Attachment | null>((finish) => {
                const timer = setTimeout(() => { pending.delete(requestId); finish(null); }, 15_000);
                pending.set(requestId, { finish, timer });
                reply({ type: "media", requestId, messageId: observed.id, slot: entry.slot, name: original.value.name ?? captured.name,
                  mediaType: original.value.mediaType ?? (captured.mediaType?.split(";", 1)[0]?.trim().toLowerCase() || null), base64: base64(captured.bytes) });
              });
              if (controller.signal.aborted) throw new Error("Attachment transfer stopped.");
              const slot: AttachmentSlot = attachment ? { slot: entry.slot, attachment } : retained ??
                { slot: entry.slot, attachment: { state: "unavailable", limitation: "Original bytes could not be durably staged." } };
              result.push(slot); completed.set(key, { baseline: observed.sourceBaseline, slot });
            }
            return result;
          },
        });
      })().then((value) => { if (!controller.signal.aborted) reply({ type: "result", value }); })
        .catch((error: unknown) => { if (!controller.signal.aborted) reply({ type: "error", reason: error instanceof Error ? error.message : "WhatsApp collection stopped." }); })
        .finally(() => { for (const type of ["pointerdown", "keydown", "click"]) document.removeEventListener(type, interrupt, true); rejectPending(); });
    });
  });
}

function replyDelay(): number {
  const delay = Number(new URLSearchParams(location.search).get("replyDelay"));
  if (!Number.isFinite(delay) || delay <= 0) return 0;
  return Math.min(delay, 5_000);
}

function report(): void {
  reportExchange("#content-ack", contentHello());
  reportExchange("#content-wrong-context", panelPing("content-as-panel"));
}

function reportSource(): void {
  const diagnostic = document.querySelector("#source-diagnostic");
  if (diagnostic) diagnostic.textContent = JSON.stringify(diagnose(document.documentElement.outerHTML));
  const params = new URLSearchParams(location.search);
  if (params.get("probe") === "1") {
    const probe = document.querySelector("#source-probe");
    if (probe) probe.textContent = JSON.stringify(readSource(document.documentElement.outerHTML));
  }
  if (params.get("download") !== "1") return;
  const alpha = document.querySelector("#alpha-result");
  if (!alpha) return;
  alpha.textContent = JSON.stringify(
    runTextDownload({
      html: document.documentElement.outerHTML,
      expected: { accountId: "acct-1", chatId: "chat-1" },
      prefix: "",
      binding: { accountId: "acct-1", chatId: "chat-1", destinationId: "root-1", generation: "g1" },
      chatKey: "c7a18d2f",
      displayName: "Fixture",
      desk: { markdown: null, metadata: null, mediaIds: [] },
      journal: null,
      chat: null,
    }),
  );
}

const delay = replyDelay();
if (location.hostname === "127.0.0.1" && delay === 0) {
  report();
  reportSource();
} else if (location.hostname === "127.0.0.1") {
  setTimeout(() => {
    report();
    reportSource();
  }, delay);
}
