const CHANNEL = "wa-scribe.media";
const LIMIT = 8 * 1024 * 1024;
type Download = { ok: true; name: string; blob: Blob } | { ok: false; reason: string };
export type CapturedOriginal = { ok: true; name: string; mediaType: string | null; bytes: Uint8Array } | { ok: false; reason: string };
let running = false;

function visible(node: HTMLElement): boolean {
  return node.isConnected && node.getClientRects().length > 0 && !node.closest("[hidden], [aria-hidden='true']");
}

function controls(root: Element, selector: string): HTMLElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(selector))
    .map((node) => node.closest<HTMLElement>("button, [role='button'], a[download]"))
    .filter((node): node is HTMLElement => node instanceof HTMLElement && root.contains(node) && visible(node) && !node.closest("[data-testid='quoted-message']"));
  return [...new Set(candidates)];
}

function downloadButtons(root: Element): HTMLElement[] {
  return controls(root, "[data-icon='download'], [data-testid='download'], [data-testid='download-button'], [aria-label='Download'], [title='Download'], a[download]");
}

function viewers(): HTMLElement[] {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='media-viewer'], [role='dialog']"))
    .filter((node) => visible(node) && !node.closest("#main, #pane-side"));
  return candidates.filter((node) => !candidates.some((parent) => parent !== node && parent.contains(node)));
}

function safeName(value: string): string | null {
  if (!value || value.includes("://") || value.length > 512) return null;
  const cleaned = value.replace(/[\\/:\u0000-\u001f\u007f]/g, "_").trim().slice(0, 180);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : null;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

async function captureCommand(button: HTMLElement, signal: AbortSignal | undefined, verify: () => Promise<boolean>, active: () => boolean, expectedDigest: string): Promise<Download> {
  // Verification may yield; do it before arming so unrelated delayed downloads have no capture window.
  if (!(await verify()) || !active() || !visible(button)) return { ok: false, reason: "The original download could not be safely started." };
  const nonce = crypto.randomUUID();
  let ready!: (value: boolean) => void, received!: (value: Download) => void;
  const readyPromise = new Promise<boolean>((resolve) => { ready = resolve; });
  const downloadPromise = new Promise<Download>((resolve) => { received = resolve; });
  const fail = () => { ready(false); received({ ok: false, reason: "WhatsApp did not deliver a supported original download." }); };
  const listener = (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (event.source !== window || event.origin !== location.origin || typeof value !== "object" || value === null ||
        !("channel" in value) || value.channel !== CHANNEL || !("nonce" in value) || value.nonce !== nonce || !("type" in value)) return;
    if (value.type === "armed") ready(true);
    else if (value.type === "failed") fail();
    else if (value.type === "captured" && "blob" in value && value.blob instanceof Blob && "name" in value && typeof value.name === "string") {
      const name = safeName(value.name);
      if (!name || value.blob.size > LIMIT) fail();
      else received({ ok: true, name, blob: value.blob });
    }
  };
  const timer = setTimeout(fail, 12_000);
  window.addEventListener("message", listener);
  signal?.addEventListener("abort", fail, { once: true });
  window.postMessage({ channel: CHANNEL, nonce, type: "arm", expectedDigest }, location.origin);
  try {
    if (!(await readyPromise) || !active() || !visible(button)) return { ok: false, reason: "The original download could not be safely started." };
    button.click();
    return await downloadPromise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", fail);
    window.removeEventListener("message", listener);
    window.postMessage({ channel: CHANNEL, nonce, type: "disarm" }, location.origin);
  }
}

/** Obtain bytes only through WhatsApp's ordinary Download command, never a rendered media URL. */
export async function captureOriginalAttachment(
  row: HTMLElement, slot: number, signal: AbortSignal | undefined, verify: () => Promise<boolean>, expectedDigest: string,
): Promise<CapturedOriginal> {
  if (!/^[a-f0-9]{64}$/i.test(expectedDigest)) return { ok: false, reason: "The original attachment digest is unavailable." };
  if (running) return { ok: false, reason: "Another original attachment download is in progress." };
  if (slot !== 1) return { ok: false, reason: "This attachment's individual download control could not be identified." };
  if (row.querySelector("[data-icon*='view-once'], [data-testid*='view-once']")) return { ok: false, reason: "View-once content was not opened." };
  running = true;
  let interrupted = false, opened: HTMLElement | null = null;
  const interaction = (event: Event) => { if (event.isTrusted) interrupted = true; };
  for (const type of ["pointerdown", "click", "keydown"]) document.addEventListener(type, interaction, true);
  const active = () => !interrupted && !signal?.aborted && row.isConnected;
  const current = async () => {
    if (!active()) return false;
    try {
      const valid = await verify();
      return valid && active();
    } catch { return false; }
  };
  try {
    if (!(await current()) || viewers().length) return { ok: false, reason: "The selected attachment is no longer safely available." };
    const media = Array.from(row.querySelectorAll<HTMLElement>("img:not(.emoji), video, audio, [data-testid='document-thumb']"))
      .filter((node) => !node.closest("[data-testid='quoted-message'], [data-testid='avatar']"));
    const outer = media.filter((node) => !media.some((parent) => parent !== node && parent.contains(node)));
    if (outer.length > 1) return { ok: false, reason: "Individual original files could not be identified in this media group." };
    let buttons = downloadButtons(row);
    if (buttons.length === 0) {
      const documentTile = row.querySelector<HTMLElement>("[data-testid='document-thumb']");
      if (documentTile) {
        const target = documentTile.closest<HTMLElement>("button, [role='button']") ?? documentTile;
        if (!row.contains(target) || !(await current())) return { ok: false, reason: "The document download control changed." };
        buttons = [target];
      } else {
        const image = outer[0];
        if (!(image instanceof HTMLImageElement) || !(await current())) return { ok: false, reason: "No supported original download control was found." };
        image.click();
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline && !signal?.aborted && !interrupted) {
          const candidates = viewers();
          if (candidates.length === 1 && candidates[0]) { opened = candidates[0]; break; }
          if (candidates.length > 1) break;
          await wait(100, signal);
        }
        if (!opened || !(await current())) return { ok: false, reason: "WhatsApp's original media viewer could not be identified." };
        buttons = downloadButtons(opened);
      }
    }
    const button = buttons[0];
    if (buttons.length !== 1 || !button || !(await current())) return { ok: false, reason: "The original download control is unavailable or ambiguous." };
    const result = await captureCommand(button, signal, current, active, expectedDigest.toLowerCase());
    if (!result.ok) return result;
    if (!(await current()) || result.blob.size > LIMIT) return { ok: false, reason: "The source changed during original attachment download." };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    if (digest !== expectedDigest.toLowerCase()) return { ok: false, reason: "The delivered download did not match this attachment's original digest." };
    if (!(await current())) return { ok: false, reason: "The source changed before attachment bytes were accepted." };
    return { ok: true, name: result.name, mediaType: result.blob.type || null, bytes };
  } finally {
    try {
      if (opened && visible(opened) && await current()) {
        const close = controls(opened, "[data-icon='x-viewer'], [data-icon='x'], [aria-label='Close']");
        if (close.length === 1 && close[0]) close[0].click();
        else opened.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      }
    } finally {
      for (const type of ["pointerdown", "click", "keydown"]) document.removeEventListener(type, interaction, true);
      running = false;
    }
  }
}
