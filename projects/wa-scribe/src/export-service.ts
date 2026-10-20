import { chromeHttp, handleDrive, identityToken, removeToken } from "./chrome-drive";
import { downloadPass, type ObservedMessage } from "./download";
import { editPass } from "./edit";
import { alignByOrder, decodeMetadata, parseTranscript } from "./format";
import { bakedOAuth, oauthReady } from "./public-config";
import type { DriveAccount, DriveResult, HttpRequest } from "./drive";
import type { AttachmentSlot, Binding } from "./model";
import type { CollectedChat, OpenChat } from "./whatsapp";

export const APP_PROTOCOL = "wa-scribe.app";
const KEY = "waScribeExports";
const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const MAX_PENDING_BYTES = 256 * 1024;
const encoder = new TextEncoder();
type Generation = { folderId: string; markdownId: string; metadataId: string };
type Pending = {
  operationId: string;
  target: Generation;
  markdown: string;
  metadata: string;
  beforeHash: string | null;
  stage: "prepared" | "folder" | "markdown" | "metadata" | "publish";
};
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
  archives: { accountId: string; rootId: string; generation: string }[];
  result: string;
  lastSuccess: string | null;
};
type Root = { accountId: string; id: string; operationId: string; ready: boolean };
type Job = { phase: string; chatKey: string | null; count: number; reason: string | null };
type SavedState = { schema: 1; roots: Root[]; chats: Chat[]; job: Job | null };
type Access = { token: string; account: DriveAccount };
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value); }
function generation(value: unknown): value is Generation {
  return record(value) && id(value.folderId) && id(value.markdownId) && id(value.metadataId) && new Set([value.folderId, value.markdownId, value.metadataId]).size === 3;
}
function pending(value: unknown): value is Pending {
  return record(value) && id(value.operationId) && generation(value.target) && typeof value.markdown === "string" &&
    typeof value.metadata === "string" && (value.beforeHash === null || typeof value.beforeHash === "string") &&
    ["prepared", "folder", "markdown", "metadata", "publish"].includes(String(value.stage)) &&
    encoder.encode(value.markdown + value.metadata).byteLength <= MAX_PENDING_BYTES;
}
function chatRecord(value: unknown): value is Chat {
  return record(value) && id(value.key) && typeof value.accountId === "string" && typeof value.chatId === "string" &&
    typeof value.name === "string" && typeof value.selected === "boolean" && id(value.generation) &&
    (value.driveAccountId === null || id(value.driveAccountId)) && (value.rootId === null || id(value.rootId)) && typeof value.rootReady === "boolean" && typeof value.deleting === "boolean" &&
    (value.current === null || generation(value.current)) && (value.pending === null || pending(value.pending)) &&
    Array.isArray(value.retired) && value.retired.every(generation) && Array.isArray(value.archives) &&
    value.archives.every((entry) => record(entry) && id(entry.accountId) && id(entry.rootId) && id(entry.generation)) &&
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
    if (encoder.encode(JSON.stringify(saved)).byteLength > 768 * 1024) throw new Error("Pending export storage budget reached. Recover or discard a pending generation before collecting more.");
    await chrome.storage.local.set({ [KEY]: saved });
  });
  await writes;
}

function publicState() {
  return {
    revision, drive, setup: oauthReady(bakedOAuth()), job: saved?.job ?? null,
    chats: (saved?.chats ?? []).map((chat) => ({
      key: chat.key, accountId: chat.accountId, chatId: chat.chatId, name: chat.name,
      selected: chat.selected, result: chat.result, lastSuccess: chat.lastSuccess,
      url: chat.current ? `https://drive.google.com/drive/folders/${chat.current.folderId}` : null,
    })),
  };
}

export function isAppRequest(value: unknown): value is AppRequest {
  return record(value) && value.protocol === APP_PROTOCOL && typeof value.type === "string" &&
    ["state", "connect", "probe", "add-current", "select", "sync", "stop", "recover", "fresh", "delete"].includes(value.type);
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
async function create(access: Access, fileId: string, name: string, parent: string | null, operation: string, body: string | null, mimeType = FOLDER): Promise<void> {
  if (stopped) throw new Error("Stopped before the next destination mutation. Recover any staged generation explicitly.");
  const hash = body === null ? "folder" : await digest(body);
  const meta = { id: fileId, name, mimeType, ...(parent ? { parents: [parent] } : {}), appProperties: { waScribe: chrome.runtime.id, operation, digest: hash } };
  let request: Omit<HttpRequest, "token">;
  if (body === null) request = { method: "POST", url: `${FILES}?fields=id`, contentType: "application/json", body: encoder.encode(JSON.stringify(meta)) };
  else {
    const boundary = `wa_${crypto.randomUUID()}`;
    const payload = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--\r\n`;
    request = { method: "POST", url: `${UPLOAD}?uploadType=multipart&fields=id`, contentType: `multipart/related; boundary=${boundary}`, body: encoder.encode(payload) };
  }
  const response = await http(access, request);
  if (response.status !== 200 && response.status !== 201 && response.status !== 409) throw new Error(`Drive create stopped (HTTP ${response.status}). Recover the retained operation before trying a new pass.`);
  const received = await metadata(access, fileId);
  const properties = received.appProperties;
  if (!owner(received, parent, operation) || received.mimeType !== mimeType || !record(properties) || properties.digest !== hash) throw new Error("An allocated Drive ID has different ownership or content. Recovery paused.");
  if (body !== null && await read(access, fileId, parent, operation) !== body) throw new Error("Drive read-back bytes do not match the staged file. Recovery paused.");
}

async function read(access: Access, fileId: string, parent: string | null, operation: string): Promise<string> {
  const meta = await metadata(access, fileId);
  if (!owner(meta, parent, operation)) throw new Error("A file is outside its bound export tree. No write was made.");
  const response = await http(access, { method: "GET", url: `${FILES}/${fileId}?alt=media`, maxResponseBytes: MAX_PENDING_BYTES });
  if (response.status !== 200) throw new Error(`Drive read failed (HTTP ${response.status}).`);
  return new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
}
function operationFor(g: Generation): string { return g.folderId; }
function binding(chat: Chat): Binding {
  if (!chat.rootId || !chat.driveAccountId) throw new Error("This export has no bound destination.");
  return { accountId: chat.accountId, chatId: chat.chatId, destinationId: `${chat.driveAccountId}:${chat.rootId}`, generation: chat.generation };
}
async function ensureDestination(access: Access, chat: Chat): Promise<void> {
  if (!saved) throw new Error("State is unavailable.");
  if (chat.driveAccountId && chat.driveAccountId !== access.account.permissionId) throw new Error("This export belongs to a different Google account. Reconnect it, or explicitly start a fresh export.");
  let root = saved.roots.find((entry) => entry.accountId === access.account.permissionId);
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
  const previous = await currentFiles(access, chat);
  if ((previous ? await digest(JSON.stringify([previous.markdown, previous.metadata])) : null) !== p.beforeHash) throw new Error("The saved export changed after capture. Finish editing and start a fresh pass; pending files were preserved.");
  const g = p.target;
  p.stage = "folder"; await persist();
  await create(access, g.folderId, `export-${p.operationId}`, chat.rootId, operationFor(g), null);
  p.stage = "markdown"; await persist();
  await create(access, g.markdownId, "transcript.md", g.folderId, operationFor(g), p.markdown, "text/markdown");
  p.stage = "metadata"; await persist();
  await create(access, g.metadataId, "sync.json", g.folderId, operationFor(g), p.metadata, "application/json");
  p.stage = "publish"; await persist();
  const recheck = await currentFiles(access, chat);
  if ((recheck ? await digest(JSON.stringify([recheck.markdown, recheck.metadata])) : null) !== p.beforeHash) throw new Error("The saved export changed during the pass. The prior export remains current.");
  if (stopped) throw new Error("Stopped before publication. Recover the staged generation explicitly.");
  const old = chat.current;
  chat.current = g; chat.pending = null; chat.lastSuccess = new Date().toISOString();
  if (old) chat.retired.push(old);
  await persist();
  // Cleanup is separate from commit; an unknown delete cannot resurrect or overwrite current IDs.
  await cleanup(access, chat);
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
async function deleteGeneration(access: Access, g: Generation, parent: string): Promise<void> {
  if (!owner(await metadata(access, g.folderId, true), parent, operationFor(g))) throw new Error("Generation ownership changed; deletion paused.");
  await trash(access, g.markdownId, g.folderId, operationFor(g));
  await trash(access, g.metadataId, g.folderId, operationFor(g));
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

function observation(value: unknown): ObservedMessage | null {
  if (!record(value) || typeof value.id !== "string" || typeof value.text !== "string" || typeof value.sourceBaseline !== "string" ||
      !record(value.sender) || typeof value.sender.name !== "string" || (value.sender.key !== null && typeof value.sender.key !== "string") ||
      !record(value.timestamp) || typeof value.timestamp.display !== "string" || !["unknown", "display-only", "minute", "date", "instant"].includes(String(value.timestamp.precision)) ||
      (value.timestamp.timeZone !== null && typeof value.timestamp.timeZone !== "string") || (value.timestamp.instant !== null && typeof value.timestamp.instant !== "string") ||
      (value.sequence !== "verified" && value.sequence !== "unknown") || !Array.isArray(value.attachments)) return null;
  const attachments: AttachmentSlot[] = [];
  for (const slot of value.attachments) {
    if (!record(slot) || typeof slot.slot !== "number" || !Number.isSafeInteger(slot.slot) || slot.slot < 1 || !record(slot.attachment)) return null;
    const a = slot.attachment;
    if ((a.state === "pending" || a.state === "unavailable") && typeof a.limitation === "string") attachments.push({ slot: slot.slot, attachment: { state: a.state, limitation: a.limitation } });
    else if (a.state === "unsupported" && typeof a.detail === "string") attachments.push({ slot: slot.slot, attachment: { state: a.state, detail: a.detail } });
    else return null; // Saved paths require actual staged original bytes, not a DOM assertion.
  }
  const precision = value.timestamp.precision;
  if (precision !== "unknown" && precision !== "display-only" && precision !== "minute" && precision !== "date" && precision !== "instant") return null;
  return { id: value.id, text: value.text, sourceBaseline: value.sourceBaseline, sequence: value.sequence, attachments,
    sender: { name: value.sender.name, key: value.sender.key }, timestamp: { display: value.timestamp.display, precision, timeZone: value.timestamp.timeZone, instant: value.timestamp.instant } };
}
function captured(value: unknown, expected: OpenChat): CollectedChat {
  if (!record(value) || !openChat(value.chat) || value.chat.accountId !== expected.accountId || value.chat.chatId !== expected.chatId ||
      !Array.isArray(value.messages) || value.messages.length > 500 || typeof value.stopReason !== "string" || typeof value.contiguous !== "boolean" ||
      (value.order !== "verified" && value.order !== "unknown") || !Array.isArray(value.deletedIds) || !value.deletedIds.every((entry) => typeof entry === "string")) throw new Error("The source returned an invalid or different conversation.");
  const messages: ObservedMessage[] = [];
  for (const entry of value.messages) { const next = observation(entry); if (!next) throw new Error("A source message failed validation."); messages.push(next); }
  return { chat: value.chat, messages, order: value.order, contiguous: value.contiguous, stopReason: value.stopReason, deletedIds: value.deletedIds };
}

async function collect(chat: Chat, limit: number, scope: "visible" | "loaded"): Promise<CollectedChat> {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  for (const tab of tabs) {
    if (!tab.id) continue;
    let current: OpenChat;
    try { current = await inspect(tab.id); } catch { continue; }
    if (current.accountId !== chat.accountId || current.chatId !== chat.chatId) continue;
    const port = chrome.tabs.connect(tab.id, { name: APP_PROTOCOL }); collection = port;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, value?: CollectedChat) => {
        if (settled) return; settled = true; clearTimeout(timeout); collection = null; port.disconnect();
        if (error) reject(error); else if (value) resolve(value);
      };
      const timeout = setTimeout(() => finish(new Error("WhatsApp collection reached its time budget. No automatic resume was scheduled.")), 65_000);
      port.onMessage.addListener((message: unknown) => {
        if (!record(message)) return;
        if (message.type === "progress" && typeof message.count === "number" && saved?.job) {
          saved.job.count = message.count; void persist().catch(() => finish(new Error("Unable to retain bounded progress."))); return;
        }
        if (message.type === "result") { try { finish(null, captured(message.value, chat)); } catch (error) { finish(new Error(errorText(error))); } }
        if (message.type === "error") finish(new Error(typeof message.reason === "string" ? message.reason : "WhatsApp collection stopped."));
      });
      port.onDisconnect.addListener(() => finish(new Error(stopped ? "Stopped by user." : "WhatsApp disconnected. Start again explicitly.")));
      port.postMessage({ type: "collect", expected: current, scope, limit, maxMs: 60_000 });
    });
  }
  throw new Error("Open this selected conversation in WhatsApp Web, then run Sync again. Other chats were not opened by name.");
}

async function exportChat(access: Access, chat: Chat, mode: "download" | "edit", scope: "visible" | "loaded", limit: number): Promise<void> {
  if (!saved) return;
  if (chat.deleting) throw new Error("Finish the pending explicit deletion before syncing this export.");
  if (chat.pending) throw new Error("Recover or explicitly start a fresh export before another pass.");
  saved.job = { phase: "collecting", chatKey: chat.key, count: 0, reason: null }; await persist();
  const observed = await collect(chat, limit, scope);
  if (stopped || !chat.selected) throw new Error("Stopped before destination writes.");
  await ensureDestination(access, chat);
  const previous = await currentFiles(access, chat);
  const bound = binding(chat);
  const decoded = previous ? decodeMetadata(previous.metadata, bound) : null;
  if (decoded && !decoded.ok) throw new Error("The saved metadata needs recovery. Existing transcript and media were preserved.");
  const input = { prefix: "", markdown: previous?.markdown ?? null, chat: decoded?.ok ? decoded.value : null, binding: bound,
    chatKey: chat.key, displayName: observed.chat.name, observed: observed.messages, order: observed.order, contiguous: observed.contiguous, requestedScope: scope };
  const result = mode === "edit" ? editPass({ ...input, deletedIds: observed.deletedIds }) : downloadPass(input);
  if (result.phase === "paused" || result.markdown === null || result.metadata === null) throw new Error(`Export paused: ${result.reason ?? "source/metadata conflict"}. Existing content was preserved.`);
  const limitations = observed.messages.reduce((count, message) => count + message.attachments.length, 0);
  chat.result = `Partial: ${observed.stopReason}; ${observed.messages.length} observed messages${limitations ? `; ${limitations} attachments unavailable` : ""}`;
  if (result.phase === "unchanged") { await persist(); return; }
  if (encoder.encode(result.markdown + result.metadata).byteLength > MAX_PENDING_BYTES) throw new Error("This pass exceeds the 256 KiB pending-save budget. Reduce the message limit.");
  const ids = await allocate(access, 3);
  if (!ids[0] || !ids[1] || !ids[2]) throw new Error("Drive did not allocate generation IDs.");
  chat.pending = { operationId: crypto.randomUUID(), target: { folderId: ids[0], markdownId: ids[1], metadataId: ids[2] }, markdown: result.markdown,
    metadata: result.metadata, beforeHash: previous ? await digest(JSON.stringify([previous.markdown, previous.metadata])) : null, stage: "prepared" };
  saved.job.phase = "saving"; await persist(); await publish(access, chat);
}

async function runSelected(expected: string, mode: "download" | "edit", scope: "visible" | "loaded", limit: number, keys: readonly string[]): Promise<void> {
  try {
    const access = await accessFor(expected);
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
      const chat = selectedChat(message);
      if (typeof message.selected !== "boolean") throw new Error("Invalid selection.");
      chat.selected = message.selected;
      if (!chat.selected && saved.job?.chatKey === chat.key) { stopped = true; collection?.disconnect(); }
      await persist();
    } else if (active) throw new Error("An operation is already running. Use Stop or Refresh.");
    else if (message.type === "connect" || message.type === "probe") {
      active = true;
      try {
        drive = await handleDrive({ protocol: "wa-scribe.t03", type: message.type === "connect" ? "connect" : "probe",
          ...(message.type === "probe" ? { expectedAccountId: stringField(message, "expectedAccountId") } : {}),
          ...(typeof message.ackPendingId === "string" ? { ackPendingId: message.ackPendingId } : {}) });
        revision += 1;
      } finally { active = false; }
    } else if (message.type === "add-current") {
      const source = await activeChat();
      const existing = saved.chats.find((chat) => chat.accountId === source.accountId && chat.chatId === source.chatId);
      if (existing) { existing.name = source.name; existing.selected = true; }
      else {
        if (saved.chats.length >= 100) throw new Error("The registered chat limit is 100.");
        saved.chats.push({ ...source, key: crypto.randomUUID().replaceAll("-", ""), selected: true, generation: crypto.randomUUID(), driveAccountId: null,
          rootId: null, rootReady: false, deleting: false, current: null, pending: null, retired: [], archives: [], result: "Selected — not exported", lastSuccess: null });
      }
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
        else if (chat.retired.length) { await ensureDestination(access, chat); await cleanup(access, chat); }
        else throw new Error("This export has no pending generation or cleanup to recover.");
        chat.result = "Recovered coherent generation; source collection did not resume"; await persist();
      }
      finally { active = false; }
    } else if (message.type === "fresh") {
      const chat = selectedChat(message);
      if (chat.deleting) throw new Error("Complete the pending deletion before choosing a fresh export.");
      if (stringField(message, "expectedAccountId") !== drive?.account?.permissionId) throw new Error("Review the currently connected Google account before choosing a fresh destination.");
      if (chat.rootId && chat.driveAccountId) chat.archives.push({ accountId: chat.driveAccountId, rootId: chat.rootId, generation: chat.generation });
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
        if (chat.current) await deleteGeneration(access, chat.current, chat.rootId);
        for (const old of chat.retired) await deleteGeneration(access, old, chat.rootId);
        chat.rootId = null; chat.rootReady = false; chat.current = null; chat.driveAccountId = null; chat.generation = crypto.randomUUID(); chat.selected = false;
        chat.deleting = false; chat.retired = []; chat.result = "Owned export files moved to Drive trash; foreign files and earlier destinations were untouched"; chat.lastSuccess = null; await persist();
      } catch (error) {
        chat.result = "Delete incomplete — retry Delete after reconnecting; no sync will resume"; await persist(); throw error;
      } finally { active = false; }
    }
    return { ok: true, state: publicState() };
  } catch (error) { return { ok: false, error: errorText(error), state: publicState() }; }
}
