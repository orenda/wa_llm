import { chromium, type BrowserContext } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { capturePass, inspectPage, listChats, openChat } from "./browser";
import { createStore, type LocalStore } from "./store";
import type { OpenChat } from "../src/whatsapp";

type Chat = OpenChat & { key: string; aliases: string[]; selected: boolean; result: string };
const execute = promisify(execFile), appDirectory = join(homedir(), "Library", "Application Support", "wa-scribe");
const profile = join(appDirectory, "chromium"), configPath = join(appDirectory, "local.json");
const binaryDirectory = dirname(fileURLToPath(import.meta.url));
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const errorText = (error: unknown) => error instanceof Error
  ? error.message.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r?\nCall log:[\s\S]*$/u, "").trim()
  : "The local operation failed.";
const label = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/u.test(value);
const jid = (value: unknown): value is string => typeof value === "string" && /^\d+(?:-\d+)?(?::\d+)?@(?:c\.us|g\.us|lid|s\.whatsapp\.net)$/.test(value) && value.length <= 256;
function chatKey(accountId: string, chatId: string): string { return createHash("sha256").update(JSON.stringify([accountId, chatId])).digest("hex").slice(0, 16); }
function chatRecord(value: unknown): value is Chat {
  return record(value) && jid(value.accountId) && jid(value.chatId) && label(value.name) && typeof value.key === "string" &&
    value.key === chatKey(value.accountId, value.chatId) && Array.isArray(value.aliases) && value.aliases.length <= 6 && value.aliases.every(label) &&
    typeof value.selected === "boolean" && typeof value.result === "string";
}

async function start(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("This prototype launcher targets macOS.");
  const arguments_ = process.argv.slice(2);
  if (arguments_.length && (arguments_.length !== 2 || arguments_[0] !== "--output" || !arguments_[1])) throw new Error("Usage: wa-scribe [--output /absolute/export/folder]");
  await mkdir(appDirectory, { recursive: true, mode: 0o700 });
  let output = join(homedir(), "Documents", "wa-scribe"), registered: Chat[] = [];
  try {
    const value: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (!record(value) || value.schema !== 1 || typeof value.output !== "string" || !Array.isArray(value.chats) ||
        value.chats.length > 100 || !value.chats.every(chatRecord)) throw new Error("Local settings are invalid. Preserve the profile and export files for recovery.");
    output = value.output; registered = value.chats;
  } catch (error) { if (!(record(error) && error.code === "ENOENT")) throw error; }
  output = resolve(arguments_[1] ?? output);
  const canonicalApp = await realpath(appDirectory);
  const separateOutput = async (candidate: string) => {
    await mkdir(resolve(candidate), { recursive: true });
    const path = await realpath(resolve(candidate));
    if (path === canonicalApp || path.startsWith(canonicalApp + sep) || canonicalApp.startsWith(path + sep)) throw new Error("Choose an export folder separate from the browser profile and local settings.");
    return path;
  };
  output = await separateOutput(output);
  let startingStore: Promise<LocalStore> | undefined, startingBrowser: Promise<BrowserContext> | undefined;
  let interruptedStartup = false;
  const stopStartup = () => {
    interruptedStartup = true;
    void (async () => {
      const browser = await startingBrowser?.catch(() => null);
      try { await browser?.close(); }
      finally { await (await startingStore?.catch(() => null))?.close(); }
    })().catch((cause: unknown) => { console.error(errorText(cause)); process.exitCode = 1; });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stopStartup);
  let store: LocalStore, context: BrowserContext;
  try {
    startingStore = createStore(output); store = await startingStore;
    if (interruptedStartup) { await store.close(); return; }
    startingBrowser = chromium.launchPersistentContext(profile, { headless: false, acceptDownloads: true, viewport: { width: 1200, height: 850 } });
    context = await startingBrowser;
    if (interruptedStartup) { await context.close(); await store.close(); return; }
  } catch (cause) {
    await (await startingStore?.catch(() => null))?.close();
    throw cause;
  } finally { for (const signal of ["SIGINT", "SIGTERM"] as const) process.removeListener(signal, stopStartup); }
  let available: Chat[] = [], loggedIn = false, running = false, busy = false, shuttingDown = false;
  let error: string | null = null, progress = "Link WhatsApp in its browser tab, then Refresh chats.";
  let controller: AbortController | null = null, job: Promise<void> | null = null;
  let actionDone: Promise<void> = Promise.resolve();
  const lifetime = new AbortController();
  const persist = async () => {
    const temporary = join(appDirectory, `.settings-${randomUUID()}`), handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ schema: 1, output, chats: registered })); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, configPath);
  };
  const chats = () => [...registered.map((chat) => {
    const cached = available.find((item) => item.key === chat.key);
    return cached && cached.name !== cached.chatId ? { ...chat, name: cached.name, aliases: cached.aliases } : chat;
  }), ...available.filter((item) => !registered.some((known) => known.key === item.key))];
  const state = () => ({ running: running || busy, output, loggedIn, chats: chats(), error, progress });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true; controller?.abort(); lifetime.abort();
    try { await context.close(); await actionDone; await job; }
    finally { await store.close(); }
  };
  const close = () => { void shutdown().catch((cause: unknown) => { console.error(errorText(cause)); process.exitCode = 1; }); };
  context.on("close", close);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, close);
  try {
    context.setDefaultTimeout(15_000);
    await context.addInitScript({ path: join(binaryDirectory, "page.js") });
    const panel = context.pages()[0] ?? await context.newPage(), whatsapp = await context.newPage();
    const panelUrl = pathToFileURL(join(binaryDirectory, "panel.html")).href;
    const account = async () => {
      if (whatsapp.isClosed() || !whatsapp.url().startsWith("https://web.whatsapp.com/")) return null;
      return whatsapp.evaluate(() => document.querySelector("#pane-side") ? window.waScribeLocal?.account() ?? null : null);
    };
    const remember = async (source: Chat) => {
      const previous = registered.find((item) => item.key === source.key);
      if (previous) Object.assign(previous, source);
      else { if (registered.length >= 100) throw new Error("This prototype supports 100 registered chats."); registered.push(source); }
      await persist();
    };
    const restoreStatuses = async () => {
      for (const chat of registered) {
        try { const prior = await store.preflight(chat); chat.result = prior.chat ? "Saved locally; start Sync explicitly." : "Not synced to this folder."; }
        catch (cause) { chat.result = errorText(cause); }
      }
    };
    await restoreStatuses();

    const sync = async (targets: Chat[]) => {
      const currentStore = store;
      try {
        for (const target of targets) {
          if (controller?.signal.aborted) break;
          progress = `Opening ${target.name}`;
          try {
            const before = await currentStore.preflight(target);
            const names = [target.name, ...target.aliases].filter((hint) => !chats().some((other) => other.accountId === target.accountId &&
              other.chatId !== target.chatId && [other.name, ...other.aliases].includes(hint)));
            const current = await inspectPage(whatsapp);
            if (!(current.ok && current.chat.accountId === target.accountId && current.chat.chatId === target.chatId) && !names.length) {
              throw new Error("This chat's sidebar label is ambiguous. Its identity was preserved.");
            }
            const opened = await openChat(whatsapp, { ...target, name: names[0] ?? target.name, aliases: names.slice(1) }, controller?.signal);
            progress = `Saving ${opened.name}`;
            const observed = await capturePass(whatsapp, opened, { limit: 50, scope: "visible", ...(controller ? { signal: controller.signal } : {}),
              skipMediaIds: before.skipIds, knownAttachments: before.knownAttachments,
              onProgress: (count) => { progress = `${opened.name}: ${count} rendered messages`; } }, currentStore.stash);
            if (controller?.signal.aborted) throw new Error("Stopped before saving. Start Sync explicitly when ready.");
            const saved = await currentStore.commit(target, observed);
            if (label(opened.name)) target.name = opened.name;
            const files = observed.messages.flatMap((message) => message.attachments);
            target.result = `${saved.status}; ${observed.messages.length} messages observed; ${files.filter((item) => item.attachment.state === "saved" || item.attachment.state === "opaque").length} files observed saved`;
            const unavailable = files.find(({ attachment }) => attachment.state === "unavailable" || attachment.state === "pending" || attachment.state === "unsupported")?.attachment;
            if (unavailable?.state === "unavailable" || unavailable?.state === "pending") target.result += `; Attachment: ${unavailable.limitation}`;
            else if (unavailable?.state === "unsupported") target.result += `; Attachment: ${unavailable.detail}`;
          } catch (cause) { target.result = errorText(cause); }
          await remember(target);
        }
      } catch (cause) { error = errorText(cause); }
      finally { progress = controller?.signal.aborted ? "Sync stopped. Start again explicitly when ready." : "Finished. Review each chat's partial coverage and file results."; running = false; controller = null; }
    };

    await panel.exposeBinding("waScribe", async (source, request: unknown) => {
      if (source.page !== panel || source.frame !== panel.mainFrame() || source.frame.url() !== panelUrl) throw new Error("This local action is only available from the wa-scribe panel.");
      let ownsBusy = false, release: (() => void) | undefined;
      try {
        if (shuttingDown) throw new Error("The local app is closing.");
        if (!record(request) || typeof request.action !== "string") throw new Error("Invalid local action.");
        if (request.action === "state") { loggedIn = (await account()) !== null; return { ok: true, state: state() }; }
        if (request.action === "stop") { controller?.abort(); progress = "Stopping at the next safe boundary."; return { ok: true, state: state() }; }
        if (running || busy) throw new Error("An operation is running. Use Stop and wait before another action.");
        busy = true; ownsBusy = true; error = null;
        actionDone = new Promise<void>((resolve) => { release = resolve; });
        if (request.action === "list") {
          const id = await account();
          if (!id) throw new Error("Link WhatsApp using its QR code, then Refresh chats.");
          const result = await listChats(whatsapp);
          if (!result.ok) throw new Error(result.reason);
          if (await account() !== id) throw new Error("WhatsApp's account changed while listing chats.");
          if (!Array.isArray(result.chats) || result.chats.length > 5000) throw new Error("The local chat list exceeds its supported size.");
          const discovered = result.chats.map((chat) => ({ ...chat, accountId: id, key: chatKey(id, chat.chatId), selected: false, result: "Not synced" }));
          if (!discovered.every(chatRecord)) throw new Error("The local chat list contains unsupported identity or label data.");
          available = discovered;
          const current = await inspectPage(whatsapp);
          if (current.ok && current.chat.accountId === id) {
            const entry = available.find((item) => item.chatId === current.chat.chatId);
            if (entry && label(current.chat.name)) entry.name = current.chat.name;
            else if (!entry && jid(current.chat.chatId) && label(current.chat.name)) available.push({ ...current.chat, key: chatKey(id, current.chat.chatId), aliases: [], selected: false, result: "Not synced" });
          }
          loggedIn = true; progress = `${available.length} chats in this browser's local cache.`;
        } else if (request.action === "sync") {
          if (!Array.isArray(request.keys) || !request.keys.length || request.keys.length > 100 || !request.keys.every((key) => typeof key === "string")) throw new Error("Select between 1 and 100 chats.");
          const keys = new Set(request.keys), targets = chats().filter((chat) => keys.has(chat.key)).map((chat) => ({ ...chat, selected: true }));
          if (targets.length !== keys.size) throw new Error("The chat list changed. Refresh and select again.");
          if (registered.length + targets.filter((chat) => !registered.some((prior) => prior.key === chat.key)).length > 100) throw new Error("This prototype supports 100 registered chats.");
          for (const chat of registered) chat.selected = keys.has(chat.key);
          for (const target of targets) await remember(target);
          if (shuttingDown) throw new Error("The local app is closing.");
          controller = new AbortController(); running = true;
          job = sync(targets);
        } else if (request.action === "recover") {
          const target = registered.find((chat) => chat.key === request.key);
          if (!target) throw new Error("No registered chat was selected.");
          const result = await store.recover(target); target.result = result.status; await persist();
        } else if (request.action === "open-folder") {
          const target = request.key === undefined ? undefined : registered.find((chat) => chat.key === request.key);
          if (request.key !== undefined && !target) throw new Error("Sync this chat before opening its export folder.");
          await execute("/usr/bin/open", [await store.folder(target)], { signal: lifetime.signal });
        } else if (request.action === "choose-folder") {
          let chosen: string;
          try { chosen = (await execute("/usr/bin/osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose the wa-scribe export folder")'], { signal: lifetime.signal })).stdout.trim(); }
          catch (cause) { if (record(cause) && typeof cause.stderr === "string" && cause.stderr.includes("(-128)")) return { ok: true, state: { ...state(), running: false } }; throw cause; }
          if (shuttingDown) throw new Error("The local app is closing.");
          const nextOutput = await separateOutput(chosen);
          if (nextOutput !== output) {
            const next = await createStore(nextOutput);
            try { await store.close(); } catch (cause) { await next.close(); throw cause; }
            store = next; output = nextOutput; await restoreStatuses(); await persist();
          }
        } else throw new Error("Unknown local action.");
        return { ok: true, state: { ...state(), running } };
      } catch (cause) { error = errorText(cause); return { ok: false, error, state: { ...state(), running } }; }
      finally { if (ownsBusy) { busy = false; release?.(); } }
    });
    await panel.goto(panelUrl);
    try { await whatsapp.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded", timeout: 30_000 }); }
    catch { error = "WhatsApp could not load. Reload its browser tab when the connection is available."; }
    if (shuttingDown) return;
    if (await account()) await panel.bringToFront();
    console.log("wa-scribe local prototype is open. Exports stay on this Mac. Close Chromium or press Control-C to quit.");
  } catch (cause) { await shutdown(); throw cause; }
}

void start().catch((cause: unknown) => { console.error(errorText(cause)); process.exitCode = 1; });
