export type StagedMedia = { key: string; relativePath: string; name: string; mediaType: string | null; size: number };
type StoredBlob = { key: string; bytes: Blob; size: number };
const MAX_FILE = 8 * 1024 * 1024, MAX_CACHE = 64 * 1024 * 1024, MAX_RECORDS = 4096;
const KEY = /^[0-9a-f]{64}$/;

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeMediaBase64(text: string): Uint8Array {
  const padding = text.indexOf("="), tail = padding < 0 ? "" : text.slice(padding);
  if (text.length > Math.ceil(MAX_FILE / 3) * 4 || text.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(text) ||
      (padding >= 0 && tail !== "=" && tail !== "==")) {
    throw new Error("Attachment bytes have invalid base64 encoding or exceed 8 MiB.");
  }
  const raw = atob(text);
  if (raw.length > MAX_FILE || btoa(raw) !== text) throw new Error("Attachment bytes have invalid padding or exceed 8 MiB.");
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function mediaDescriptor(key: string, name: string, mediaType: string | null, size: number): StagedMedia {
  if (!KEY.test(key) || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE || typeof name !== "string") throw new Error("Invalid staged attachment.");
  const cleanName = name.replace(/[\x00-\x1f\x7f/\\:]/g, "_").trim().slice(0, 256) || "attachment";
  const type = mediaType === null || mediaType === "" ? null : mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? null;
  if (type !== null && (type.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type))) throw new Error("Invalid attachment media type.");
  const extensions: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "audio/ogg": "ogg", "video/mp4": "mp4" };
  const extension = (type ? extensions[type] : undefined) ?? /\.([a-z0-9]{1,10})$/i.exec(cleanName)?.[1]?.toLowerCase() ?? "bin";
  return { key, relativePath: `${key}.${extension}`, name: cleanName, mediaType: type, size };
}

function storedBlob(value: unknown): value is StoredBlob {
  return typeof value === "object" && value !== null && "key" in value && typeof value.key === "string" && KEY.test(value.key) &&
    "bytes" in value && value.bytes instanceof Blob && "size" in value && typeof value.size === "number" &&
    Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= MAX_FILE && value.bytes.size === value.size;
}

function transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, accept: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let database: IDBDatabase | undefined, tx: IDBTransaction | undefined, result: { value: T } | undefined, settled = false;
    const close = () => { clearTimeout(timer); database?.close(); };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      try { tx?.abort(); } catch { /* Completed transactions cannot be aborted. */ }
      close();
      reject(error instanceof Error ? error : new Error("Attachment staging failed."));
    };
    const timer = setTimeout(() => fail(new Error("Attachment staging timed out.")), 5000);
    try {
      const opening = indexedDB.open("wa-scribe-media", 1);
      opening.onupgradeneeded = () => { opening.result.createObjectStore("blobs", { keyPath: "key" }); };
      opening.onblocked = () => fail(new Error("Attachment staging is blocked by another extension page."));
      opening.onerror = () => fail(opening.error);
      opening.onsuccess = () => {
        const opened = opening.result;
        if (settled) { opened.close(); return; }
        database = opened;
        opened.onversionchange = () => fail(new Error("Attachment storage changed during staging."));
        try {
          tx = opened.transaction("blobs", mode);
          tx.onabort = () => fail(tx?.error ?? new Error("Attachment staging was interrupted."));
          tx.onerror = () => fail(tx?.error);
          tx.oncomplete = () => {
            if (settled) return;
            if (!result) { fail(new Error("Attachment staging did not finish.")); return; }
            settled = true; close(); resolve(result.value);
          };
          const store = tx.objectStore("blobs");
          if (store.keyPath !== "key") throw new Error("Attachment storage has an unsupported schema.");
          work(store, (value) => { result = { value }; }, fail);
        } catch (error) { fail(error); }
      };
    } catch (error) { fail(error); }
  });
}

export async function stageMedia(bytes: Uint8Array, name: string, mediaType: string | null): Promise<StagedMedia> {
  if (bytes.byteLength > MAX_FILE) throw new Error("Attachment exceeds 8 MiB.");
  const owned = new Uint8Array(bytes), key = await sha256Bytes(owned);
  const descriptor = mediaDescriptor(key, name, mediaType, owned.byteLength), blob = new Blob([owned]);
  return transaction<StagedMedia>("readwrite", (store, accept, fail) => {
    let count = -1, seen = 0, total = 0, exists = false;
    const counting = store.count();
    counting.onsuccess = () => { count = counting.result; };
    const listing = store.openCursor();
    listing.onsuccess = () => {
      try {
        const cursor = listing.result;
        if (!cursor) {
          if (count !== seen || count > MAX_RECORDS || (!exists && count === MAX_RECORDS) || total + (exists ? 0 : blob.size) > MAX_CACHE) throw new Error("Attachment staging exceeds its 64 MiB cache limit.");
          store.put({ key, bytes: blob, size: blob.size }); accept(descriptor); return;
        }
        const value: unknown = cursor.value;
        if (!storedBlob(value) || cursor.primaryKey !== value.key || ++seen > MAX_RECORDS) throw new Error("Attachment cache is invalid or exceeds its limit.");
        total += value.size;
        if (value.key === key) { exists = true; if (value.size !== blob.size) throw new Error("Staged attachment identity changed."); }
        if (total > MAX_CACHE) throw new Error("Attachment cache exceeds 64 MiB.");
        cursor.continue();
      } catch (error) { fail(error); }
    };
  });
}

export async function readStagedMedia(key: string): Promise<Uint8Array> {
  if (!KEY.test(key)) throw new Error("Invalid staged attachment key.");
  const blob = await transaction<Blob>("readonly", (store, accept, fail) => {
    const reading = store.get(key);
    reading.onsuccess = () => {
      const value: unknown = reading.result;
      if (!storedBlob(value) || value.key !== key) { fail(new Error("Staged attachment bytes are unavailable.")); return; }
      accept(value.bytes);
    };
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (await sha256Bytes(bytes) !== key) throw new Error("Staged attachment bytes failed their integrity check.");
  return bytes;
}

export async function pruneStagedMedia(keep: ReadonlySet<string>): Promise<void> {
  if ([...keep].some((key) => !KEY.test(key))) throw new Error("Invalid pending attachment references.");
  return transaction<void>("readwrite", (store, accept, fail) => {
    let seen = 0;
    const listing = store.openKeyCursor();
    listing.onsuccess = () => {
      try {
        const cursor = listing.result;
        if (!cursor) { accept(); return; }
        if (typeof cursor.primaryKey !== "string" || !KEY.test(cursor.primaryKey) || ++seen > MAX_RECORDS) throw new Error("Attachment cache keys are invalid or exceed their limit.");
        if (!keep.has(cursor.primaryKey)) store.delete(cursor.primaryKey);
        cursor.continue();
      } catch (error) { fail(error); }
    };
  });
}
