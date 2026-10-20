import { DRIVE_FILE_SCOPE, oauthReady, type PublicOAuth } from "./public-config";

export { DRIVE_FILE_SCOPE };

export const DRIVE_PROTOCOL = "wa-scribe.t03";

export const PROBE_MARKDOWN = "# wa-scribe test\n\n[dot](dot.bin)\n";
export const PROBE_MARKDOWN_UPDATED = "# wa-scribe test\n\n[dot](dot.bin)\n\nupdated\n";
export const PROBE_JSON = '{"probe":"wa-scribe","kind":"synthetic"}\n';
export const PROBE_MEDIA = Uint8Array.of(119, 97, 45, 115);

const ABOUT_URL = "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress,displayName)";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const MAX_REQUESTS = 12;
const FOLDER_NAME = "wa-scribe test";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const textEncoder = new TextEncoder();

export type DriveAccount = {
  permissionId: string;
  emailAddress: string;
  displayName: string;
};

export type ProbeFile = { name: string; id: string };

export type ProbeRecord = {
  accountId: string;
  rootId: string | null;
  files: ProbeFile[];
  pendingMutation: boolean;
  pendingRevision?: string;
  pendingAccountId?: string;
};

export type DrivePhase =
  | "missing-setup"
  | "signed-out"
  | "denied"
  | "no-identity"
  | "connected"
  | "account-changed"
  | "root-missing"
  | "unknown-mutation"
  | "auth-expired"
  | "http-error"
  | "invalid-json"
  | "mismatch"
  | "budget"
  | "busy"
  | "verified"
  | "rejected";

export type DriveWarning = "previous-unknown" | "account-changed" | "root-missing" | null;

export type DriveResult = {
  phase: DrivePhase;
  account: DriveAccount | null;
  warning: DriveWarning;
  httpStatus: number | null;
  pendingId: string | null;
};

export type HttpRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  token: string;
  contentType?: string;
  body?: Uint8Array;
  maxResponseBytes?: number;
  timeoutMs?: number;
};

export type HttpResult = { kind: "response"; status: number; bytes: Uint8Array } | { kind: "unknown" };

export type HttpClient = (request: HttpRequest) => Promise<HttpResult>;

export type TokenFailure = "denied" | "no-identity" | "signed-out" | "expired" | "missing-setup";

export type TokenResult = { ok: true; token: string } | { ok: false; reason: TokenFailure };

export type TokenClient = {
  get: (interactive: boolean) => Promise<TokenResult>;
  remove: (token: string) => Promise<void>;
};

export type ProbeStorage = {
  get: () => Promise<ProbeRecord | null>;
  set: (record: ProbeRecord) => Promise<void>;
};

export type ProbeLock = { held: boolean };

export type DriveRequest = {
  protocol: typeof DRIVE_PROTOCOL;
  type: "connect" | "restore" | "probe";
  ackPendingId?: string;
  expectedAccountId?: string;
};

export type DriveStatus = { protocol: typeof DRIVE_PROTOCOL; type: "drive-status"; result: DriveResult };

type Created = { id: string; name: string; mimeType: string; parents: string[] };

const PHASES: readonly DrivePhase[] = ["missing-setup", "signed-out", "denied", "no-identity", "connected", "account-changed", "root-missing", "unknown-mutation", "auth-expired", "http-error", "invalid-json", "mismatch", "budget", "busy", "verified", "rejected"];

export function driveId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function accountShape(value: unknown): value is DriveAccount {
  return isRecord(value) && driveId(value.permissionId) && typeof value.emailAddress === "string" && value.emailAddress.length > 0 && value.emailAddress.length <= 320 && typeof value.displayName === "string" && value.displayName.length <= 512;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDriveResult(value: unknown): value is DriveResult {
  return (
    isRecord(value) &&
    PHASES.some((phase) => phase === value.phase) &&
    (value.account === null || accountShape(value.account)) &&
    (value.warning === null || value.warning === "previous-unknown" || value.warning === "account-changed" || value.warning === "root-missing") &&
    (value.httpStatus === null || (typeof value.httpStatus === "number" && Number.isInteger(value.httpStatus) && value.httpStatus >= 0 && value.httpStatus <= 599)) &&
    (value.pendingId === null || (typeof value.pendingId === "string" && value.pendingId.length <= 2048))
  );
}

export function isDriveRequest(value: unknown): value is DriveRequest {
  if (!isRecord(value) || value.protocol !== DRIVE_PROTOCOL) return false;
  if (value.type !== "connect" && value.type !== "restore" && value.type !== "probe") return false;
  return (value.ackPendingId === undefined || (typeof value.ackPendingId === "string" && value.ackPendingId.length <= 2048)) &&
    (value.expectedAccountId === undefined || driveId(value.expectedAccountId));
}

export function isDriveStatus(value: unknown): value is DriveStatus {
  return isRecord(value) && value.protocol === DRIVE_PROTOCOL && value.type === "drive-status" && isDriveResult(value.result);
}

/** A mutation revision changes even when Drive has not returned the new file ID. */
export function unresolvedKey(record: ProbeRecord | null): string | null {
  if (!record?.pendingMutation) return null;
  return record.pendingRevision ?? `legacy:${JSON.stringify([record.accountId, record.rootId, record.files])}`;
}

export function classifyIdentityError(message: string, interactive: boolean): TokenFailure {
  const text = message.toLowerCase();
  if (text.includes("client_id") || text.includes("oauth2 client") || text.includes("bad client")) return "missing-setup";
  if (!interactive && (text.includes("interaction") || text.includes("not granted"))) return "signed-out";
  if (text.includes("cancel") || text.includes("denied") || text.includes("did not approve")) return "denied";
  if (text.includes("expired") || text.includes("revoked") || text.includes("invalid credentials")) return "expired";
  return "no-identity";
}

export function panelCopy(result: DriveResult): { status: string; account: string; notice: string } {
  const notice =
    result.warning === "previous-unknown"
      ? result.phase === "verified"
        ? "This test used a new folder. The earlier unresolved change was not retried."
        : result.phase === "auth-expired"
          ? "A previous Drive change may have succeeded. It was not retried. Connect again before a new test."
          : "A previous Drive change may have succeeded. It was not retried. Run Drive test again to start a new folder."
      : result.warning === "account-changed"
        ? "The Drive account changed. The previous test folder is paused."
        : result.warning === "root-missing"
          ? "The saved test folder is missing. Connect did not create a replacement."
          : "";
  const status: Record<DrivePhase, string> = {
    "missing-setup": "Google setup is missing. Set the OAuth client ID and extension public key, then rebuild.",
    "signed-out": "Not connected.",
    denied: "Drive permission was denied.",
    "no-identity": "No usable Chrome identity.",
    connected: "Connected.",
    "account-changed": "Connected. The previous test folder is paused.",
    "root-missing": "Connected. The saved test folder is missing.",
    "unknown-mutation":
      result.httpStatus === null
        ? "A Drive change may have succeeded. This attempt stopped."
        : `Drive returned HTTP ${result.httpStatus}. A Drive change may have succeeded. This attempt stopped.`,
    "auth-expired": "Drive access expired or was revoked. Connect again. The test was not retried.",
    "http-error": result.httpStatus === null ? "Drive returned an HTTP error." : `Drive returned HTTP ${result.httpStatus}.`,
    "invalid-json": "Drive returned invalid JSON.",
    mismatch: "Drive returned unexpected file bytes or identity. Nothing was retried.",
    budget: "The Drive test stopped at its request limit.",
    busy: "A Drive test is already running.",
    verified: "Drive test verified raw Markdown, JSON, and media bytes.",
    rejected: "The Drive request was rejected.",
  };
  return { status: status[result.phase], account: result.account?.emailAddress ?? "", notice };
}

function mergeWarning(current: DriveWarning, incoming: DriveWarning): DriveWarning {
  if (current === "previous-unknown" || incoming === "previous-unknown") return "previous-unknown";
  return current ?? incoming;
}

function result(
  phase: DrivePhase,
  account: DriveAccount | null,
  warning: DriveWarning = null,
  httpStatus: number | null = null,
  pendingId: string | null = null,
): DriveResult {
  return { phase, account, warning, httpStatus, pendingId };
}

function parseJson(bytes: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function readAccount(bytes: Uint8Array): DriveAccount | null {
  const parsed = parseJson(bytes);
  if (!isRecord(parsed) || !isRecord(parsed.user)) return null;
  const { permissionId, emailAddress, displayName } = parsed.user;
  if (!driveId(permissionId)) return null;
  if (typeof emailAddress !== "string" || emailAddress.length === 0 || emailAddress.length > 320) return null;
  return { permissionId, emailAddress, displayName: typeof displayName === "string" ? displayName : "" };
}

function readCreated(bytes: Uint8Array): Created | null {
  const parsed = parseJson(bytes);
  if (!isRecord(parsed) || !driveId(parsed.id) || typeof parsed.name !== "string" || typeof parsed.mimeType !== "string") return null;
  if (parsed.parents !== undefined && !Array.isArray(parsed.parents)) return null;
  const parents: string[] = [];
  if (Array.isArray(parsed.parents)) {
    for (const parent of parsed.parents) {
      if (!driveId(parent)) return null;
      parents.push(parent);
    }
  }
  return { id: parsed.id, name: parsed.name, mimeType: parsed.mimeType, parents };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function multipart(meta: { name: string; mimeType: string; parents: string[] }, mediaType: string, content: Uint8Array): { body: Uint8Array; contentType: string } {
  const boundary = "wa_scribe_probe";
  const head = textEncoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`,
  );
  const tail = textEncoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + content.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(content, head.byteLength);
  body.set(tail, head.byteLength + content.byteLength);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

type Call = { count: number; token: string; accountId: string | null; http: HttpClient; storage: ProbeStorage; remove: (token: string) => Promise<void> };

async function exchange(
  call: Call,
  request: Omit<HttpRequest, "token">,
  record: ProbeRecord | null,
  inheritedPending: boolean,
): Promise<{ bytes: Uint8Array; pendingId: string | null } | DriveResult> {
  if (call.count >= MAX_REQUESTS) return result("budget", null);
  call.count += 1;
  const mutating = request.method !== "GET";
  const marked = record && mutating && call.accountId
    ? { ...record, pendingMutation: true, pendingRevision: crypto.randomUUID(), pendingAccountId: call.accountId }
    : null;
  if (mutating && !marked) return result("mismatch", null);
  if (mutating && marked) await call.storage.set(marked);
  const response = await call.http({ ...request, token: call.token });
  const pendingId = unresolvedKey(marked);
  if (response.kind === "unknown") return result("unknown-mutation", null, "previous-unknown", null, pendingId);
  if (response.status === 401) {
    await call.remove(call.token);
    const kept = await restoreInherited(call, record, mutating, inheritedPending);
    return result("auth-expired", null, kept ? "previous-unknown" : null, null, kept);
  }
  if (mutating && response.status >= 500 && response.status <= 599) {
    return result("unknown-mutation", null, "previous-unknown", response.status, pendingId);
  }
  if (response.status < 200 || response.status >= 300) {
    const kept = await restoreInherited(call, record, mutating, inheritedPending);
    return result("http-error", null, kept ? "previous-unknown" : null, response.status, kept);
  }
  return { bytes: response.bytes, pendingId };
}

async function restoreInherited(call: Call, record: ProbeRecord | null, mutating: boolean, inheritedPending: boolean): Promise<string | null> {
  if (!mutating || !record) return null;
  const next = { ...record, pendingMutation: inheritedPending };
  await call.storage.set(next);
  return inheritedPending ? unresolvedKey(next) : null;
}

async function authorize(config: PublicOAuth, interactive: boolean, token: TokenClient, http: HttpClient, storage: ProbeStorage): Promise<{ account: DriveAccount; call: Call } | DriveResult> {
  if (!oauthReady(config)) return result("missing-setup", null);
  const issued = await token.get(interactive);
  if (!issued.ok) return result(issued.reason === "expired" ? "auth-expired" : issued.reason, null);
  const call: Call = { count: 0, token: issued.token, accountId: null, http, storage, remove: (value) => token.remove(value) };
  const about = await exchange(call, { method: "GET", url: ABOUT_URL }, null, false);
  if ("phase" in about) return about;
  const account = readAccount(about.bytes);
  if (!account) return result("invalid-json", null);
  call.accountId = account.permissionId;
  return { account, call };
}

export async function connectDrive(input: {
  config: PublicOAuth;
  interactive: boolean;
  http: HttpClient;
  token: TokenClient;
  storage: ProbeStorage;
}): Promise<DriveResult> {
  const auth = await authorize(input.config, input.interactive, input.token, input.http, input.storage);
  if ("phase" in auth) return auth;
  const stored = await input.storage.get();
  if (stored?.pendingMutation) return result("unknown-mutation", auth.account, "previous-unknown", null, unresolvedKey(stored));
  if (stored && stored.accountId !== auth.account.permissionId) return result("account-changed", auth.account, "account-changed");
  if (stored?.rootId) {
    const folder = await exchange(auth.call, { method: "GET", url: `${FILES_URL}/${stored.rootId}?fields=id,trashed,mimeType` }, null, false);
    if ("phase" in folder && folder.phase === "http-error" && folder.httpStatus === 404) return result("root-missing", auth.account, "root-missing");
    if ("phase" in folder) return { ...folder, account: auth.account };
    const parsed = parseJson(folder.bytes);
    if (!isRecord(parsed)) return result("invalid-json", auth.account);
    if (parsed.trashed === true || parsed.mimeType !== FOLDER_MIME || parsed.id !== stored.rootId) return result("root-missing", auth.account, "root-missing");
  }
  return result("connected", auth.account);
}

const PROBE_FILES = [
  { name: "note.md", mimeType: "text/markdown", bytes: textEncoder.encode(PROBE_MARKDOWN) },
  { name: "meta.json", mimeType: "application/json", bytes: textEncoder.encode(PROBE_JSON) },
  { name: "dot.bin", mimeType: "application/octet-stream", bytes: PROBE_MEDIA },
] as const;

async function createFile(call: Call, record: ProbeRecord, file: (typeof PROBE_FILES)[number]): Promise<DriveResult | null> {
  if (!record.rootId) return result("mismatch", null);
  const payload = multipart({ name: file.name, mimeType: file.mimeType, parents: [record.rootId] }, file.mimeType, file.bytes);
  const created = await exchange(
    call,
    { method: "POST", url: `${UPLOAD_URL}?uploadType=multipart&fields=id,name,mimeType,parents`, contentType: payload.contentType, body: payload.body },
    record,
    record.pendingMutation,
  );
  if ("phase" in created) return created;
  const meta = readCreated(created.bytes);
  if (!meta) return result("unknown-mutation", null, "previous-unknown", null, created.pendingId);
  record.files.push({ name: file.name, id: meta.id });
  await call.storage.set({ ...record, pendingMutation: false });
  if (meta.name !== file.name || meta.mimeType !== file.mimeType || meta.mimeType.startsWith("application/vnd.google-apps.") || !meta.parents.includes(record.rootId))
    return result("mismatch", null);
  const downloaded = await exchange(call, { method: "GET", url: `${FILES_URL}/${meta.id}?alt=media` }, null, false);
  if ("phase" in downloaded) return downloaded;
  if (!sameBytes(downloaded.bytes, file.bytes)) return result("mismatch", null);
  return null;
}

export async function runProbe(input: {
  config: PublicOAuth;
  session: DriveAccount | null;
  http: HttpClient;
  token: TokenClient;
  storage: ProbeStorage;
  lock: ProbeLock;
  ackPendingId?: string | null;
  expectedAccountId?: string;
}): Promise<DriveResult> {
  if (input.lock.held) return result("busy", input.session);
  if (!input.session) return result("signed-out", null);
  const expectedAccountId = input.expectedAccountId ?? input.session.permissionId;
  if (input.session.permissionId !== expectedAccountId) return result("account-changed", input.session, "account-changed");
  input.lock.held = true;
  try {
    const prior = await input.storage.get();
    const pendingId = unresolvedKey(prior);
    if (pendingId && input.ackPendingId !== pendingId) return result("unknown-mutation", input.session, "previous-unknown", null, pendingId);
    const warning: DriveWarning = prior?.pendingMutation ? "previous-unknown" : prior && prior.accountId !== input.session.permissionId ? "account-changed" : null;
    const auth = await authorize(input.config, false, input.token, input.http, input.storage);
    if ("phase" in auth) return auth;
    if (auth.account.permissionId !== expectedAccountId) return result("account-changed", auth.account, "account-changed");
    const inheritedPending = Boolean(prior?.pendingMutation);
    const staged: ProbeRecord = prior ?? { accountId: auth.account.permissionId, rootId: null, files: [], pendingMutation: false };
    const folderBody = textEncoder.encode(JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME, description: "wa-scribe synthetic probe. Not a chat export." }));
    const folder = await exchange(
      auth.call,
      { method: "POST", url: `${FILES_URL}?fields=id,name,mimeType`, contentType: "application/json", body: folderBody },
      staged,
      inheritedPending,
    );
    if ("phase" in folder) return { ...folder, account: auth.account, warning: mergeWarning(warning, folder.warning) };
    const created = readCreated(folder.bytes);
    if (!created) return result("unknown-mutation", auth.account, "previous-unknown", null, folder.pendingId);
    let record: ProbeRecord = { accountId: auth.account.permissionId, rootId: created.id, files: [], pendingMutation: false };
    await input.storage.set(record);
    if (created.name !== FOLDER_NAME || created.mimeType !== FOLDER_MIME) return result("mismatch", auth.account, warning);
    for (const file of PROBE_FILES) {
      const failed = await createFile(auth.call, record, file);
      if (failed) return { ...failed, account: auth.account, warning: mergeWarning(warning, failed.warning) };
    }
    const markdown = record.files.find((file) => file.name === "note.md");
    if (!markdown || !record.rootId) return result("mismatch", auth.account, warning);
    const updated = textEncoder.encode(PROBE_MARKDOWN_UPDATED);
    const patched = await exchange(
      auth.call,
      { method: "PATCH", url: `${UPLOAD_URL}/${markdown.id}?uploadType=media&fields=id,name,mimeType`, contentType: "text/markdown", body: updated },
      record,
      record.pendingMutation,
    );
    if ("phase" in patched) return { ...patched, account: auth.account, warning: mergeWarning(warning, patched.warning) };
    const patchMeta = readCreated(patched.bytes);
    if (!patchMeta) return result("unknown-mutation", auth.account, "previous-unknown", null, patched.pendingId);
    await input.storage.set({ ...record, pendingMutation: false });
    if (patchMeta.id !== markdown.id || patchMeta.mimeType !== "text/markdown" || patchMeta.mimeType.startsWith("application/vnd.google-apps."))
      return result("mismatch", auth.account, warning);
    const reread = await exchange(auth.call, { method: "GET", url: `${FILES_URL}/${markdown.id}?alt=media` }, null, false);
    if ("phase" in reread) return { ...reread, account: auth.account, warning: mergeWarning(warning, reread.warning) };
    if (!sameBytes(reread.bytes, updated)) return result("mismatch", auth.account, warning);
    return result("verified", auth.account, warning);
  } finally {
    input.lock.held = false;
  }
}

export async function dispatchDrive(input: {
  message: DriveRequest;
  session: DriveAccount | null;
  lock: ProbeLock;
  config: PublicOAuth;
  http: HttpClient;
  token: TokenClient;
  storage: ProbeStorage;
}): Promise<DriveResult> {
  if (input.message.type !== "probe" && input.lock.held) return result("busy", input.session);
  if (input.message.type === "probe") {
    if (!input.message.expectedAccountId) return result("rejected", input.session);
    return runProbe({
      config: input.config,
      session: input.session,
      http: input.http,
      token: input.token,
      storage: input.storage,
      lock: input.lock,
      ackPendingId: input.message.ackPendingId ?? null,
      expectedAccountId: input.message.expectedAccountId,
    });
  }
  input.lock.held = true;
  try {
    return await connectDrive({ config: input.config, interactive: input.message.type === "connect", http: input.http, token: input.token, storage: input.storage });
  } finally {
    input.lock.held = false;
  }
}
