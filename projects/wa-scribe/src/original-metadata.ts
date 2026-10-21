export type OriginalMetadata = { digest: string; size: number | null; mediaType: string | null; name: string | null };
type OriginalResult = { ok: true; value: OriginalMetadata } | { ok: false; reason: string };

const DATABASE = "model-storage", TIMEOUT_MS = 3_000, MAX_FILE = 8 * 1024 * 1024;
const MESSAGE_KEY = /^(?:true|false)_\d+(?:-\d+)?(?::\d+)?@(?:c\.us|g\.us|lid|s\.whatsapp\.net)_[^_\s]+(?:_\d+(?::\d+)?@(?:c\.us|lid|s\.whatsapp\.net))?$/;
const failure = (reason: string): OriginalResult => ({ ok: false, reason });

function supportedKey(value: string): boolean { return value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value) && MESSAGE_KEY.test(value); }

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function plaintextDigest(value: unknown): string | null {
  let bytes: Uint8Array;
  if (typeof value === "string") {
    if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
    const decoded = atob(value);
    if (decoded.length !== 32 || btoa(decoded) !== value) return null;
    bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } else if (value instanceof Uint8Array && value.byteLength === 32) bytes = value;
  else return null;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Project only selected identity and plaintext media evidence; message contents stay opaque. */
export function projectOriginalMetadata(messageId: string, value: unknown): OriginalMetadata | null {
  if (!supportedKey(messageId) || !record(value) || !Object.hasOwn(value, "id") || value.id !== messageId || !Object.hasOwn(value, "filehash")) return null;
  const digest = plaintextDigest(value.filehash);
  if (!digest) return null;
  let size: number | null = null, mediaType: string | null = null, name: string | null = null;
  if (value.size !== undefined && value.size !== null) {
    if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_FILE) return null;
    size = value.size;
  }
  if (value.mimetype !== undefined && value.mimetype !== null) {
    if (typeof value.mimetype !== "string" || value.mimetype.length > 256 || /[\x00-\x1f\x7f]/u.test(value.mimetype)) return null;
    mediaType = value.mimetype.split(";", 1)[0]?.trim().toLowerCase() ?? null;
    if (!mediaType || mediaType.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) return null;
  }
  if (value.filename !== undefined && value.filename !== null) {
    if (typeof value.filename !== "string" || !value.filename.trim() || value.filename.length > 256 || /[\x00-\x1f\x7f/\\:]/u.test(value.filename)) return null;
    name = value.filename;
  }
  return { digest, size, mediaType, name };
}

/** One exact primary-key lookup, never a scan or access to private endpoints. */
export async function readMessageOriginal(messageId: string, signal?: AbortSignal): Promise<OriginalResult> {
  if (!supportedKey(messageId)) return failure("The attachment message identity is unsupported.");
  if (signal?.aborted) return failure("Original attachment metadata lookup was stopped.");
  const deadline = Date.now() + TIMEOUT_MS;
  return new Promise<OriginalResult>((resolve) => {
    let settled = false, database: IDBDatabase | undefined, transaction: IDBTransaction | undefined;
    const finish = (result: OriginalResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      try { transaction?.abort(); } catch { /* A completed readonly transaction cannot be aborted. */ }
      database?.close();
      resolve(result.ok && Date.now() >= deadline ? failure("Original attachment metadata lookup timed out.") : result);
    };
    const abort = () => finish(failure("Original attachment metadata lookup was stopped."));
    const timer = setTimeout(() => finish(failure("Original attachment metadata lookup timed out.")), TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    void (async () => {
      try {
        const existing = (await indexedDB.databases()).filter((info) => info.name === DATABASE);
        if (settled) return;
        if (existing.length !== 1) { finish(failure("The local message database is not ready. Wait for WhatsApp to finish loading and retry.")); return; }
        const opening = indexedDB.open(DATABASE);
        opening.onupgradeneeded = () => { opening.transaction?.abort(); finish(failure("The local message database changed; no upgrade was performed.")); };
        opening.onblocked = () => finish(failure("The local message database is temporarily blocked."));
        opening.onerror = () => finish(failure("The local message database could not be opened."));
        opening.onsuccess = () => {
          const opened = opening.result;
          if (settled) { opened.close(); return; }
          database = opened;
          opened.onversionchange = () => finish(failure("The local message database changed during attachment lookup."));
          try {
            if (!opened.objectStoreNames.contains("message")) { finish(failure("The local message database schema is unsupported.")); return; }
            const reading = opened.transaction("message", "readonly");
            transaction = reading;
            reading.onabort = () => finish(failure("Original attachment metadata lookup was interrupted."));
            reading.onerror = () => finish(failure("Original attachment metadata could not be read."));
            const store = reading.objectStore("message");
            if (store.keyPath !== "id") { finish(failure("The local message database schema is unsupported.")); return; }
            let result: OriginalMetadata | null = null;
            const request = store.get(messageId);
            request.onsuccess = () => { result = projectOriginalMetadata(messageId, request.result); };
            reading.oncomplete = () => {
              transaction = undefined;
              finish(result ? { ok: true, value: result } : failure("This message has no supported original attachment hash."));
            };
          } catch { finish(failure("Original attachment metadata could not be read.")); }
        };
      } catch { finish(failure("The existing local message database could not be inspected.")); }
    })();
  });
}
