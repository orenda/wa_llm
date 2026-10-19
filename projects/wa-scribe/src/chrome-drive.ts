import { bakedOAuth } from "./public-config";
import {
  connectDrive,
  runProbe,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readProbeRecord(value: unknown): ProbeRecord | null {
  if (!isRecord(value) || typeof value.accountId !== "string" || value.accountId.length === 0) return null;
  if (value.rootId !== null && typeof value.rootId !== "string") return null;
  if (typeof value.pendingMutation !== "boolean" || !Array.isArray(value.files)) return null;
  const files: ProbeRecord["files"] = [];
  for (const entry of value.files) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") return null;
    files.push({ id: entry.id, name: entry.name });
  }
  return { accountId: value.accountId, rootId: value.rootId, files, pendingMutation: value.pendingMutation };
}

function storage(): ProbeStorage {
  return {
    async get() {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      return readProbeRecord(stored[STORAGE_KEY]);
    },
    async set(record) {
      await chrome.storage.local.set({ [STORAGE_KEY]: record });
    },
  };
}

function identityToken(interactive: boolean): Promise<TokenResult> {
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

async function removeToken(token: string): Promise<void> {
  const identity = chrome.identity;
  if (!identity?.removeCachedAuthToken) return;
  await new Promise<void>((resolve) => {
    identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function chromeHttp(request: HttpRequest): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${request.token}`);
    if (request.contentType) headers.set("Content-Type", request.contentType);
    const init: RequestInit = { method: request.method, headers, signal: controller.signal };
    if (request.body) {
      const copy = new Uint8Array(request.body.byteLength);
      copy.set(request.body);
      init.body = copy;
    }
    const response = await fetch(request.url, init);
    return { kind: "response", status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
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

export async function handleDrive(message: DriveRequest): Promise<DriveResult> {
  const config = bakedOAuth();
  const deps = { config, http: chromeHttp, token: { get: identityToken, remove: removeToken }, storage: storage() };
  try {
    if (message.type === "probe") {
      return remember(await runProbe({ ...deps, session, lock }));
    }
    if (lock.held) return { phase: "busy", account: session, warning: null, httpStatus: null };
    return remember(await connectDrive({ ...deps, interactive: message.type === "connect" }));
  } catch {
    const stored = await storage().get();
    if (stored?.pendingMutation) return { phase: "unknown-mutation", account: session, warning: "previous-unknown", httpStatus: null };
    return { phase: "http-error", account: session, warning: null, httpStatus: null };
  }
}
