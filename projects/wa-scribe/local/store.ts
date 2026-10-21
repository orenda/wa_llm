import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { downloadPass } from "../src/download";
import { decodeMetadata, encodeExport, parseTranscript } from "../src/format";
import { mediaDescriptor } from "../src/media-stage";
import type { AttachmentSlot, Binding, ChatExport } from "../src/model";
import type { CollectedChat, OpenChat } from "../src/whatsapp";

export type LocalFile = { key: string; relativePath: string; name: string; mediaType: string | null; size: number };
type Hooks = { checkpoint?: (phase: "journal" | "generation" | "published") => Promise<void> };
type Current = { pointer: string | null; markdown: string | null; metadata: string | null; chat: ChatExport | null; hash: string | null };
type Pending = { beforeCurrent: string | null; beforeHash: string | null; target: string; markdown: string; metadata: string; files: LocalFile[] };
type Snapshot = { directory: string; binding: Binding; current: Current };
type Result = { status: string; folder: string };
export type LocalStore = {
  preflight(expected: OpenChat): Promise<{ chat: ChatExport | null; markdown: string | null; skipIds: Set<string>; knownAttachments: Map<string, AttachmentSlot[]> }>;
  stash(bytes: Uint8Array, name: string, mime: string | null): Promise<AttachmentSlot["attachment"]>;
  commit(expected: OpenChat, collected: CollectedChat): Promise<Result>;
  recover(expected: OpenChat): Promise<Result>;
  folder(expected?: OpenChat): Promise<string>;
  close(): Promise<void>;
};
const TEXT_LIMIT = 256 * 1024, FILE_LIMIT = 8 * 1024 * 1024, TOTAL_LIMIT = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEAF = /^([0-9a-f]{64})\.[a-z0-9]{1,10}$/;
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function fail(message: string): never { throw new Error(message); }
function identity(expected: OpenChat): string {
  if (typeof expected.accountId !== "string" || !expected.accountId || typeof expected.chatId !== "string" || !expected.chatId || typeof expected.name !== "string") fail("Unverifiable account or chat identity.");
  return digest(JSON.stringify([expected.accountId, expected.chatId])).slice(0, 16);
}
function folderName(name: string, key: string): string {
  const clean = name.normalize("NFC").replace(/[<>:"/\\|?*\p{Cc}\p{Zl}\p{Zp}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ").replace(/^[. ]+|[. ]+$/gu, "");
  let label = "";
  for (const character of clean) {
    if (Buffer.byteLength(label + character) > 120) break;
    label += character;
  }
  return `${label.replace(/[. ]+$/u, "") || "Chat"}--${key}`;
}
async function directory(path: string, create = false): Promise<void> {
  if (create) { try { await mkdir(path); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; } }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Export directories must be real directories, without symlinks.");
}
async function read(path: string, limit: number): Promise<Uint8Array | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (missing(error)) return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) fail("Export file is invalid or exceeds its size limit.");
    const bytes = await handle.readFile();
    if (bytes.byteLength > limit) fail("Export file grew beyond its size limit.");
    return bytes;
  } finally { await handle.close(); }
}
async function text(path: string, limit = TEXT_LIMIT): Promise<string | null> {
  const bytes = await read(path, limit);
  return bytes === null ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomic(path: string, bytes: string | Uint8Array, exclusive = false): Promise<void> {
  const temporary = join(dirname(path), `.writing-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (exclusive) {
    try { await link(temporary, path); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const installed = await read(path, typeof bytes === "string" ? TEXT_LIMIT : FILE_LIMIT);
      if (installed === null || digest(installed) !== digest(bytes)) fail("Exclusive file publication found different existing content.");
    }
    await unlink(temporary);
  }
  else await rename(temporary, path);
  await syncDirectory(dirname(path));
}
async function immutable(path: string, bytes: string | Uint8Array): Promise<void> {
  const prior = await read(path, typeof bytes === "string" ? TEXT_LIMIT : FILE_LIMIT);
  if (prior !== null) {
    if (digest(prior) !== digest(bytes)) fail("Immutable generation content changed; preserve it for manual recovery.");
  } else await atomic(path, bytes, true);
}
function pairHash(pointer: string, markdown: string, metadata: string): string {
  return digest(JSON.stringify([pointer, markdown, metadata]));
}
function decode(metadata: string, binding: Binding): ChatExport {
  const decoded = decodeMetadata(metadata, binding);
  if (!decoded.ok) fail(`Export metadata requires recovery: ${decoded.reason}.`);
  if (decoded.value.chatKey !== digest(JSON.stringify([binding.accountId, binding.chatId])).slice(0, 16)) fail("Export chat key does not match its bound identity.");
  return decoded.value;
}
function verifyPair(pending: Pending, binding: Binding): ChatExport {
  if (Buffer.byteLength(pending.markdown) + Buffer.byteLength(pending.metadata) > TEXT_LIMIT) fail("Pending transcript exceeds 256 KiB.");
  const chat = decode(pending.metadata, binding), parsed = parseTranscript(pending.markdown);
  if (!parsed.ok) fail("Pending transcript is invalid.");
  const encoded = encodeExport(parsed.value.prefix, chat);
  // Metadata is already validated above; JSON whitespace and field order need not match a re-encoding.
  if (!encoded.ok || encoded.value.markdown !== pending.markdown) fail("Pending transcript and metadata do not match.");
  return chat;
}

export async function createStore(output: string, hooks: Hooks = {}): Promise<LocalStore> {
  const requested = resolve(output);
  await mkdir(requested, { recursive: true });
  await directory(requested);
  const root = await realpath(requested), lock = join(root, ".wa-scribe.lock"), owner = randomUUID();
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") fail("Output is locked. Stop its owning wa-scribe process first; then manually remove .wa-scribe.lock only after confirming no writer is running. Stale locks are never cleared automatically.");
    throw error;
  }
  const lockStat = await lstat(lock);
  const ownerPath = join(lock, "owner"), staging = join(root, ".staging");
  let ownerStat: { dev: number; ino: number } | null = null, ownerComplete = false;
  try {
    const handle = await open(ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      ownerStat = await handle.stat();
      await handle.writeFile(owner); await handle.sync(); ownerComplete = true;
    } finally { await handle.close(); }
    await syncDirectory(lock);
    await directory(staging, true);
    await syncDirectory(root);
  } catch (cause) {
    try {
      const present = await lstat(lock);
      if (!present.isDirectory() || present.isSymbolicLink() || present.dev !== lockStat.dev || present.ino !== lockStat.ino) fail("Initialization lock ownership changed; the foreign lock was preserved.");
      const presentOwner = await lstat(ownerPath).catch((error: unknown) => { if (missing(error)) return null; throw error; });
      if (ownerComplete && presentOwner === null) fail("Initialization owner token disappeared; the lock was preserved.");
      if (presentOwner !== null) {
        // An incomplete owner write has no token yet; its opened inode still proves ownership.
        if (!ownerStat || !presentOwner.isFile() || presentOwner.isSymbolicLink() || presentOwner.dev !== ownerStat.dev || presentOwner.ino !== ownerStat.ino ||
            ownerComplete && await text(ownerPath, 128) !== owner) fail("Initialization owner file changed; the foreign lock was preserved.");
        await unlink(ownerPath);
      }
      const latest = await lstat(lock);
      if (latest.dev !== lockStat.dev || latest.ino !== lockStat.ino || latest.isSymbolicLink()) fail("Initialization lock changed before cleanup; it was preserved.");
      await rmdir(lock);
      await syncDirectory(root);
    } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], "Local store initialization failed and its lock could not be safely released. Stop the owning process before manually reviewing .wa-scribe.lock.", { cause });
    }
    throw cause;
  }
  let closed = false, queue = Promise.resolve(), closing: Promise<void> | undefined;
  const snapshots = new Map<string, Snapshot>();
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.then(async () => {
      if (closed) fail("Local store is closed.");
      const stat = await lstat(lock);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== lockStat.dev || stat.ino !== lockStat.ino || await text(join(lock, "owner"), 128) !== owner) fail("Output lock ownership changed; preserve the foreign lock.");
      return action();
    });
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  async function bound(expected: OpenChat): Promise<{ directory: string; binding: Binding }> {
    const key = identity(expected), preferred = join(root, folderName(expected.name, key));
    const candidates = (await readdir(root)).filter((name) => name === key || name.endsWith(`--${key}`));
    if (candidates.length > 1) fail("Multiple local folders match this chat identity; all were preserved for review.");
    let path = candidates[0] === undefined ? preferred : join(root, candidates[0]);
    await directory(path, true);
    let raw = await text(join(path, "binding.json"));
    if (raw === null) {
      if (candidates.length || (await readdir(path)).length) fail("Chat directory has no binding; existing folders cannot be adopted.");
      const binding: Binding = { accountId: expected.accountId, chatId: expected.chatId, destinationId: randomUUID(), generation: randomUUID() };
      await immutable(join(path, "binding.json"), `${JSON.stringify(binding)}\n`);
      await syncDirectory(root);
      raw = JSON.stringify(binding);
    }
    const value: unknown = JSON.parse(raw);
    if (!record(value) || Object.keys(value).length !== 4 || value.accountId !== expected.accountId || value.chatId !== expected.chatId ||
        typeof value.destinationId !== "string" || !UUID.test(value.destinationId) || typeof value.generation !== "string" || !UUID.test(value.generation)) fail("Chat binding is invalid; existing exports cannot be adopted.");
    if (candidates[0] === key) {
      const target = await lstat(preferred).catch((error: unknown) => { if (missing(error)) return null; throw error; });
      if (target !== null) fail("The named chat folder already exists; both folders were preserved.");
      await directory(path);
      if (await text(join(path, "binding.json")) !== raw) fail("Chat binding changed before folder migration; the existing folder was preserved.");
      await rename(path, preferred);
      await syncDirectory(root);
      path = preferred;
    }
    await directory(join(path, "generations"), true);
    return { directory: path, binding: { accountId: expected.accountId, chatId: expected.chatId, destinationId: value.destinationId, generation: value.generation } };
  }
  async function current(path: string, binding: Binding): Promise<Current> {
    await directory(path); await directory(join(path, "generations"));
    const raw = await text(join(path, "CURRENT"), 128);
    if (raw === null) return { pointer: null, markdown: null, metadata: null, chat: null, hash: null };
    const pointer = raw.trim();
    if (!UUID.test(pointer) || raw !== `${pointer}\n`) fail("CURRENT is invalid; only owned generation identifiers are accepted.");
    const target = join(path, "generations", pointer);
    await directory(target);
    const markdown = await text(join(target, "transcript.md")), metadata = await text(join(target, "sync.json"));
    if (markdown === null || metadata === null) fail("Current generation is incomplete; use Recover.");
    return { pointer, markdown, metadata, chat: decode(metadata, binding), hash: pairHash(pointer, markdown, metadata) };
  }
  async function files(chat: ChatExport, source: string | null, allowStaged = true, retained: ChatExport | null = null): Promise<{ descriptors: LocalFile[]; bytes: Map<string, Uint8Array> }> {
    await directory(staging);
    if (source) await directory(source);
    const descriptors = new Map<string, LocalFile>(), bytes = new Map<string, Uint8Array>();
    const required = new Set(retained?.messages.flatMap((message) => message.attachments.flatMap(({ attachment }) => attachment.state === "saved" || attachment.state === "opaque" ? [attachment.relativePath] : [])) ?? []);
    let total = 0;
    for (const message of chat.messages) for (const { attachment } of message.attachments) {
      if (attachment.state !== "saved" && attachment.state !== "opaque") continue;
      const key = LEAF.exec(attachment.relativePath)?.[1];
      if (!key) fail("Local attachments must use a SHA-256 leaf filename.");
      if (descriptors.has(attachment.relativePath)) continue;
      const prior = source ? await read(join(source, attachment.relativePath), FILE_LIMIT) : null;
      if (required.has(attachment.relativePath) && prior === null) fail("A retained attachment is missing from the current generation.");
      const data = prior ?? (allowStaged ? await read(join(staging, key), FILE_LIMIT) : null);
      if (data === null || digest(data) !== key) fail("Referenced attachment bytes are missing or corrupt; no export was published.");
      const descriptor = mediaDescriptor(key, attachment.name, attachment.mediaType, data.byteLength);
      if (descriptor.relativePath !== attachment.relativePath) fail("Attachment filename does not match its media descriptor.");
      total += data.byteLength;
      if (descriptors.size >= 128 || total > TOTAL_LIMIT) fail("Generation exceeds 128 attachments or 32 MiB.");
      descriptors.set(descriptor.relativePath, descriptor); bytes.set(descriptor.relativePath, data);
    }
    return { descriptors: [...descriptors.values()], bytes };
  }
  async function pending(path: string, binding: Binding): Promise<Pending | null> {
    const raw = await text(join(path, "pending.json"));
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!record(value) || Object.keys(value).length !== 6 || !(value.beforeCurrent === null || typeof value.beforeCurrent === "string" && UUID.test(value.beforeCurrent)) ||
        !(value.beforeHash === null || typeof value.beforeHash === "string" && /^[0-9a-f]{64}$/.test(value.beforeHash)) ||
        (value.beforeCurrent === null) !== (value.beforeHash === null) || typeof value.target !== "string" || !UUID.test(value.target) ||
        typeof value.markdown !== "string" || typeof value.metadata !== "string" || !Array.isArray(value.files) || value.files.length > 128) fail("Pending save is invalid; preserve it for manual recovery.");
    const descriptors: LocalFile[] = [];
    for (const entry of value.files) {
      if (!record(entry) || Object.keys(entry).length !== 5 || typeof entry.key !== "string" || typeof entry.name !== "string" ||
          !(entry.mediaType === null || typeof entry.mediaType === "string") || typeof entry.size !== "number") fail("Pending attachment descriptor is invalid.");
      const descriptor = mediaDescriptor(entry.key, entry.name, entry.mediaType, entry.size);
      if (descriptor.relativePath !== entry.relativePath || descriptor.name !== entry.name || descriptor.mediaType !== entry.mediaType) fail("Pending attachment descriptor changed.");
      descriptors.push(descriptor);
    }
    const result: Pending = { beforeCurrent: value.beforeCurrent, beforeHash: value.beforeHash, target: value.target, markdown: value.markdown, metadata: value.metadata, files: descriptors };
    verifyPair(result, binding);
    return result;
  }
  async function publish(snapshot: Snapshot, journal: Pending): Promise<Result> {
    const { directory: path, binding } = snapshot, target = join(path, "generations", journal.target);
    const present = await current(path, binding);
    if (present.pointer === journal.target) {
      if (present.markdown !== journal.markdown || present.metadata !== journal.metadata) fail("Published generation was edited; recovery preserved the pending save.");
    } else {
      if (present.pointer !== journal.beforeCurrent || present.hash !== journal.beforeHash) fail("Export changed since collection; preserve local edits and pending save.");
      const chat = verifyPair(journal, binding), source = present.pointer ? join(path, "generations", present.pointer) : null;
      if (present.chat) await files(present.chat, source, false);
      const media = await files(chat, source, true, present.chat);
      if (JSON.stringify(media.descriptors) !== JSON.stringify(journal.files)) fail("Pending attachment manifest changed.");
      await directory(target, true);
      for (const [name, bytes] of media.bytes) await immutable(join(target, name), bytes);
      await immutable(join(target, "transcript.md"), journal.markdown);
      await immutable(join(target, "sync.json"), journal.metadata);
      await syncDirectory(target);
      await syncDirectory(join(path, "generations"));
      await files(chat, target, false);
      await hooks.checkpoint?.("generation");
      const latest = await current(path, binding);
      if (latest.pointer !== journal.beforeCurrent || latest.hash !== journal.beforeHash) fail("Export changed before publication; preserve local edits and pending save.");
      if (latest.chat) await files(latest.chat, source, false);
      if (await text(join(target, "transcript.md")) !== journal.markdown || await text(join(target, "sync.json")) !== journal.metadata) fail("Prepared generation changed before publication; preserve the pending save.");
      await files(chat, target, false);
      await atomic(join(path, "CURRENT"), `${journal.target}\n`);
      await hooks.checkpoint?.("published");
    }
    const committed = await current(path, binding);
    if (committed.pointer !== journal.target || committed.markdown !== journal.markdown || committed.metadata !== journal.metadata) fail("Published generation changed; preserve the pending save.");
    const verified = await files(verifyPair(journal, binding), target, false);
    if (JSON.stringify(verified.descriptors) !== JSON.stringify(journal.files)) fail("Published attachment manifest changed.");
    await unlink(join(path, "pending.json"));
    await syncDirectory(path);
    snapshots.delete(binding.accountId + "\0" + binding.chatId);
    return { status: "partial", folder: target };
  }
  return {
    preflight: (expected) => run(async () => {
      const info = await bound(expected);
      if (await text(join(info.directory, "pending.json")) !== null) fail("A pending local save exists. Use Recover before collecting more messages.");
      const saved = await current(info.directory, info.binding);
      if (!saved.pointer && (await readdir(join(info.directory, "generations"))).length) fail("CURRENT is missing from an existing export; preserve generations for manual recovery.");
      const checked = downloadPass({ prefix: "", markdown: saved.markdown, chat: saved.chat, binding: info.binding, chatKey: identity(expected), displayName: expected.name,
        observed: [], order: "verified", contiguous: false, requestedScope: "visible", stopReason: saved.chat?.coverage.stopReason ?? "rendered-window" });
      if (checked.phase === "paused") fail(`Local transcript conflict: ${checked.reason}.`);
      if (saved.chat) await files(saved.chat, saved.pointer ? join(info.directory, "generations", saved.pointer) : null, false);
      snapshots.set(expected.accountId + "\0" + expected.chatId, { ...info, current: saved });
      return { chat: saved.chat ? checked.chat : null, markdown: saved.markdown, skipIds: new Set(checked.chat?.tombstones.map((item) => item.messageId) ?? []),
        knownAttachments: new Map(checked.chat?.messages.map((message) => [message.id, message.attachments]) ?? []) };
    }),
    stash: (bytes, name, mime) => run<AttachmentSlot["attachment"]>(async () => {
      if (bytes.byteLength > FILE_LIMIT) fail("Attachment exceeds 8 MiB.");
      await directory(staging);
      const owned = new Uint8Array(bytes), descriptor = mediaDescriptor(digest(owned), name, mime, owned.byteLength);
      const entries = await readdir(staging);
      let stagedSize = 0;
      if (entries.length > 4096) fail("Attachment staging exceeds 4096 files; preserve pending saves before manual cleanup.");
      for (const entry of entries) {
        if (!/^[0-9a-f]{64}$/.test(entry) && !/^\.writing-[0-9a-f-]{36}$/.test(entry)) fail("Attachment staging contains unknown files; preserve them for manual review.");
        const stat = await lstat(join(staging, entry));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_LIMIT) fail("Attachment staging contains an invalid file.");
        stagedSize += stat.size;
      }
      if (stagedSize + (entries.includes(descriptor.key) ? 0 : owned.byteLength) > 64 * 1024 * 1024 || entries.length === 4096 && !entries.includes(descriptor.key)) fail("Attachment staging exceeds 64 MiB or 4096 files; preserve pending saves before manual cleanup.");
      await immutable(join(staging, descriptor.key), owned);
      return descriptor.mediaType === null ? { state: "opaque", name: descriptor.name, mediaType: null, relativePath: descriptor.relativePath }
        : { state: "saved", name: descriptor.name, mediaType: descriptor.mediaType, relativePath: descriptor.relativePath };
    }),
    commit: (expected, collected) => run(async () => {
      if (identity(expected) !== identity(collected.chat)) fail("Account or chat changed during collection.");
      const snapshot = snapshots.get(expected.accountId + "\0" + expected.chatId);
      if (!snapshot) fail("Run preflight before collecting messages.");
      const info = await bound(expected);
      if (JSON.stringify(info.binding) !== JSON.stringify(snapshot.binding)) fail("Export binding changed since preflight; existing state was preserved.");
      if (await pending(snapshot.directory, snapshot.binding)) fail("A pending local save exists. Use Recover.");
      const now = await current(snapshot.directory, snapshot.binding);
      if (now.pointer !== snapshot.current.pointer || now.hash !== snapshot.current.hash) fail("Export changed since preflight; preserve local edits and collect again.");
      const result = downloadPass({ prefix: "", markdown: now.markdown, chat: now.chat, binding: snapshot.binding, chatKey: identity(expected), displayName: expected.name,
        observed: collected.messages, order: collected.order, contiguous: collected.contiguous, requestedScope: "visible", stopReason: collected.stopReason || "rendered-window" });
      if (result.phase === "paused" || !result.chat || result.markdown === null || result.metadata === null) fail(`Export paused: ${result.reason}.`);
      const source = now.pointer ? join(snapshot.directory, "generations", now.pointer) : null;
      if (now.chat) await files(now.chat, source, false);
      const media = await files(result.chat, source, true, now.chat);
      if (result.phase === "unchanged") {
        await files(result.chat, source, false);
        return { status: "unchanged (partial rendered scope)", folder: source ?? snapshot.directory };
      }
      const journal: Pending = { beforeCurrent: now.pointer, beforeHash: now.hash, target: randomUUID(), markdown: result.markdown, metadata: result.metadata, files: media.descriptors };
      verifyPair(journal, snapshot.binding);
      const serialized = `${JSON.stringify(journal)}\n`;
      if (Buffer.byteLength(serialized) > TEXT_LIMIT) fail("Pending save exceeds its 256 KiB durable journal limit.");
      await atomic(join(snapshot.directory, "pending.json"), serialized);
      await hooks.checkpoint?.("journal");
      return publish(snapshot, journal);
    }),
    recover: (expected) => run(async () => {
      const info = await bound(expected), journal = await pending(info.directory, info.binding);
      if (!journal) {
        const saved = await current(info.directory, info.binding);
        if (!saved.pointer || !saved.chat) fail("No pending local save exists for this chat.");
        const folder = join(info.directory, "generations", saved.pointer);
        await files(saved.chat, folder, false);
        return { status: "unchanged (partial rendered scope)", folder };
      }
      return publish({ ...info, current: await current(info.directory, info.binding) }, journal);
    }),
    folder: (expected) => run(async () => {
      if (!expected) return root;
      const info = await bound(expected), saved = await current(info.directory, info.binding);
      return saved.pointer ? join(info.directory, "generations", saved.pointer) : info.directory;
    }),
    close: () => closing ??= run(async () => {
      const stat = await lstat(lock);
      if (stat.dev !== lockStat.dev || stat.ino !== lockStat.ino || await text(join(lock, "owner"), 128) !== owner) fail("Output lock ownership changed; the foreign lock was preserved.");
      await unlink(join(lock, "owner")); await rmdir(lock); await syncDirectory(root); closed = true;
    }),
  };
}
