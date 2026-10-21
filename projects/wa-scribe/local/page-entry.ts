import { accountId, collectWhatsApp, inspectWhatsAppResolved, messageText } from "../src/whatsapp";
import { readLocalChatCatalog } from "../src/chat-catalog";
import { resolveLocalMessageKeys } from "../src/local-identity";
import { readMessageOriginal } from "../src/original-metadata";

async function row(messageId: string): Promise<{ ok: true; rawId: string; text: string } | { ok: false; reason: string }> {
  const main = document.querySelector<HTMLElement>("#main"), account = accountId();
  if (!main || !account) return { ok: false, reason: "The source conversation is unavailable." };
  const nodes = Array.from(main.querySelectorAll<HTMLElement>("[data-id]"))
    .filter((node) => !node.closest("[data-testid='quoted-message']"));
  const opaque = [...new Set(nodes.map((node) => node.getAttribute("data-id") ?? "")
    .filter((id) => /^(?:[0-9a-f]{20}|[0-9a-f]{32})$/i.test(id)))];
  const keys = opaque.length ? await resolveLocalMessageKeys(opaque) : null;
  if (keys && !keys.ok) return keys;
  if (accountId() !== account || document.querySelector("#main") !== main) return { ok: false, reason: "The source changed during attachment lookup." };
  const matched = nodes.filter((node) => {
    const raw = node.getAttribute("data-id") ?? "";
    return raw === messageId || (keys?.ok && keys.keys.get(raw)?.id === messageId);
  });
  const node = matched[0];
  if (matched.length !== 1 || !node?.isConnected) return { ok: false, reason: "The attachment's message is missing or ambiguous." };
  const deleted = Array.from(node.querySelectorAll("[data-icon='recalled'],[data-icon='recalled-out'],[data-testid='recalled']"))
    .some((marker) => !marker.closest("[data-testid='quoted-message']"));
  if (deleted) return { ok: false, reason: "WhatsApp reports this message deleted." };
  return { ok: true, rawId: node.getAttribute("data-id") ?? "", text: messageText(node) };
}

export type LocalPageApi = {
  account: typeof accountId;
  inspect: typeof inspectWhatsAppResolved;
  catalog: typeof readLocalChatCatalog;
  collect: typeof collectWhatsApp;
  original: typeof readMessageOriginal;
  row: typeof row;
};

declare global { interface Window { waScribeLocal: LocalPageApi } }

if (location.origin === "https://web.whatsapp.com") {
  window.waScribeLocal = { account: accountId, inspect: inspectWhatsAppResolved, catalog: readLocalChatCatalog,
    collect: collectWhatsApp, original: readMessageOriginal, row };
}
