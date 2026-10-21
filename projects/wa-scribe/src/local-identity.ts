export type LocalMessageKey = { id: string; chatId: string; outgoing: boolean; senderId: string | null };
export type LocalIdentityResult = { ok: true; keys: Map<string, LocalMessageKey> } | { ok: false; reason: string };

const DATABASE = "model-storage", MAX_KEYS = 100_000;
const MAX_KEY_LENGTH = 4_096, MAX_KEY_BYTES = 4 * 1_024 * 1_024, TIMEOUT_MS = 5_000;
const OPAQUE_ID = /^(?:[0-9a-f]{20}|[0-9a-f]{32})$/i;
const MESSAGE_KEY = /^(true|false)_([^_\s]+)_([^_\s]+)(?:_(\d+(?::\d+)?@(?:c\.us|lid|s\.whatsapp\.net)))?$/;
const CHAT_JID = /^\d+(?:-\d+)?(?::\d+)?@(?:c\.us|g\.us|lid|s\.whatsapp\.net)$/;
const failure = (reason: string): LocalIdentityResult => ({ ok: false, reason });

function validIds(rawIds: readonly string[]): boolean {
  return rawIds.length > 0 && rawIds.length <= 500 && new Set(rawIds).size === rawIds.length &&
    rawIds.every((id) => typeof id === "string" && OPAQUE_ID.test(id));
}

/** Resolve only after seeing the entire bounded keyspace; another chat can reuse an opaque ID. */
export function resolveMessageKeyList(rawIds: readonly string[], keys: readonly IDBValidKey[]): LocalIdentityResult {
  if (!validIds(rawIds)) return failure("The rendered message IDs are unsupported or repeated.");
  if (keys.length > MAX_KEYS) return failure("The local message keyspace exceeds the supported identity limit.");
  const requested = new Set(rawIds), matches = new Map<string, LocalMessageKey>(), encoder = new TextEncoder();
  let keyBytes = 0;
  for (const key of keys) {
    if (typeof key !== "string") return failure("The local message key format is unsupported.");
    if (key.length > MAX_KEY_LENGTH) return failure("A local message key exceeds the supported identity limit.");
    keyBytes += encoder.encode(key).byteLength;
    if (keyBytes > MAX_KEY_BYTES) return failure("The local message keys exceed the supported identity byte limit.");
    const match = MESSAGE_KEY.exec(key);
    if (!match?.[2] || !match[3]) {
      // Unknown formats cannot be interpreted, but a literal association must not hide a collision.
      if (rawIds.some((id) => key.includes(id))) return failure("A rendered message ID appears in an unsupported local message key.");
      continue;
    }
    const rawId = match[3];
    if (!requested.has(rawId)) continue;
    // Count before validating the remote JID: broadcasts and direction variants are ambiguous too.
    if (matches.has(rawId)) return failure("A rendered message ID matches multiple local message keys.");
    matches.set(rawId, { id: key, chatId: match[2], outgoing: match[1] === "true", senderId: match[4] ?? null });
  }
  if (matches.size !== rawIds.length) return failure("Some rendered messages have no supported local message key.");
  const chats = new Set([...matches.values()].map((key) => key.chatId));
  if (chats.size !== 1 || [...chats].some((id) => !CHAT_JID.test(id))) {
    return failure("The rendered messages do not identify one supported conversation.");
  }
  return { ok: true, keys: matches };
}

/** Inspect primary keys only, in one readonly transaction; never read message records. */
export async function resolveLocalMessageKeys(rawIds: readonly string[], signal?: AbortSignal): Promise<LocalIdentityResult> {
  if (!validIds(rawIds)) return failure("The rendered message IDs are unsupported or repeated.");
  if (signal?.aborted) return failure("Local message identity lookup was stopped.");
  const requested = [...rawIds], deadline = Date.now() + TIMEOUT_MS;
  return new Promise<LocalIdentityResult>((resolve) => {
    let settled = false, database: IDBDatabase | undefined, transaction: IDBTransaction | undefined;
    const finish = (result: LocalIdentityResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try { transaction?.abort(); } catch { /* The readonly transaction may already be complete. */ }
      database?.close();
      resolve(result.ok && Date.now() >= deadline ? failure("Local message identity lookup timed out.") : result);
    };
    const abort = () => finish(failure("Local message identity lookup was stopped."));
    const timer = setTimeout(() => finish(failure("Local message identity lookup timed out.")), TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    void (async () => {
      try {
        const existing = (await indexedDB.databases()).filter((info) => info.name === DATABASE);
        if (settled) return;
        if (existing.length !== 1) {
          finish(failure("The local message database is not ready. Wait for WhatsApp to finish loading and retry."));
          return;
        }
        const opening = indexedDB.open(DATABASE);
        opening.onupgradeneeded = () => {
          opening.transaction?.abort();
          finish(failure("The local message database changed; no upgrade was performed."));
        };
        opening.onblocked = () => finish(failure("The local message database is temporarily blocked."));
        opening.onerror = () => finish(failure("The local message database could not be opened."));
        opening.onsuccess = () => {
          const opened = opening.result;
          if (settled) { opened.close(); return; }
          database = opened;
          opened.onversionchange = () => finish(failure("The local message database changed during identity lookup."));
          try {
            if (!opened.objectStoreNames.contains("message")) {
              finish(failure("The local message database schema is unsupported."));
              return;
            }
            const reading = opened.transaction("message", "readonly");
            transaction = reading;
            reading.onabort = () => finish(failure("The local message key snapshot was interrupted."));
            reading.onerror = () => finish(failure("The local message keys could not be read."));
            const store = reading.objectStore("message");
            if (store.keyPath !== "id") {
              finish(failure("The local message database schema is unsupported."));
              return;
            }
            let count: number | undefined, keys: IDBValidKey[] | undefined;
            const counting = store.count(), listing = store.getAllKeys(undefined, MAX_KEYS + 1);
            counting.onsuccess = () => { count = counting.result; };
            listing.onsuccess = () => { keys = listing.result; };
            reading.oncomplete = () => {
              transaction = undefined;
              if (count === undefined || keys === undefined || count !== keys.length || count > MAX_KEYS) {
                finish(failure("The complete local message keyspace exceeds the supported identity limit."));
                return;
              }
              finish(resolveMessageKeyList(requested, keys));
            };
          } catch {
            finish(failure("The local message keys could not be read."));
          }
        };
      } catch {
        finish(failure("The existing local message database could not be inspected."));
      }
    })();
  });
}
