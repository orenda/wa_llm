import { contentHello, panelPing } from "./protocol";
import { reportExchange } from "./report";
import { runTextDownload } from "./alpha";
import { diagnose, readSource } from "./source";
import { collectWhatsApp, inspectWhatsAppResolved } from "./whatsapp";

if (location.origin === "https://web.whatsapp.com") {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || typeof message !== "object" || message === null ||
        !("protocol" in message) || message.protocol !== "wa-scribe.app" || !("type" in message) || message.type !== "inspect") return undefined;
    void inspectWhatsAppResolved().then(sendResponse).catch(() => sendResponse({ ok: false, reason: "WhatsApp identity lookup failed. Reload WhatsApp Web and try again." }));
    return true;
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "wa-scribe.app" || port.sender?.id !== chrome.runtime.id) return;
    const controller = new AbortController();
    let started = false;
    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener((message: unknown) => {
      if (started || typeof message !== "object" || message === null || !("type" in message) || message.type !== "collect" ||
          !("expected" in message) || typeof message.expected !== "object" || message.expected === null ||
          !("accountId" in message.expected) || typeof message.expected.accountId !== "string" ||
          !("chatId" in message.expected) || typeof message.expected.chatId !== "string" ||
          !("name" in message.expected) || typeof message.expected.name !== "string" ||
          !("scope" in message) || (message.scope !== "visible" && message.scope !== "loaded") ||
          !("limit" in message) || typeof message.limit !== "number") return;
      started = true;
      const reply = (value: unknown) => { if (!controller.signal.aborted) port.postMessage(value); };
      void collectWhatsApp({ expected: { accountId: message.expected.accountId, chatId: message.expected.chatId, name: message.expected.name },
        scope: message.scope, limit: message.limit, maxMs: 60_000, signal: controller.signal,
        onProgress: (count) => reply({ type: "progress", count }) })
        .then((value) => reply({ type: "result", value }))
        .catch(() => reply({ type: "error", reason: "WhatsApp collection stopped because its account, chat, connection or page structure changed." }));
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
