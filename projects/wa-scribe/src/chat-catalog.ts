export type CatalogChat = { chatId: string; name: string; aliases: string[] };
export type CatalogResult =
  | { ok: true; chats: CatalogChat[]; scope: "local-cache" }
  | { ok: false; reason: string };

const DATABASE = "model-storage", CHAT_STORE = "chat", CONTACT_STORE = "contact";
const MAX_CHATS = 5_000, MAX_LABEL = 256, MAX_OUTPUT_BYTES = 1_024 * 1_024, TIMEOUT_MS = 5_000;
const CHAT_JID = /^\d+(?:-\d+)?(?::\d+)?@(?:c\.us|g\.us|lid|s\.whatsapp\.net)$/;
const failure = (reason: string): CatalogResult => ({ ok: false, reason });

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownString(record: Record<string, unknown>, field: string): string | null {
  if (!Object.hasOwn(record, field)) return null;
  const value = record[field];
  if (typeof value !== "string" || value.length > MAX_LABEL || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  const label = value.trim();
  return label.length > 0 && label.length <= MAX_LABEL ? label : null;
}

/** Read only identity and approved display labels; all other cloned record fields stay opaque. */
export function projectChatMetadata(primaryKey: unknown, value: unknown, contact?: unknown): CatalogChat | null {
  if (typeof primaryKey !== "string" || primaryKey.length > MAX_LABEL || !CHAT_JID.test(primaryKey)) return null;
  if (!objectRecord(value) || value.id !== primaryKey) return null;

  const labels: string[] = [];
  for (const field of ["formattedTitle", "name"] as const) {
    const label = ownString(value, field);
    if (label !== null && !labels.includes(label)) labels.push(label);
  }
  if (objectRecord(contact) && contact.id === primaryKey) {
    for (const field of ["name", "shortName", "pushname"] as const) {
      const label = ownString(contact, field);
      if (label !== null && !labels.includes(label)) labels.push(label);
    }
  }

  const name = labels[0] ?? primaryKey;
  const aliases = labels.filter((label) => label !== name).slice(0, 6);
  return { chatId: primaryKey, name, aliases };
}

/** Enumerate the bounded local chat cache. This does not describe all chats on the account. */
export async function readLocalChatCatalog(signal?: AbortSignal): Promise<CatalogResult> {
  if (signal?.aborted) return failure("Local chat catalog lookup was stopped.");
  const deadline = Date.now() + TIMEOUT_MS;
  return new Promise<CatalogResult>((resolve) => {
    let settled = false;
    let database: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    const finish = (result: CatalogResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try { transaction?.abort(); } catch { /* The readonly transaction may already be complete. */ }
      database?.close();
      resolve(result.ok && Date.now() >= deadline ? failure("Local chat catalog lookup timed out.") : result);
    };
    const abort = () => finish(failure("Local chat catalog lookup was stopped."));
    const timer = setTimeout(() => finish(failure("Local chat catalog lookup timed out.")), TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }

    void (async () => {
      try {
        const existing = (await indexedDB.databases()).filter((info) => info.name === DATABASE);
        if (settled) return;
        if (existing.length !== 1) {
          finish(failure("The local chat database is not ready. Wait for WhatsApp to finish loading, then Refresh chats."));
          return;
        }
        const opening = indexedDB.open(DATABASE);
        opening.onupgradeneeded = () => {
          opening.transaction?.abort();
          finish(failure("The local chat database changed; no upgrade was performed."));
        };
        opening.onblocked = () => finish(failure("The local chat database is temporarily blocked."));
        opening.onerror = () => finish(failure("The local chat database could not be opened."));
        opening.onsuccess = () => {
          const opened = opening.result;
          if (settled) { opened.close(); return; }
          database = opened;
          opened.onversionchange = () => finish(failure("The local chat database changed during catalog lookup."));
          try {
            if (!opened.objectStoreNames.contains(CHAT_STORE)) {
              finish(failure("The local chat database schema is unsupported."));
              return;
            }
            const hasContacts = opened.objectStoreNames.contains(CONTACT_STORE);
            const reading = opened.transaction(hasContacts ? [CHAT_STORE, CONTACT_STORE] : [CHAT_STORE], "readonly");
            transaction = reading;
            reading.onabort = () => finish(failure("The local chat catalog snapshot was interrupted."));
            reading.onerror = () => finish(failure("The local chat catalog could not be read."));
            const chats = reading.objectStore(CHAT_STORE);
            if (chats.keyPath !== "id") {
              finish(failure("The local chat database schema is unsupported."));
              return;
            }
            const contacts = hasContacts ? reading.objectStore(CONTACT_STORE) : undefined;
            const contactStore = contacts?.keyPath === "id" ? contacts : undefined;
            let count: number | undefined;
            let visited = 0;
            let failed: string | null = null;
            const output: CatalogChat[] = [];
            let outputBytes = 2;
            const append = (chat: CatalogChat) => {
              const encoded = new TextEncoder().encode(JSON.stringify(chat)).byteLength;
              const nextSize = outputBytes + encoded + (output.length === 0 ? 0 : 1);
              if (nextSize > MAX_OUTPUT_BYTES) {
                failed = "The local chat catalog exceeds the supported output size.";
                return;
              }
              output.push(chat);
              outputBytes = nextSize;
            };
            const counting = chats.count();
            counting.onsuccess = () => {
              count = counting.result;
              if (count > MAX_CHATS) failed = "The local chat catalog exceeds the supported entry limit.";
            };
            const cursorRequest = chats.openCursor();
            cursorRequest.onerror = () => { failed = "The local chat catalog could not be read."; };
            cursorRequest.onsuccess = () => {
              if (settled || failed !== null) return;
              const cursor = cursorRequest.result;
              if (cursor === null) return;
              visited += 1;
              if (visited > MAX_CHATS) {
                failed = "The local chat catalog exceeds the supported entry limit.";
                return;
              }
              const key = cursor.primaryKey;
              const value: unknown = cursor.value;
              const projected = projectChatMetadata(key, value);
              if (projected !== null) {
                if (contactStore !== undefined) {
                  const request = contactStore.get(projected.chatId);
                  request.onerror = () => { failed = "The local contact labels could not be read."; };
                  request.onsuccess = () => {
                    if (settled || failed !== null) return;
                    const contact: unknown = request.result;
                    const withContact = projectChatMetadata(key, value, contact);
                    if (withContact !== null) append(withContact);
                  };
                } else {
                  append(projected);
                }
              }
              try { cursor.continue(); }
              catch { failed = "The local chat catalog could not be read."; }
            };
            reading.oncomplete = () => {
              transaction = undefined;
              if (failed !== null) { finish(failure(failed)); return; }
              if (count === undefined || count !== visited || count > MAX_CHATS) {
                finish(failure("The complete local chat catalog exceeds the supported entry limit."));
                return;
              }
              finish({ ok: true, chats: output, scope: "local-cache" });
            };
          } catch {
            finish(failure("The local chat catalog could not be read."));
          }
        };
      } catch {
        finish(failure("The existing local chat database could not be inspected."));
      }
    })();
  });
}
