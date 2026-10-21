import { chromeHttp, handleDrive, identityToken, removeToken } from "./chrome-drive";
import { coverageStatus, downloadPass, type ObservedMessage } from "./download";
import { editPass } from "./edit";
import { alignByOrder, decodeMetadata, parseTranscript } from "./format";
import { bakedOAuth, oauthReady } from "./public-config";
import type { DriveAccount, DriveResult, HttpRequest } from "./drive";
import type { AttachmentSlot, Binding, ChatExport, Coverage } from "./model";
import { decodeMediaBase64, pruneStagedMedia, readStagedMedia, sha256Bytes, stageMedia, type StagedMedia } from "./media-stage";
import type { CollectedChat, OpenChat } from "./whatsapp";

export const APP_PROTOCOL = "wa-scribe.app";
const KEY = "waScribeExports";
const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const MAX_PENDING_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_FILES = 128;
type DriveMedia = StagedMedia & { id: string };
type Generation = { folderId: string; markdownId: string; metadataId: string; media?: DriveMedia[] };
type FileAttachment = Extract<AttachmentSlot["attachment"], { state: "saved" | "opaque" }>;
type KnownMedia = Map<string, Map<number, FileAttachment>>;
type Pending = {
  operationId: string;
  target: Generation;
  markdown: string;
  metadata: string;
  beforeHash: string | null;
  stage: "prepared" | "folder" | "media" | "markdown" | "metadata" | "publish";
};
type Archive = { accountId: string; rootId: string; generation: string; exportId?: string; deleted?: boolean };
type Chat = OpenChat & {
  key: string;
  selected: boolean;
  generation: string;
  driveAccountId: string | null;
  rootId: string | null;
  rootReady: boolean;
  current: Generation | null;
  pending: Pending | null;
  retired: Generation[];
  deleting: boolean;
  archives: Archive[];
  result: string;
  lastSuccess: string | null;
};
type Root = { accountId: string; id: string; operationId: string; ready: boolean };
type Job = { phase: string; chatKey: string | null; count: number; reason: string | null };
type SavedState = { schema: 1; roots: Root[]; chats: Chat[]; job: Job | null };
type Access = { token: string; account: DriveAccount };
type CatalogChat = OpenChat & { key: string; aliases: string[] };
type AppReply = { ok: boolean; error?: string; state: ReturnType<typeof publicState> };
export type AppRequest = { protocol: typeof APP_PROTOCOL; type: string; [field: string]: unknown };
let saved: SavedState | null = null;
let loading: Promise<SavedState> | null = null;
let drive: DriveResult | null = null;
let revision = Date.now();
let active = false;
let stopped = false;
let collection: chrome.runtime.Port | null = null;
let writes = Promise.resolve();
let catalog: CatalogChat[] = [];
let catalogScope: "local-cache" | null = null;
let catalogError: string | null = null;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value); }
function driveMedia(value: unknown): value is DriveMedia {
  return record(value) && id(value.id) && typeof value.key === "string" && /^[0-9a-f]{64}$/.test(value.key) &&
    typeof value.relativePath === "string" && new RegExp(`^${value.key}\\.[a-z0-9]{1,10}$`).test(value.relativePath) &&
    typeof value.name === "string" && value.name.length > 0 && value.name.length <= 256 && !/[\x00-\x1f\x7f/\\:]/u.test(value.name) &&
    (value.mediaType === null || (typeof value.mediaType === "string" && value.mediaType.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value.mediaType))) &&
    typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= 8 * 1024 * 1024;
}
function generation(value: unknown): value is Generation {
  if (!record(value) || !id(value.folderId) || !id(value.markdownId) || !id(value.metadataId)) return false;
  if (value.media !== undefined && (!Array.isArray(value.media) || value.media.length > MAX_MEDIA_FILES || !value.media.every(driveMedia))) return false;
  const media = value.media ?? [];
  return new Set([value.folderId, value.markdownId, value.metadataId, ...media.map((file) => file.id)]).size === 3 + media.length &&
    new Set(media.map((file) => file.relativePath)).size === media.length && media.reduce((total, file) => total + file.size, 0) <= MAX_MEDIA_BYTES;
}
function pending(value: unknown): value is Pending {
  return record(value) && id(value.operationId) && generation(value.target) && typeof value.markdown === "string" &&
    typeof value.metadata === "string" && (value.beforeHash === null || typeof value.beforeHash === "string") &&
    ["prepared", "folder", "media", "markdown", "metadata", "publish"].includes(String(value.stage)) &&
    encoder.encode(value.markdown + value.metadata).byteLength <= MAX_PENDING_BYTES;
}
function chatRecord(value: unknown): value is Chat {
  return record(value) && id(value.key) && typeof value.accountId === "string" && typeof value.chatId === "string" &&
    typeof value.name === "string" && typeof value.selected === "boolean" && id(value.generation) &&
    (value.driveAccountId === null || id(value.driveAccountId)) && (value.rootId === null || id(value.rootId)) && typeof value.rootReady === "boolean" && typeof value.deleting === "boolean" &&
    (value.current === null || generation(value.current)) && (value.pending === null || pending(value.pending)) &&
    Array.isArray(value.retired) && value.retired.every(generation) && Array.isArray(value.archives) &&
    value.archives.every((entry) => record(entry) && id(entry.accountId) && id(entry.rootId) && id(entry.generation) &&
      (entry.exportId === undefined || id(entry.exportId)) && (entry.deleted === undefined || typeof entry.deleted === "boolean")) &&
    typeof value.result === "string" && (value.lastSuccess === null || typeof value.lastSuccess === "string");
}

async function state(): Promise<SavedState> {
  if (saved) return saved;
  if (loading) return loading;
  loading = (async () => {
    const raw: unknown = (await chrome.storage.local.get(KEY))[KEY];
    if (raw === undefined) saved = { schema: 1, roots: [], chats: [], job: null };
    else {
      if (!record(raw) || raw.schema !== 1 || !Array.isArray(raw.chats) || raw.chats.length > 100 || !raw.chats.every(chatRecord) ||
          !Array.isArray(raw.roots) || !raw.roots.every((root) => record(root) && id(root.accountId) && id(root.id) && id(root.operationId) && typeof root.ready === "boolean")) {
        throw new Error("Saved export state is invalid. Existing files were preserved; do not reset storage to repair an export.");
      }
      const job = raw.job;
      if (job !== null && (!record(job) || typeof job.phase !== "string" || (job.chatKey !== null && typeof job.chatKey !== "string") ||
          typeof job.count !== "number" || (job.reason !== null && typeof job.reason !== "string"))) throw new Error("Saved job state needs recovery.");
      saved = { schema: 1, roots: raw.roots.map((root) => ({ accountId: root.accountId, id: root.id, operationId: root.operationId, ready: root.ready })), chats: raw.chats, job: null };
      if (new Set(saved.chats.map((chat) => chat.key)).size !== saved.chats.length ||
          new Set(saved.chats.map((chat) => JSON.stringify([chat.accountId, chat.chatId]))).size !== saved.chats.length ||
          new Set(saved.roots.map((root) => root.accountId)).size !== saved.roots.length) {
        saved = null; throw new Error("Saved identities collide. Existing exports were preserved; recovery is required.");
      }
      if (job !== null) for (const chat of saved.chats) if (chat.selected) chat.result = chat.pending ? "Recovery required after interruption" : "Interrupted — start again explicitly";
    }
    return saved;
  })();
  try { return await loading; } finally { loading = null; }
}

async function persist(): Promise<void> {
  revision += 1;
  writes = writes.catch(() => undefined).then(async () => {
    if (!saved) return;
    if (encoder.encode(JSON.stringify(saved)).byteLength > 768 * 1024) throw new Error("Pending export storage budget reached. Recover pending generations before collecting more.");
    await chrome.storage.local.set({ [KEY]: saved });
  });
  await writes;
}

function folderUrl(fileId: string): string { return `https://drive.google.com/drive/folders/${fileId}`; }
function exportUrl(chat: Chat): string | null {
  if (chat.current) return folderUrl(chat.current.folderId);
  const previous = chat.archives.at(-1);
  return previous && !previous.deleted ? folderUrl(previous.exportId ?? previous.rootId) : null;
}
function coverageCopy(coverage: Coverage, unchanged = false): string {
  const status = coverageStatus(coverage) === "partial" ? "Partial" : "Committed";
  const reason = coverage.stopReason ?? (coverage.gaps.length ? "unverified-between" : status === "Partial" ? "scope-boundary-unverified" : null);
  return `${unchanged ? "Unchanged; " : ""}${status}${reason ? `: ${reason}` : ""}`;
}
function chatName(chat: OpenChat): string {
  return catalog.find((candidate) => candidate.accountId === chat.accountId && candidate.chatId === chat.chatId &&
    candidate.name !== candidate.chatId)?.name ?? chat.name;
}
function publicState() {
  const registered = (saved?.chats ?? []).map((chat) => ({
    key: chat.key, accountId: chat.accountId, chatId: chat.chatId,
    name: chatName(chat),
    selected: chat.selected, result: chat.result, lastSuccess: chat.lastSuccess, registered: true,
    url: exportUrl(chat),
    archives: chat.archives.map((entry) => ({ url: folderUrl(entry.rootId), accountId: entry.accountId, generation: entry.generation, deleted: entry.deleted === true })),
  }));
  const discovered = catalog.filter((candidate) => !saved?.chats.some((chat) => chat.accountId === candidate.accountId && chat.chatId === candidate.chatId))
    .map((chat) => ({ key: chat.key, accountId: chat.accountId, chatId: chat.chatId, name: chat.name,
      selected: false, result: "Not synced", lastSuccess: null, url: null, archives: [], registered: false }));
  return {
    revision, drive, setup: oauthReady(bakedOAuth()), job: saved?.job ?? null, catalogScope, catalogError,
    chats: [...registered, ...discovered],
  };
}

export function isAppRequest(value: unknown): value is AppRequest {
  return record(value) && value.protocol === APP_PROTOCOL && typeof value.type === "string" &&
    ["state", "discover", "connect", "probe", "add-current", "select", "sync", "stop", "recover", "fresh", "delete"].includes(value.type);
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : "The operation failed; existing exports were preserved."; }
function stringField(message: AppRequest, key: string): string {
  const value = message[key];
  if (typeof value !== "string" || value.length > 512) throw new Error(`Invalid ${key}.`);
  return value;
}
function selectedChat(message: AppRequest): Chat {
  const chat = saved?.chats.find((entry) => entry.key === stringField(message, "key"));
  if (!chat) throw new Error("This chat is no longer registered.");
  return chat;
}

function registerChat(source: OpenChat, key = crypto.randomUUID().replaceAll("-", "")): Chat {
  const existing = saved?.chats.find((chat) => chat.accountId === source.accountId && chat.chatId === source.chatId);
  if (existing) return existing;
  if (!saved || saved.chats.length >= 100) throw new Error("The saved chat limit is 100.");
  if (saved.chats.some((chat) => chat.key === key)) throw new Error("The chat selection key is ambiguous. Refresh the list.");
  const chat: Chat = { accountId: source.accountId, chatId: source.chatId, name: source.name, key,
    selected: true, generation: crypto.randomUUID(), driveAccountId: null, rootId: null, rootReady: false,
    deleting: false, current: null, pending: null, retired: [], archives: [], result: "Selected — not exported", lastSuccess: null };
  saved.chats.push(chat);
  return chat;
}

async function http(access: Access, request: Omit<HttpRequest, "token">): Promise<{ status: number; bytes: Uint8Array }> {
  const result = await chromeHttp({ ...request, token: access.token });
  if (result.kind === "unknown") throw new Error("Drive outcome is unknown. The pending generation is retained; use Recover before starting another pass.");
  if (result.status === 401) { await removeToken(access.token); throw new Error("Drive access expired. Connect again to the same Google account."); }
  return result;
}
function json(bytes: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!record(value)) throw new Error("Drive returned invalid metadata.");
  return value;
}
async function accessFor(expected: string): Promise<Access> {
  if (!oauthReady(bakedOAuth())) throw new Error("Configure the Google OAuth client in manifest.json, then reload the extension.");
  const issued = await identityToken(false);
  if (!issued.ok) throw new Error("Connect Google Drive before exporting.");
  const access = { token: issued.token, account: { permissionId: "", emailAddress: "", displayName: "" } };
  const response = await http(access, { method: "GET", url: "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress,displayName)" });
  if (response.status !== 200) throw new Error(`Drive account lookup failed (HTTP ${response.status}).`);
  const user = json(response.bytes).user;
  if (!record(user) || !id(user.permissionId) || typeof user.emailAddress !== "string") throw new Error("Drive did not identify the authenticated account.");
  if (user.permissionId !== expected) throw new Error("The Google account changed. Connect again and review the displayed account before exporting.");
  return { token: issued.token, account: { permissionId: user.permissionId, emailAddress: user.emailAddress, displayName: typeof user.displayName === "string" ? user.displayName : "" } };
}

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function allocate(access: Access, count: number): Promise<string[]> {
  const response = await http(access, { method: "GET", url: `${FILES}/generateIds?count=${count}&space=drive&type=files` });
  if (response.status !== 200) throw new Error(`Drive ID allocation failed (HTTP ${response.status}).`);
  const ids = json(response.bytes).ids;
  if (!Array.isArray(ids) || ids.length !== count || !ids.every(id) || new Set(ids).size !== count) throw new Error("Drive returned invalid allocated IDs.");
  return ids;
}
async function metadata(access: Access, fileId: string, allowTrashed = false): Promise<Record<string, unknown>> {
  if (!id(fileId)) throw new Error("Invalid owned file ID.");
  const response = await http(access, { method: "GET", url: `${FILES}/${fileId}?fields=id,parents,mimeType,trashed,appProperties` });
  if (response.status !== 200) throw new Error(`An owned Drive file is unavailable (HTTP ${response.status}). No same-named replacement was adopted.`);
  const meta = json(response.bytes);
  if (meta.id !== fileId || (!allowTrashed && meta.trashed === true)) throw new Error("An owned Drive file was moved to trash or changed identity.");
  return meta;
}
function owner(meta: Record<string, unknown>, parent: string | null, operation: string): boolean {
  const properties = meta.appProperties;
  return record(properties) && properties.waScribe === chrome.runtime.id && properties.operation === operation &&
    (parent === null || (Array.isArray(meta.parents) && meta.parents.includes(parent)));
}

/** Only creates preallocated immutable IDs. Retrying a lost create cannot overwrite an existing file. */
async function create(access: Access, fileId: string, name: string, parent: string | null, operation: string, body: string | Uint8Array | null, mimeType = FOLDER): Promise<void> {
  if (stopped) throw new Error("Stopped before the next destination mutation. Recover any staged generation explicitly.");
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  const hash = bytes === null ? "folder" : await sha256Bytes(bytes);
  const meta = { id: fileId, name, mimeType, ...(parent ? { parents: [parent] } : {}), appProperties: { waScribe: chrome.runtime.id, operation, digest: hash } };
  let request: Omit<HttpRequest, "token">;
  if (bytes === null) request = { method: "POST", url: `${FILES}?fields=id`, contentType: "application/json", body: encoder.encode(JSON.stringify(meta)) };
  else {
    const boundary = `wa_${crypto.randomUUID()}`;
    const head = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`), payload = new Uint8Array(head.length + bytes.length + tail.length);
    payload.set(head); payload.set(bytes, head.length); payload.set(tail, head.length + bytes.length);
    request = { method: "POST", url: `${UPLOAD}?uploadType=multipart&fields=id`, contentType: `multipart/related; boundary=${boundary}`, body: payload, timeoutMs: 30_000 };
  }
  const response = await http(access, request);
  if (response.status !== 200 && response.status !== 201 && response.status !== 409) throw new Error(`Drive create stopped (HTTP ${response.status}). Recover the retained operation before trying a new pass.`);
  const received = await metadata(access, fileId), properties = received.appProperties;
  if (!owner(received, parent, operation) || received.mimeType !== mimeType || !record(properties) || properties.digest !== hash) throw new Error("An allocated Drive ID has different ownership or content. Recovery paused.");
  if (bytes !== null) {
    const restored = await readBytes(access, fileId, parent, operation, Math.max(MAX_PENDING_BYTES, bytes.length));
    if (restored.length !== bytes.length || await sha256Bytes(restored) !== hash) throw new Error("Drive read-back bytes do not match the staged file. Recovery paused.");
  }
}

async function readBytes(access: Access, fileId: string, parent: string | null, operation: string, limit: number): Promise<Uint8Array> {
  const meta = await metadata(access, fileId);
  if (!owner(meta, parent, operation)) throw new Error("A file is outside its bound export tree. No write was made.");
  const response = await http(access, { method: "GET", url: `${FILES}/${fileId}?alt=media`, maxResponseBytes: limit, timeoutMs: 30_000 });
  if (response.status !== 200) throw new Error(`Drive read failed (HTTP ${response.status}).`);
  return response.bytes;
}
async function read(access: Access, fileId: string, parent: string | null, operation: string): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(access, fileId, parent, operation, MAX_PENDING_BYTES));
}
function operationFor(g: Generation): string { return g.folderId; }
function mediaMime(value: string | null): string {
  return value && !value.startsWith("application/vnd.google-apps.") ? value : "application/octet-stream";
}
function binding(chat: Chat): Binding {
  if (!chat.rootId || !chat.driveAccountId) throw new Error("This export has no bound destination.");
  return { accountId: chat.accountId, chatId: chat.chatId, destinationId: `${chat.driveAccountId}:${chat.rootId}`, generation: chat.generation };
}
async function ensureDestination(access: Access, chat: Chat, allowCreate = true): Promise<void> {
  if (!saved) throw new Error("State is unavailable.");
  if (chat.driveAccountId && chat.driveAccountId !== access.account.permissionId) throw new Error("This export belongs to a different Google account. Reconnect it, or explicitly start a fresh export.");
  let root = saved.roots.find((entry) => entry.accountId === access.account.permissionId);
  if (!allowCreate && (!root?.ready || !chat.rootId || !chat.rootReady)) throw new Error("The existing export destination is incomplete. Recover it before collecting more.");
  if (!root) {
    const ids = await allocate(access, 1);
    if (!ids[0]) throw new Error("No Drive folder ID was allocated.");
    root = { accountId: access.account.permissionId, id: ids[0], operationId: crypto.randomUUID(), ready: false };
    saved.roots.push(root); await persist();
  }
  // Existing roots are verified by ID; a missing root is never silently replaced.
  if (!root.ready) { await create(access, root.id, "WhatsApp Desk", null, root.operationId, null); root.ready = true; await persist(); }
  else if (!owner(await metadata(access, root.id), null, root.operationId)) throw new Error("Export root ownership changed.");
  if (!chat.rootId) {
    const ids = await allocate(access, 1);
    if (!ids[0]) throw new Error("No chat folder ID was allocated.");
    chat.rootId = ids[0]; chat.driveAccountId = access.account.permissionId; chat.rootReady = false; await persist();
  }
  if (!chat.rootReady) { await create(access, chat.rootId, `${safeName(chat.name)}--${chat.key}-${chat.generation.slice(0, 8)}`, root.id, chat.generation, null); chat.rootReady = true; await persist(); }
  else if (!owner(await metadata(access, chat.rootId), root.id, chat.generation)) throw new Error("The chat destination is missing or its ownership changed.");
}
function safeName(value: string): string { return value.normalize("NFKC").replace(/[\x00-\x1f<>:"/\\|?*]/g, "-").trim().slice(0, 80) || "chat"; }

async function currentFiles(access: Access, chat: Chat): Promise<{ markdown: string; metadata: string } | null> {
  if (!chat.current) return null;
  const g = chat.current;
  if (!owner(await metadata(access, g.folderId), chat.rootId, operationFor(g))) throw new Error("The current generation folder moved or changed ownership.");
  const [markdown, sidecar] = await Promise.all([read(access, g.markdownId, g.folderId, operationFor(g)), read(access, g.metadataId, g.folderId, operationFor(g))]);
  return { markdown, metadata: sidecar };
}

async function publish(access: Access, chat: Chat): Promise<void> {
  const p = chat.pending;
  if (!p || !chat.rootId) throw new Error("No pending generation is available.");
  await ensureDestination(access, chat);
  const decoded = decodeMetadata(p.metadata, binding(chat));
  if (!decoded.ok) throw new Error("Pending metadata is invalid for this export. Existing files were preserved.");
  const parsed = parseTranscript(p.markdown);
  if (!parsed.ok || !alignByOrder(parsed.value.blocks, decoded.value.messages, p.markdown).ok) throw new Error("Pending transcript and metadata disagree. Recovery paused without changing files.");
  const media = new Map((p.target.media ?? []).map((file) => [file.relativePath, file])), referenced = new Set<string>();
  for (const entry of decoded.value.messages.flatMap((message) => message.attachments)) {
    if (!fileAttachment(entry.attachment)) continue;
    const file = media.get(entry.attachment.relativePath);
    if (!file || file.mediaType !== entry.attachment.mediaType) throw new Error("Pending attachment links do not match their staged files. Recovery paused.");
    referenced.add(file.relativePath);
  }
  if (referenced.size !== media.size) throw new Error("Pending attachment files are not fully referenced. Recovery paused.");
  const previous = await currentFiles(access, chat);
  if ((previous ? await digest(JSON.stringify([previous.markdown, previous.metadata])) : null) !== p.beforeHash) throw new Error("The saved export changed after capture. Pending data was retained. Restore the captured export version before Recover.");
  const g = p.target;
  p.stage = "folder"; await persist();
  await create(access, g.folderId, `export-${p.operationId}`, chat.rootId, operationFor(g), null);
  p.stage = "media"; await persist();
  for (const file of g.media ?? []) {
    const bytes = await readStagedMedia(file.key);
    if (bytes.length !== file.size) throw new Error("Staged attachment length changed. Recovery paused.");
    await create(access, file.id, file.relativePath, g.folderId, operationFor(g), bytes, mediaMime(file.mediaType));
  }
  p.stage = "markdown"; await persist();
  await create(access, g.markdownId, "transcript.md", g.folderId, operationFor(g), p.markdown, "text/markdown");
  p.stage = "metadata"; await persist();
  await create(access, g.metadataId, "sync.json", g.folderId, operationFor(g), p.metadata, "application/json");
  p.stage = "publish"; await persist();
  const recheck = await currentFiles(access, chat);
  if ((recheck ? await digest(JSON.stringify([recheck.markdown, recheck.metadata])) : null) !== p.beforeHash) throw new Error("The saved export changed during the pass. The prior export remains current.");
  if (stopped) throw new Error("Stopped before publication. Recover the staged generation explicitly.");
  const old = chat.current;
  chat.current = g; chat.pending = null; chat.lastSuccess = new Date().toISOString(); chat.result = coverageCopy(decoded.value.coverage) + mediaCopy(g, decoded.value);
  if (old) chat.retired.push(old);
  await persist();
  // Cleanup is separate from commit; an unknown delete cannot resurrect or overwrite current IDs.
  await cleanup(access, chat);
  try { await pruneStagedMedia(pendingMediaKeys()); }
  catch (error) { chat.result += `; local attachment cache cleanup pending: ${errorText(error)}`; await persist(); }
}

function pendingMediaKeys(): Set<string> {
  return new Set(saved?.chats.flatMap((chat) => chat.pending?.target.media?.map((file) => file.key) ?? []) ?? []);
}

async function trash(access: Access, fileId: string, parentId: string, operation: string): Promise<void> {
  if (stopped) throw new Error("Stopped before cleanup. The coherent export remains saved.");
  const meta = await metadata(access, fileId, true);
  if (!owner(meta, parentId, operation) || meta.mimeType === FOLDER) throw new Error("Deletion refused: the file is not an owned export leaf.");
  if (meta.trashed === true) return;
  const response = await http(access, { method: "PATCH", url: `${FILES}/${fileId}?fields=id,trashed`, contentType: "application/json", body: encoder.encode('{"trashed":true}') });
  if (response.status !== 200) throw new Error(`Drive cleanup failed (HTTP ${response.status}).`);
}
async function cleanup(access: Access, chat: Chat): Promise<void> {
  if (!chat.rootId) return;
  for (const old of [...chat.retired]) {
    try { await deleteGeneration(access, old, chat.rootId); }
    catch { chat.result += "; previous generation cleanup pending"; break; }
    chat.retired = chat.retired.filter((entry) => entry.folderId !== old.folderId); await persist();
  }
}
async function deleteGeneration(access: Access, g: Generation, parent: string, explicit = false): Promise<void> {
  if (!owner(await metadata(access, g.folderId, true), parent, operationFor(g))) throw new Error("Generation ownership changed; deletion paused.");
  if (!explicit) for (const file of g.media ?? []) await verifiedMediaBytes(access, g, file, true);
  await trash(access, g.markdownId, g.folderId, operationFor(g));
  await trash(access, g.metadataId, g.folderId, operationFor(g));
  for (const file of g.media ?? []) await trash(access, file.id, g.folderId, operationFor(g));
  // drive.file can hide foreign children. Retain folders even when a listing looks empty.
}

function openChat(value: unknown): value is OpenChat {
  return record(value) && typeof value.accountId === "string" && typeof value.chatId === "string" && typeof value.name === "string";
}
async function inspect(tabId: number): Promise<OpenChat> {
  const reply: unknown = await chrome.tabs.sendMessage(tabId, { protocol: APP_PROTOCOL, type: "inspect" });
  if (!record(reply) || reply.ok !== true || !openChat(reply.chat)) throw new Error(record(reply) && typeof reply.reason === "string" ? reply.reason : "Reload WhatsApp Web after installing the extension, then open a conversation.");
  return reply.chat;
}
async function activeChat(): Promise<OpenChat> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find((entry) => entry.url?.startsWith("https://web.whatsapp.com/"));
  if (!tab?.id) throw new Error("Make the WhatsApp Web tab active and open a conversation first.");
  return inspect(tab.id);
}

function catalogReply(value: unknown): { accountId: string; chats: { chatId: string; name: string; aliases: string[] }[] } | null {
  const jid = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && /^\d+(?:-\d+)?(?::\d+)?@(?:c\.us|g\.us|lid|s\.whatsapp\.net)$/.test(value);
  const label = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!record(value) || value.ok !== true || value.scope !== "local-cache" || typeof value.accountId !== "string" || value.accountId.length > 256 ||
      !/^\d+@(?:c\.us|lid)$/.test(value.accountId) ||
      !Array.isArray(value.chats) || value.chats.length > 5_000) return null;
  const chats: { chatId: string; name: string; aliases: string[] }[] = [];
  const seen = new Set<string>();
  for (const entry of value.chats) {
    if (!record(entry) || !jid(entry.chatId) || !label(entry.name) || !Array.isArray(entry.aliases) ||
        entry.aliases.length > 6 || !entry.aliases.every(label) || seen.has(entry.chatId)) return null;
    seen.add(entry.chatId);
    chats.push({ chatId: entry.chatId, name: entry.name, aliases: entry.aliases });
  }
  return { accountId: value.accountId, chats };
}

async function discoverChats(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  tabs.sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)));
  let reason = "Open WhatsApp Web and keep it signed in, then refresh the chat list.";
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    let reply: unknown;
    try { reply = await chrome.tabs.sendMessage(tab.id, { protocol: APP_PROTOCOL, type: "catalog" }); }
    catch { reason = "Reload WhatsApp Web after updating the extension, then refresh the chat list."; continue; }
    const source = catalogReply(reply);
    if (!source) {
      if (record(reply) && typeof reply.reason === "string") reason = reply.reason;
      continue;
    }
    const previousKeys = new Map(catalog.filter((chat) => chat.accountId === source.accountId).map((chat) => [chat.chatId, chat.key]));
    catalog = source.chats.map((chat) => ({ ...chat, accountId: source.accountId,
      key: previousKeys.get(chat.chatId) ?? crypto.randomUUID().replaceAll("-", "") }));
    catalogScope = "local-cache"; catalogError = null; revision += 1;
    return;
  }
  catalog = []; catalogScope = null; catalogError = reason; revision += 1;
  throw new Error(reason);
}

function fileAttachment(value: unknown): value is FileAttachment {
  return record(value) && (value.state === "saved" || value.state === "opaque") && typeof value.name === "string" &&
    typeof value.relativePath === "string" && (value.mediaType === null ? value.state === "opaque" : typeof value.mediaType === "string");
}
function sameFile(left: FileAttachment, right: FileAttachment): boolean {
  return left.state === right.state && left.name === right.name && left.mediaType === right.mediaType && left.relativePath === right.relativePath;
}
function knownMedia(chat: ChatExport | null): KnownMedia {
  return new Map((chat?.messages ?? []).map((message) => [message.id, new Map(message.attachments
    .filter((entry): entry is AttachmentSlot & { attachment: FileAttachment } => fileAttachment(entry.attachment))
    .map((entry) => [entry.slot, entry.attachment]))]));
}
function stagedAttachment(file: StagedMedia): FileAttachment {
  return file.mediaType && file.mediaType !== "application/octet-stream"
    ? { state: "saved", name: file.name, mediaType: file.mediaType, relativePath: file.relativePath }
    : { state: "opaque", name: file.name, mediaType: file.mediaType, relativePath: file.relativePath };
}
function observation(value: unknown, allowed: KnownMedia): ObservedMessage | null {
  if (!record(value) || typeof value.id !== "string" || typeof value.text !== "string" || typeof value.sourceBaseline !== "string" ||
      !record(value.sender) || typeof value.sender.name !== "string" || (value.sender.key !== null && typeof value.sender.key !== "string") ||
      !record(value.timestamp) || typeof value.timestamp.display !== "string" || !["unknown", "display-only", "minute", "date", "instant"].includes(String(value.timestamp.precision)) ||
      (value.timestamp.timeZone !== null && typeof value.timestamp.timeZone !== "string") || (value.timestamp.instant !== null && typeof value.timestamp.instant !== "string") ||
      (value.sequence !== "verified" && value.sequence !== "unknown") || !Array.isArray(value.attachments) || value.attachments.length > 32) return null;
  const attachments: AttachmentSlot[] = [], seenSlots = new Set<number>();
  for (const slot of value.attachments) {
    if (!record(slot) || typeof slot.slot !== "number" || !Number.isSafeInteger(slot.slot) || slot.slot < 1 || slot.slot > 32 || seenSlots.has(slot.slot) || !record(slot.attachment)) return null;
    seenSlots.add(slot.slot);
    const a = slot.attachment;
    if ((a.state === "pending" || a.state === "unavailable") && typeof a.limitation === "string") attachments.push({ slot: slot.slot, attachment: { state: a.state, limitation: a.limitation } });
    else if (a.state === "unsupported" && typeof a.detail === "string") attachments.push({ slot: slot.slot, attachment: { state: a.state, detail: a.detail } });
    else if (fileAttachment(a)) {
      const known = allowed.get(value.id)?.get(slot.slot);
      if (!known || !sameFile(a, known)) return null;
      attachments.push({ slot: slot.slot, attachment: known });
    } else return null;
  }
  const precision = value.timestamp.precision;
  if (precision !== "unknown" && precision !== "display-only" && precision !== "minute" && precision !== "date" && precision !== "instant") return null;
  return { id: value.id, text: value.text, sourceBaseline: value.sourceBaseline, sequence: value.sequence, attachments,
    sender: { name: value.sender.name, key: value.sender.key }, timestamp: { display: value.timestamp.display, precision, timeZone: value.timestamp.timeZone, instant: value.timestamp.instant } };
}
function captured(value: unknown, expected: OpenChat, allowed: KnownMedia): CollectedChat {
  if (!record(value) || !openChat(value.chat) || value.chat.accountId !== expected.accountId || value.chat.chatId !== expected.chatId ||
      !Array.isArray(value.messages) || value.messages.length > 500 || typeof value.stopReason !== "string" || typeof value.contiguous !== "boolean" ||
      (value.order !== "verified" && value.order !== "unknown") || !Array.isArray(value.deletedIds) || !value.deletedIds.every((entry) => typeof entry === "string")) throw new Error("The source returned an invalid or different conversation.");
  const messages: ObservedMessage[] = [];
  for (const entry of value.messages) { const next = observation(entry, allowed); if (!next) throw new Error("A source message failed validation."); messages.push(next); }
  return { chat: value.chat, messages, order: value.order, contiguous: value.contiguous, stopReason: value.stopReason, deletedIds: value.deletedIds };
}

async function collect(chat: Chat, limit: number, scope: "visible" | "loaded", previous: ChatExport | null, mode: "download" | "edit"): Promise<CollectedChat> {
  const known = knownMedia(previous), allowed = new Map([...known].map(([messageId, slots]) => [messageId, new Map(slots)]));
  const buried = new Set(previous?.tombstones.map((entry) => entry.messageId) ?? []);
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  tabs.sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)));
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    let reply: unknown;
    try { reply = await chrome.tabs.sendMessage(tab.id, { protocol: APP_PROTOCOL, type: "account" }); } catch { continue; }
    if (!record(reply) || reply.ok !== true || reply.accountId !== chat.accountId) continue;
    if (stopped || !chat.selected) throw new Error("Stopped before opening the selected conversation.");
    const port = chrome.tabs.connect(tab.id, { name: APP_PROTOCOL }); collection = port;
    return new Promise((resolve, reject) => {
      let settled = false, staging = false, mediaBytes = 0;
      const mediaRequests = new Set<string>(), mediaSlots = new Set<string>();
      const finish = (error: Error | null, value?: CollectedChat) => {
        if (settled) return; settled = true; clearTimeout(timeout); collection = null; port.disconnect();
        if (error) reject(error); else if (value) resolve(value);
      };
      const timeout = setTimeout(() => { stopped = true; finish(new Error("WhatsApp navigation or collection reached its time budget. Start again explicitly.")); }, 85_000);
      port.onMessage.addListener((message: unknown) => {
        if (!record(message) || settled) return;
        if (message.type === "media") {
          const requestId = message.requestId;
          if (typeof requestId !== "string" || !id(requestId)) { finish(new Error("An attachment transfer has no valid request identity.")); return; }
          const acknowledge = (payload: Record<string, unknown>) => {
            if (!settled && !stopped && collection === port && chat.selected) port.postMessage({ type: "media-ack", requestId, ...payload });
          };
          if (staging || stopped || collection !== port || !chat.selected || mediaRequests.has(requestId)) {
            acknowledge({ ok: false, reason: "Attachment transfer was stopped or repeated." }); return;
          }
          mediaRequests.add(requestId); staging = true;
          void (async () => {
            try {
              if (typeof message.messageId !== "string" || message.messageId.length > 512 ||
                  /[\r\n\0]/u.test(message.messageId) || /^(?:true|false)_([^_]+)_\S+$/u.exec(message.messageId)?.[1] !== chat.chatId || buried.has(message.messageId) ||
                  typeof message.slot !== "number" || !Number.isSafeInteger(message.slot) || message.slot < 1 || message.slot > 32 ||
                  typeof message.name !== "string" || !message.name || message.name.length > 256 || /[\x00-\x1f\x7f/\\:]/u.test(message.name) ||
                  (message.mediaType !== null && (typeof message.mediaType !== "string" || message.mediaType.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(message.mediaType))) ||
                  typeof message.base64 !== "string") throw new Error("Attachment metadata does not match the selected conversation.");
              const slotKey = `${message.messageId}\0${message.slot}`;
              if (mediaSlots.has(slotKey) || mediaSlots.size >= MAX_MEDIA_FILES) throw new Error("An attachment slot was repeated or exceeded the file limit.");
              mediaSlots.add(slotKey);
              const bytes = decodeMediaBase64(message.base64);
              mediaBytes += bytes.length;
              if (mediaBytes > MAX_MEDIA_BYTES) throw new Error("Attachment transfers exceed 32 MiB for this pass.");
              const file = await stageMedia(bytes, message.name, message.mediaType);
              if (settled || stopped || collection !== port || !chat.selected) return;
              const attachment = stagedAttachment(file), slots = allowed.get(message.messageId) ?? new Map<number, FileAttachment>();
              slots.set(message.slot, attachment); allowed.set(message.messageId, slots);
              acknowledge({ ok: true, attachment });
            } catch (error) { acknowledge({ ok: false, reason: errorText(error) }); }
            finally { staging = false; }
          })();
          return;
        }
        if (message.type === "progress" && typeof message.count === "number" && saved?.job) {
          saved.job.count = message.count; void persist().catch(() => finish(new Error("Unable to retain bounded progress."))); return;
        }
        if (message.type === "result") {
          try {
            if (staging) throw new Error("Attachment transfer did not finish before collection ended.");
            const result = captured(message.value, chat, allowed), deleted = new Set(result.deletedIds);
            for (const next of result.messages) {
              if (deleted.has(next.id)) continue;
              for (const [slot, attachment] of known.get(next.id) ?? []) {
                const observed = next.attachments.find((entry) => entry.slot === slot);
                if (!observed || !fileAttachment(observed.attachment)) {
                  next.attachments = [...next.attachments.filter((entry) => entry.slot !== slot), { slot, attachment }].sort((left, right) => left.slot - right.slot);
                }
              }
            }
            finish(null, result);
          } catch (error) { finish(new Error(errorText(error))); }
        }
        if (message.type === "error") {
          if (message.interrupted === true) stopped = true;
          finish(new Error(typeof message.reason === "string" ? message.reason : "WhatsApp collection stopped."));
        }
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        stopped = true;
        finish(new Error("WhatsApp disconnected or collection was stopped. Start again explicitly."));
      });
      const source = catalog.find((candidate) => candidate.accountId === chat.accountId && candidate.chatId === chat.chatId);
      const labels = [...new Set([chatName(chat), ...(source?.aliases ?? []), chat.name])].filter((hint) => hint !== chat.chatId);
      if (!labels.length && /^\d+@(?:c\.us|s\.whatsapp\.net)$/.test(chat.chatId)) labels.push(chat.chatId);
      const hints = labels.filter((hint) => !catalog.some((other) => other.accountId === chat.accountId &&
        other.chatId !== chat.chatId && [other.name, ...other.aliases].includes(hint)) &&
        !saved?.chats.some((other) => other.accountId === chat.accountId && other.chatId !== chat.chatId && other.name === hint));
      port.postMessage({ type: "collect", expected: { accountId: chat.accountId, chatId: chat.chatId, name: chatName(chat) },
        navigationName: hints[0] ?? null, aliases: hints.slice(1), scope, limit, maxMs: 60_000,
        skipIds: [...buried], knownAttachments: [...known].map(([messageId, slots]) => ({ messageId,
          attachments: [...slots].map(([slot, attachment]) => ({ slot, attachment })) })), reuseMedia: mode === "download" });
    });
  }
  throw new Error("Keep WhatsApp Web open and signed in to the selected WhatsApp account, then run Sync again.");
}

function mediaCopy(generation: Generation | null, chat: ChatExport): string {
  const attachments = chat.messages.flatMap((message) => message.attachments);
  if (!attachments.length) return "";
  const unavailable = attachments.filter((entry) => !fileAttachment(entry.attachment)).length;
  return `; ${generation?.media?.length ?? 0} files saved${unavailable ? `; ${unavailable} unavailable` : ""}`;
}

async function verifiedMediaBytes(access: Access, generation: Generation, file: DriveMedia, allowTrashed = false): Promise<Uint8Array | null> {
  const meta = await metadata(access, file.id, allowTrashed), properties = meta.appProperties;
  if (!owner(meta, generation.folderId, operationFor(generation)) || meta.mimeType !== mediaMime(file.mediaType) ||
      !record(properties) || properties.digest !== file.key) throw new Error("A previous attachment changed ownership or revision. Its bytes were preserved.");
  if (allowTrashed && meta.trashed === true) return null;
  const bytes = await readBytes(access, file.id, generation.folderId, operationFor(generation), 8 * 1024 * 1024);
  if (bytes.length !== file.size || await sha256Bytes(bytes) !== file.key) throw new Error("A previous attachment was edited or failed byte verification. Its bytes were preserved.");
  return bytes;
}

async function prepareMedia(access: Access, chat: Chat, output: ChatExport): Promise<StagedMedia[]> {
  const files = new Map<string, StagedMedia>();
  let total = 0;
  for (const entry of output.messages.flatMap((message) => message.attachments)) {
    const attachment = entry.attachment;
    if (!fileAttachment(attachment)) continue;
    const key = /^([0-9a-f]{64})\.[a-z0-9]{1,10}$/.exec(attachment.relativePath)?.[1];
    if (!key) throw new Error("A saved attachment has no verified immutable file identity.");
    const duplicate = files.get(attachment.relativePath);
    if (duplicate) {
      if (duplicate.key !== key || duplicate.mediaType !== attachment.mediaType) throw new Error("Attachment paths have conflicting metadata.");
      continue;
    }
    let bytes: Uint8Array;
    const old = chat.current?.media?.find((file) => file.relativePath === attachment.relativePath && file.key === key);
    if (old && chat.current) {
      const verified = await verifiedMediaBytes(access, chat.current, old);
      if (verified === null) throw new Error("A previous attachment is unavailable. Its export was preserved.");
      bytes = verified;
    } else {
      try { bytes = await readStagedMedia(key); }
      catch (error) { throw new Error("Attachment bytes are unavailable; the previous export was preserved.", { cause: error }); }
    }
    const file = await stageMedia(bytes, attachment.name, attachment.mediaType);
    if (file.key !== key || file.relativePath !== attachment.relativePath) throw new Error("An attachment changed identity while staging.");
    total += file.size;
    if (files.size >= MAX_MEDIA_FILES || total > MAX_MEDIA_BYTES) throw new Error("This generation exceeds 128 files or 32 MiB of attachments. The previous export was preserved.");
    files.set(file.relativePath, file);
  }
  return [...files.values()];
}

async function exportChat(access: Access, chat: Chat, mode: "download" | "edit", scope: "visible" | "loaded", limit: number): Promise<void> {
  if (!saved) return;
  if (chat.deleting) throw new Error("Finish the pending explicit deletion before syncing this export.");
  if (chat.pending) throw new Error("Use Recover to finish the pending generation before another pass.");
  let previous: { markdown: string; metadata: string } | null = null, before: ChatExport | null = null, captureState: ChatExport | null = null;
  if (chat.current) {
    await ensureDestination(access, chat, false);
    previous = await currentFiles(access, chat);
    const decoded = previous ? decodeMetadata(previous.metadata, binding(chat)) : null;
    if (!decoded?.ok) throw new Error("The saved metadata needs recovery. Existing transcript and media were preserved.");
    before = decoded.value;
    const preview = downloadPass({ prefix: "", markdown: previous?.markdown ?? null, chat: before, binding: binding(chat), chatKey: chat.key,
      displayName: chat.name, observed: [], order: "verified", contiguous: false, requestedScope: scope, stopReason: "preflight" });
    if (preview.phase === "paused" || !preview.chat) throw new Error(`Export paused before media retries: ${preview.reason ?? "local edit"}. Existing content was preserved.`);
    captureState = preview.chat;
  }
  saved.job = { phase: "collecting", chatKey: chat.key, count: 0, reason: null }; await persist();
  const observed = await collect(chat, limit, scope, captureState, mode);
  if (stopped || !chat.selected) throw new Error("Stopped before destination writes.");
  await ensureDestination(access, chat);
  const bound = binding(chat);
  const input = { prefix: "", markdown: previous?.markdown ?? null, chat: before, binding: bound,
    chatKey: chat.key, displayName: observed.chat.name, observed: observed.messages, order: observed.order, contiguous: observed.contiguous, requestedScope: scope, stopReason: observed.stopReason };
  const result = mode === "edit" ? editPass({ ...input, deletedIds: observed.deletedIds }) : downloadPass(input);
  if (result.phase === "paused" || result.markdown === null || result.metadata === null || result.chat === null) {
    const conflicts = result.unresolved.length ? ` Blocks: ${result.unresolved.join(", ")}.` : "";
    throw new Error(`Export paused: ${result.reason ?? "source/metadata conflict"}.${conflicts} Existing content was preserved.`);
  }
  chat.result = coverageCopy(result.chat.coverage, result.phase === "unchanged") + mediaCopy(chat.current, result.chat);
  if (result.phase === "unchanged") {
    if (chat.current) for (const file of chat.current.media ?? []) await verifiedMediaBytes(access, chat.current, file);
    await persist(); return;
  }
  if (encoder.encode(result.markdown + result.metadata).byteLength > MAX_PENDING_BYTES) throw new Error("This pass exceeds the 256 KiB pending-save budget. Reduce the message limit.");
  const staged = await prepareMedia(access, chat, result.chat);
  const ids = await allocate(access, 3 + staged.length);
  if (!ids[0] || !ids[1] || !ids[2]) throw new Error("Drive did not allocate generation IDs.");
  const media: DriveMedia[] = [];
  for (const [index, file] of staged.entries()) {
    const allocated = ids[index + 3];
    if (!allocated) throw new Error("Drive did not allocate an attachment ID.");
    media.push({ ...file, id: allocated });
  }
  chat.pending = { operationId: crypto.randomUUID(), target: { folderId: ids[0], markdownId: ids[1], metadataId: ids[2], media }, markdown: result.markdown,
    metadata: result.metadata, beforeHash: previous ? await digest(JSON.stringify([previous.markdown, previous.metadata])) : null, stage: "prepared" };
  saved.job.phase = "saving"; await persist(); await publish(access, chat);
}

async function runSelected(expected: string, mode: "download" | "edit", scope: "visible" | "loaded", limit: number, keys: readonly string[]): Promise<void> {
  try {
    const access = await accessFor(expected);
    await pruneStagedMedia(pendingMediaKeys());
    for (const chat of saved?.chats.filter((entry) => keys.includes(entry.key)) ?? []) {
      if (stopped) break;
      if (!chat.selected) continue;
      try { await exportChat(access, chat, mode, scope, limit); }
      catch (error) { chat.result = `${chat.pending ? "Recovery required" : "Paused"}: ${errorText(error)}`; await persist(); }
    }
  } catch (error) {
    for (const chat of saved?.chats.filter((entry) => keys.includes(entry.key)) ?? []) chat.result = `Paused: ${errorText(error)}`;
  } finally {
    active = false; collection?.disconnect(); collection = null;
    if (saved) saved.job = null;
    await persist();
  }
}

export async function handleApp(message: AppRequest): Promise<AppReply> {
  try {
    await state();
    if (!saved) throw new Error("Saved state is unavailable.");
    if (message.type === "state") {
      if (!drive && !active) { drive = await handleDrive({ protocol: "wa-scribe.t03", type: "restore" }); revision += 1; }
    } else if (message.type === "stop") {
      stopped = true; collection?.disconnect(); collection = null;
      if (saved.job) saved.job.reason = "Stopping; an in-flight destination request may still complete.";
      await persist();
    } else if (message.type === "select") {
      if (typeof message.selected !== "boolean") throw new Error("Invalid selection.");
      const key = stringField(message, "key");
      let chat = saved.chats.find((entry) => entry.key === key);
      if (!chat) {
        const source = catalog.find((entry) => entry.key === key);
        if (!source || !message.selected) throw new Error("This chat is no longer in the discovered list. Refresh and select it again.");
        chat = registerChat(source, source.key);
      }
      chat.selected = message.selected;
      if (!chat.selected && saved.job?.chatKey === chat.key) { stopped = true; collection?.disconnect(); }
      await persist();
    } else if (active) throw new Error("An operation is already running. Use Stop or Refresh.");
    else if (message.type === "discover") {
      active = true;
      try { await discoverChats(); }
      finally { active = false; }
    } else if (message.type === "connect" || message.type === "probe") {
      active = true;
      try {
        drive = await handleDrive({ protocol: "wa-scribe.t03", type: message.type === "connect" ? "connect" : "probe",
          ...(message.type === "probe" ? { expectedAccountId: stringField(message, "expectedAccountId") } : {}),
          ...(typeof message.ackPendingId === "string" ? { ackPendingId: message.ackPendingId } : {}) });
        revision += 1;
      } finally { active = false; }
    } else if (message.type === "add-current") {
      const source = await activeChat();
      const chat = registerChat(source);
      chat.name = source.name; chat.selected = true;
      await persist();
    } else if (message.type === "sync") {
      const expected = stringField(message, "expectedAccountId");
      const mode = message.mode, scope = message.scope, limit = message.limit;
      if ((mode !== "download" && mode !== "edit") || (scope !== "visible" && scope !== "loaded") || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid mode, history scope or message limit.");
      if (!saved.chats.some((chat) => chat.selected)) throw new Error("Select a chat first.");
      if (drive?.account?.permissionId !== expected) throw new Error("Review the connected Google account first.");
      const keys = saved.chats.filter((chat) => chat.selected).map((chat) => chat.key);
      active = true; stopped = false; saved.job = { phase: "starting", chatKey: null, count: 0, reason: null };
      try { await persist(); } catch (error) { active = false; saved.job = null; throw error; }
      void runSelected(expected, mode, scope, limit, keys).catch(() => { active = false; if (saved) saved.job = null; });
    } else if (message.type === "recover") {
      const chat = selectedChat(message);
      if (!chat.driveAccountId) throw new Error("This chat has no Drive export to recover.");
      if (stringField(message, "expectedAccountId") !== chat.driveAccountId) throw new Error("Connect and review the Google account bound to this export before recovery.");
      active = true; stopped = false;
      try {
        const access = await accessFor(chat.driveAccountId);
        if (chat.pending) await publish(access, chat);
        else if (chat.retired.length) {
          await ensureDestination(access, chat); await cleanup(access, chat);
          const current = await currentFiles(access, chat);
          const decoded = current ? decodeMetadata(current.metadata, binding(chat)) : null;
          if (!decoded?.ok) throw new Error("Current coverage could not be verified after cleanup.");
          chat.result = `${coverageCopy(decoded.value.coverage)}; ${chat.retired.length ? "previous generation cleanup pending" : "cleanup finished"}`;
        }
        else throw new Error("This export has no pending generation or cleanup to recover.");
        await persist();
      }
      finally { active = false; }
    } else if (message.type === "fresh") {
      const chat = selectedChat(message);
      if (chat.pending || chat.deleting || chat.retired.length) throw new Error("Recover the pending save or cleanup, or complete deletion, before choosing a fresh export. Staged data was preserved.");
      if (stringField(message, "expectedAccountId") !== drive?.account?.permissionId) throw new Error("Review the currently connected Google account before choosing a fresh destination.");
      if (chat.rootId && chat.driveAccountId) chat.archives.push({ accountId: chat.driveAccountId, rootId: chat.rootId, generation: chat.generation,
        ...(chat.current ? { exportId: chat.current.folderId } : {}) });
      chat.generation = crypto.randomUUID(); chat.rootId = null; chat.rootReady = false; chat.current = null; chat.pending = null; chat.driveAccountId = null; chat.retired = [];
      chat.result = "Fresh export selected; previous tree preserved; old tombstones were not inherited"; chat.lastSuccess = null; await persist();
    } else if (message.type === "delete") {
      const chat = selectedChat(message);
      if (stringField(message, "confirmation") !== chat.key) throw new Error("Confirm deletion of this exact export first.");
      if (chat.pending) throw new Error("Resolve the pending generation before deleting this export.");
      if (!chat.rootId || !chat.driveAccountId) throw new Error("No current export exists.");
      if (stringField(message, "expectedAccountId") !== chat.driveAccountId) throw new Error("Connect and review this export's Google account before deleting.");
      active = true; stopped = false;
      try {
        const access = await accessFor(chat.driveAccountId);
        const root = saved.roots.find((entry) => entry.accountId === chat.driveAccountId);
        if (!root) throw new Error("Export root ownership is unavailable.");
        if (!owner(await metadata(access, root.id), null, root.operationId) ||
            !owner(await metadata(access, chat.rootId), root.id, chat.generation)) throw new Error("The destination folder moved or changed ownership. Deletion paused.");
        chat.deleting = true; await persist();
        if (chat.current) await deleteGeneration(access, chat.current, chat.rootId, true);
        for (const old of chat.retired) await deleteGeneration(access, old, chat.rootId, true);
        chat.archives.push({ accountId: chat.driveAccountId, rootId: chat.rootId, generation: chat.generation, deleted: true });
        chat.rootId = null; chat.rootReady = false; chat.current = null; chat.driveAccountId = null; chat.generation = crypto.randomUUID(); chat.selected = false;
        chat.deleting = false; chat.retired = []; chat.result = "Owned export files moved to Drive trash; foreign files and earlier destinations were untouched"; chat.lastSuccess = null; await persist();
      } catch (error) {
        chat.result = "Delete incomplete — retry Delete after reconnecting; no sync will resume"; await persist(); throw error;
      } finally { active = false; }
    }
    return { ok: true, state: publicState() };
  } catch (error) { return { ok: false, error: errorText(error), state: publicState() }; }
}
