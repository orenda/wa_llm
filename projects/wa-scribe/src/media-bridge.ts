const CHANNEL = "wa-scribe.media";
const LIMIT = 8 * 1024 * 1024;
type Ticket = { nonce: string; expectedDigest: string; controller: AbortController; timer: number; taken: boolean; restore: (() => void) | null };
let armed: Ticket | null = null;

function finish(ticket: Ticket, result: { type: "captured"; name: string; blob: Blob } | { type: "failed" }): void {
  if (armed !== ticket) return;
  armed = null;
  clearTimeout(ticket.timer);
  ticket.controller.abort();
  const restore = ticket.restore;
  ticket.restore = null;
  try {
    if (result.type === "failed") restore?.();
  } finally { window.postMessage({ channel: CHANNEL, nonce: ticket.nonce, ...result }, location.origin); }
}

function disarm(): void {
  if (armed) finish(armed, { type: "failed" });
}

async function downloadedBlob(ticket: Ticket, url: string, name: string, nativeClick: () => void): Promise<void> {
  const restore = (href: string) => {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = name;
    nativeClick.call(anchor);
  };
  ticket.restore = () => restore(url);
  try {
    const response = await fetch(url, { signal: ticket.controller.signal });
    const rawLength = response.headers.get("content-length");
    const length = rawLength === null ? null : Number(rawLength);
    if (!response.ok || (length !== null && (!Number.isSafeInteger(length) || length < 0 || length > LIMIT))) throw new Error("Unsupported download");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing download body");
    const chunks: ArrayBuffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > LIMIT) { await reader.cancel(); throw new Error("Download limit"); }
        chunks.push(new Uint8Array(item.value).buffer);
      }
    } finally { reader.releaseLock(); }
    if (length !== null && length !== size) throw new Error("Incomplete download");
    const blob = new Blob(chunks, { type: response.headers.get("content-type") ?? "" });
    // A blob URL may already have been revoked by WhatsApp; retain a fresh native fallback.
    ticket.restore = () => {
      const href = URL.createObjectURL(blob);
      restore(href);
      window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
    };
    const bytes = await blob.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    if (digest !== ticket.expectedDigest) { finish(ticket, { type: "failed" }); return; }
    finish(ticket, { type: "captured", name, blob });
  } catch { finish(ticket, { type: "failed" }); }
}

if (location.origin === "https://web.whatsapp.com") {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (event.source !== window || event.origin !== location.origin || typeof value !== "object" || value === null ||
        !("channel" in value) || value.channel !== CHANNEL || !("nonce" in value) || typeof value.nonce !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(value.nonce) || !("type" in value)) return;
    if (value.type === "disarm") {
      if (armed?.nonce === value.nonce) disarm();
    } else if (value.type === "arm" && armed === null && "expectedDigest" in value && typeof value.expectedDigest === "string" && /^[a-f0-9]{64}$/i.test(value.expectedDigest)) {
      const ticket: Ticket = { nonce: value.nonce, expectedDigest: value.expectedDigest.toLowerCase(), controller: new AbortController(), timer: 0, taken: false, restore: null };
      ticket.timer = window.setTimeout(() => finish(ticket, { type: "failed" }), 12_000);
      armed = ticket;
      window.postMessage({ channel: CHANNEL, nonce: value.nonce, type: "armed" }, location.origin);
    }
  });
  for (const type of ["pointerdown", "click", "keydown"]) document.addEventListener(type, (event) => { if (event.isTrusted) disarm(); }, true);
  window.addEventListener("pagehide", disarm);

  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
    const ticket = armed;
    // The normal Download command creates this anchor; displayed image/video URLs are never fetched.
    if (ticket && !ticket.taken && this.href.startsWith("blob:https://web.whatsapp.com/") && this.download.trim() !== "") {
      ticket.taken = true;
      void downloadedBlob(ticket, this.href, this.download, nativeClick);
      return;
    }
    nativeClick.call(this);
  };
}

export {};
