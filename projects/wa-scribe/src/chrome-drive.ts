import { bakedOAuth } from "./public-config";
import {
  DRIVE_PROTOCOL,
  dispatchDrive,
  unresolvedKey,
  driveId,
  type DriveAccount,
  type DriveRequest,
  type DriveResult,
  type HttpRequest,
  type HttpResult,
  type ProbeRecord,
  type ProbeStorage,
  type TokenResult,
  classifyIdentityError,
} from "./drive";

const STORAGE_KEY = "waScribeProbe";
const REQUEST_TIMEOUT_MS = 8_000;
const JSON_RESPONSE_BYTES = 1024 * 1024;
const MEDIA_RESPONSE_BYTES = 40 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readProbeRecord(value: unknown): ProbeRecord | null {
  if (!isRecord(value) || !driveId(value.accountId)) return null;
  if (value.rootId !== null && !driveId(value.rootId)) return null;
  if (typeof value.pendingMutation !== "boolean" || !Array.isArray(value.files)) return null;
  if (value.pendingRevision !== undefined && (typeof value.pendingRevision !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.pendingRevision))) return null;
  if (value.pendingAccountId !== undefined && !driveId(value.pendingAccountId)) return null;
  if (value.files.length > 3 || (value.rootId === null && value.files.length > 0)) return null;
  const files: ProbeRecord["files"] = [];
  for (const entry of value.files) {
    if (!isRecord(entry) || !driveId(entry.id) || (entry.name !== "note.md" && entry.name !== "meta.json" && entry.name !== "dot.bin")) return null;
    if (files.some((file) => file.id === entry.id || file.name === entry.name)) return null;
    files.push({ id: entry.id, name: entry.name });
  }
  return {
    accountId: value.accountId, rootId: value.rootId, files, pendingMutation: value.pendingMutation,
    ...(typeof value.pendingRevision === "string" ? { pendingRevision: value.pendingRevision } : {}),
    ...(typeof value.pendingAccountId === "string" ? { pendingAccountId: value.pendingAccountId } : {}),
  };
}

function storage(): ProbeStorage {
  return {
    async get() {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      if (stored[STORAGE_KEY] === undefined) return null;
      const record = readProbeRecord(stored[STORAGE_KEY]);
      if (!record) throw new Error("Saved Drive test state is invalid.");
      return record;
    },
    async set(record) {
      await chrome.storage.local.set({ [STORAGE_KEY]: record });
    },
  };
}

export function identityToken(interactive: boolean): Promise<TokenResult> {
  const identity = chrome.identity;
  if (!identity?.getAuthToken) return Promise.resolve({ ok: false, reason: "missing-setup" });
  return new Promise((resolve) => {
    identity.getAuthToken({ interactive }, (token) => {
      const message = chrome.runtime.lastError?.message ?? "";
      if (message.length > 0) {
        resolve({ ok: false, reason: classifyIdentityError(message, interactive) });
        return;
      }
      if (typeof token !== "string" || token.length === 0) {
        resolve({ ok: false, reason: interactive ? "no-identity" : "signed-out" });
        return;
      }
      resolve({ ok: true, token });
    });
  });
}

export async function removeToken(token: string): Promise<void> {
  const identity = chrome.identity;
  if (!identity?.removeCachedAuthToken) return;
  await new Promise<void>((resolve) => {
    identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function responseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel();
    throw new Error("Drive response exceeds its byte budget.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Drive response exceeds its byte budget.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function chromeHttp(request: HttpRequest): Promise<HttpResult> {
  if (!request.url.startsWith("https://www.googleapis.com/")) throw new Error("Drive request origin is not allowed.");
  const controller = new AbortController();
  const timeout = Math.min(Math.max(request.timeoutMs ?? REQUEST_TIMEOUT_MS, 1), 30_000);
  const limit = Math.min(Math.max(request.maxResponseBytes ?? (request.url.includes("alt=media") ? MEDIA_RESPONSE_BYTES : JSON_RESPONSE_BYTES), 1), MEDIA_RESPONSE_BYTES);
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${request.token}`);
    if (request.contentType) headers.set("Content-Type", request.contentType);
    const init: RequestInit = { method: request.method, headers, signal: controller.signal, credentials: "omit", redirect: "error" };
    if (request.body) {
      const copy = new Uint8Array(request.body.byteLength);
      copy.set(request.body);
      init.body = copy;
    }
    const response = await fetch(request.url, init);
    return { kind: "response", status: response.status, bytes: await responseBytes(response, limit) };
  } catch {
    if (request.method === "GET") return { kind: "response", status: 0, bytes: new Uint8Array() };
    return { kind: "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

const lock = { held: false };
let session: DriveAccount | null = null;

function remember(result: DriveResult): DriveResult {
  if (result.account) session = result.account;
  if (result.phase === "signed-out" || result.phase === "denied" || result.phase === "missing-setup" || result.phase === "no-identity" || result.phase === "auth-expired") {
    session = result.account;
  }
  return result;
}

function notify(result: DriveResult): void {
  chrome.runtime.sendMessage({ protocol: DRIVE_PROTOCOL, type: "drive-status", result }, () => {
    void chrome.runtime.lastError;
  });
}

export async function handleDrive(message: DriveRequest): Promise<DriveResult> {
  const config = bakedOAuth();
  const deps = { config, http: chromeHttp, token: { get: identityToken, remove: removeToken }, storage: storage() };
  let outcome: DriveResult;
  try {
    outcome = await dispatchDrive({ ...deps, message, session, lock });
  } catch {
    try {
      const stored = await storage().get();
      outcome = stored?.pendingMutation
        ? { phase: "unknown-mutation", account: session, warning: "previous-unknown", httpStatus: null, pendingId: unresolvedKey(stored) }
        : { phase: "http-error", account: session, warning: null, httpStatus: null, pendingId: null };
    } catch {
      outcome = { phase: "mismatch", account: session, warning: null, httpStatus: null, pendingId: null };
    }
  }
  remember(outcome);
  if (message.type === "probe" && outcome.phase !== "busy") notify(outcome);
  return outcome;
}
