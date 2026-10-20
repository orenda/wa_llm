import { afterEach, describe, expect, it, vi } from "vitest";
import { coverageStatus, downloadPass, type ObservedMessage } from "../src/download";
import { decodeMetadata } from "../src/format";
import type { HttpRequest, HttpResult } from "../src/drive";

const boundary = vi.hoisted(() => ({ http: vi.fn<(request: HttpRequest) => Promise<HttpResult>>() }));
vi.mock("../src/chrome-drive", () => ({
  chromeHttp: boundary.http,
  identityToken: async () => ({ ok: true, token: "synthetic-token" }),
  removeToken: async () => undefined,
  handleDrive: async () => ({
    phase: "connected", account: { permissionId: "google-1", emailAddress: "owner@example.test", displayName: "Owner" },
    warning: null, httpStatus: null, pendingId: null,
  }),
}));

const PROTOCOL = "wa-scribe.app";
const EXTENSION_ID = "synthetic-extension";
const FOLDER = "application/vnd.google-apps.folder";
const current = { folderId: "old-generation", markdownId: "old-markdown", metadataId: "old-metadata" };
const binding = { accountId: "wa-1", chatId: "chat-1", destinationId: "google-1:chat-root", generation: "generation-1" };
const observed: ObservedMessage[] = ["m1", "m2"].map((id) => ({
  id, text: `text ${id}`, sourceBaseline: `text ${id}`, sender: { key: "sender-1", name: "Sender" },
  timestamp: { display: "10:30", precision: "display-only", instant: null, timeZone: null }, sequence: "verified", attachments: [],
}));

function chat(overrides: Record<string, unknown> = {}) {
  return {
    key: "registered-1", accountId: binding.accountId, chatId: binding.chatId, name: "Chat", selected: true,
    generation: binding.generation, driveAccountId: "google-1", rootId: "chat-root", rootReady: true,
    current, pending: null, retired: [], deleting: false, archives: [], result: "Saved", lastSuccess: null,
    ...overrides,
  };
}

function seed(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1, roots: [{ accountId: "google-1", id: "desk-root", operationId: "root-operation", ready: true }],
    chats: [chat(overrides)], job: null,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function harness(initial: unknown, stopReason = "visible-window", loseCreate = false) {
  let disk: unknown = structuredClone(initial);
  const files = new Map<string, { meta: Record<string, unknown>; body: string }>();
  const owned = (id: string, parent: string | null, operation: string, mimeType = FOLDER) => ({
    id, parents: parent ? [parent] : [], mimeType, trashed: false,
    appProperties: { waScribe: EXTENSION_ID, operation, digest: "folder" },
  });
  files.set("desk-root", { meta: owned("desk-root", null, "root-operation"), body: "" });
  files.set("chat-root", { meta: owned("chat-root", "desk-root", binding.generation), body: "" });
  files.set(current.folderId, { meta: owned(current.folderId, "chat-root", current.folderId), body: "" });
  files.set(current.markdownId, { meta: owned(current.markdownId, current.folderId, current.folderId, "text/markdown"), body: "old text" });
  files.set(current.metadataId, { meta: owned(current.metadataId, current.folderId, current.folderId, "application/json"), body: "old sidecar" });
  const response = (value: unknown, status = 200): HttpResult => ({ kind: "response", status, bytes: new TextEncoder().encode(JSON.stringify(value)) });
  boundary.http.mockReset();
  boundary.http.mockImplementation(async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/about")) return response({ user: { permissionId: "google-1", emailAddress: "owner@example.test" } });
    if (url.pathname.endsWith("/generateIds")) return response({ ids: ["new-generation", "new-markdown", "new-metadata"] });
    const fileId = url.pathname.split("/").at(-1) ?? "";
    if (request.method === "GET") {
      const file = files.get(fileId);
      if (!file) return response({}, 404);
      return url.searchParams.get("alt") === "media"
        ? { kind: "response", status: 200, bytes: new TextEncoder().encode(file.body) }
        : response(file.meta);
    }
    if (request.method === "PATCH") {
      const file = files.get(fileId);
      if (!file) throw new Error(`Unexpected patch: ${fileId}`);
      file.meta.trashed = true;
      return response({ id: fileId, trashed: true });
    }
    if (request.method !== "POST") throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    if (loseCreate) return { kind: "unknown" };
    let content = new TextDecoder().decode(request.body);
    let body = "";
    if (request.contentType?.startsWith("multipart/related")) {
      const marker = request.contentType.split("boundary=")[1];
      if (!marker) throw new Error("Missing multipart boundary");
      const parts = content.split(`--${marker}`);
      const payload = (part: string | undefined) => {
        if (!part || !part.includes("\r\n\r\n") || !part.endsWith("\r\n")) throw new Error("Invalid multipart part");
        return part.slice(part.indexOf("\r\n\r\n") + 4, -2);
      };
      content = payload(parts[1]); body = payload(parts[2]);
    }
    const meta: unknown = JSON.parse(content);
    if (!record(meta) || typeof meta.id !== "string") throw new Error("Create metadata has no ID");
    if (files.has(meta.id)) return response({}, 409);
    files.set(meta.id, { meta: { ...meta, trashed: false }, body });
    return response({ id: meta.id });
  });
  vi.stubGlobal("chrome", {
    runtime: { id: EXTENSION_ID, getManifest: () => ({ oauth2: { client_id: "1234567890-public.apps.googleusercontent.com" }, key: "A".repeat(120) }) },
    storage: { local: {
      get: async () => ({ waScribeExports: structuredClone(disk) }),
      set: async (value: Record<string, unknown>) => { disk = structuredClone(value.waScribeExports); },
    } },
    tabs: {
      query: async () => [{ id: 1, url: "https://web.whatsapp.com/" }],
      sendMessage: async () => ({ ok: true, chat: { accountId: binding.accountId, chatId: binding.chatId, name: "Chat" } }),
      connect: () => {
        let receive: (value: unknown) => void = () => undefined;
        let disconnected: () => void = () => undefined;
        return {
          onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
          onDisconnect: { addListener: (listener: typeof disconnected) => { disconnected = listener; } },
          disconnect: () => disconnected(),
          postMessage: () => queueMicrotask(() => receive({ type: "result", value: {
            chat: { accountId: binding.accountId, chatId: binding.chatId, name: "Chat" }, messages: observed,
            order: "verified", contiguous: true, stopReason, deletedIds: [],
          } })),
        };
      },
    },
  });
  return { read: () => structuredClone(disk), files, allowCreates: () => { loseCreate = false; } };
}

async function worker() {
  vi.resetModules();
  const service = await import("../src/export-service");
  expect((await service.handleApp({ protocol: PROTOCOL, type: "state" })).ok).toBe(true);
  return service;
}

async function sync(service: Awaited<ReturnType<typeof worker>>) {
  expect((await service.handleApp({ protocol: PROTOCOL, type: "sync", expectedAccountId: "google-1", mode: "download", scope: "visible", limit: 20 })).ok).toBe(true);
  await expect.poll(async () => (await service.handleApp({ protocol: PROTOCOL, type: "state" })).state.job).toBeNull();
  return service.handleApp({ protocol: PROTOCOL, type: "state" });
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("review regressions on the installed export path", () => {
  it("directs Sync only to Recover after a lost create and preserves pending data when fresh is refused", async () => {
    const store = harness(seed({ current: null }), "visible-window", true);
    const service = await worker();
    const pendingRecord = () => {
      const saved = store.read();
      if (!record(saved) || !Array.isArray(saved.chats) || !record(saved.chats[0])) throw new Error("Missing saved chat");
      return saved.chats[0].pending;
    };
    await sync(service);
    const pending = pendingRecord();
    expect(pending).toMatchObject({ target: { folderId: "new-generation", markdownId: "new-markdown", metadataId: "new-metadata" } });

    const retried = await sync(service);
    expect(retried.state.chats[0]?.result).toBe("Recovery required: Use Recover to finish the pending generation before another pass.");
    expect(pendingRecord()).toEqual(pending);

    const beforeFresh = store.read();
    const fresh = await service.handleApp({ protocol: PROTOCOL, type: "fresh", key: "registered-1", expectedAccountId: "google-1" });
    expect(fresh.ok).toBe(false);
    expect(fresh.error).toContain("Recover the pending save");
    expect(store.read()).toEqual(beforeFresh);
  });

  it("retains the only staged pass and IDs when Start fresh is attempted after a lost create and restart", async () => {
    const store = harness(seed({ current: null }), "visible-window", true);
    const service = await worker();
    const failed = await sync(service);
    expect(failed.state.chats[0]?.result).toContain("Recovery required");
    const retained = store.read();
    expect(retained).toMatchObject({ chats: [{ pending: {
      target: { folderId: "new-generation", markdownId: "new-markdown", metadataId: "new-metadata" },
      markdown: expect.stringContaining("text m1"), metadata: expect.stringContaining("visible-window"),
    } }] });
    for (const restarted of [false, true]) {
      const instance = restarted ? await worker() : service;
      const fresh = await instance.handleApp({ protocol: PROTOCOL, type: "fresh", key: "registered-1", expectedAccountId: "google-1" });
      expect(fresh.ok).toBe(false);
      expect(store.read()).toEqual(retained);
    }
    const allocations = boundary.http.mock.calls.filter(([request]) => request.url.includes("/generateIds")).length;
    store.allowCreates();
    const recovered = await (await worker()).handleApp({ protocol: PROTOCOL, type: "recover", key: "registered-1", expectedAccountId: "google-1" });
    expect(recovered.ok).toBe(true);
    expect(recovered.state.chats[0]?.url).toBe("https://drive.google.com/drive/folders/new-generation");
    expect(store.read()).toMatchObject({ chats: [{ pending: null, current: { folderId: "new-generation", markdownId: "new-markdown", metadataId: "new-metadata" } }] });
    expect(retained).toMatchObject({ chats: [{ pending: {
      markdown: store.files.get("new-markdown")?.body, metadata: store.files.get("new-metadata")?.body,
    } }] });
    expect(boundary.http.mock.calls.filter(([request]) => request.url.includes("/generateIds"))).toHaveLength(allocations);
  });

  it.each([{ deleting: true }, { retired: [{ folderId: "retired-generation", markdownId: "retired-markdown", metadataId: "retired-metadata" }] }])("refuses fresh while cleanup or deletion remains unresolved: %j", async (unresolved) => {
    const store = harness(seed(unresolved));
    const service = await worker();
    const retained = store.read();
    expect((await service.handleApp({ protocol: PROTOCOL, type: "fresh", key: "registered-1", expectedAccountId: "google-1" })).ok).toBe(false);
    expect(store.read()).toEqual(retained);
  });

  it("keeps the old generation link and archived root accessible after fresh and restart", async () => {
    harness(seed());
    const service = await worker();
    const fresh = await service.handleApp({ protocol: PROTOCOL, type: "fresh", key: "registered-1", expectedAccountId: "google-1" });
    expect(fresh.ok).toBe(true);
    expect(fresh.state.chats[0]?.url).toBe("https://drive.google.com/drive/folders/old-generation");
    expect(fresh.state.chats[0]?.archives).toContainEqual({ url: "https://drive.google.com/drive/folders/chat-root", accountId: "google-1", generation: binding.generation, deleted: false });
    const restored = await (await worker()).handleApp({ protocol: PROTOCOL, type: "state" });
    expect(restored.state.chats[0]?.url).toBe(fresh.state.chats[0]?.url);
    expect(restored.state.chats[0]?.archives).toEqual(fresh.state.chats[0]?.archives);
  });

  it.each(["visible-window", "message-budget", "byte-budget", "time-budget"])("uses saved %s coverage for panel status and distinguishes an unchanged resync", async (stopReason) => {
    const store = harness(seed({ current: null }), stopReason);
    const service = await worker();
    const first = await sync(service);
    const sidecar = store.files.get("new-metadata")?.body;
    if (!sidecar) throw new Error("No Drive sidecar was committed");
    const decoded = decodeMetadata(sidecar, binding);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("Committed sidecar could not be decoded");
    expect(decoded.value.coverage.stopReason).toBe(stopReason);
    expect(first.state.chats[0]?.result).toContain(`Partial: ${stopReason}`);
    const writes = boundary.http.mock.calls.filter(([request]) => request.method !== "GET").length;
    const repeat = await sync(service);
    expect(repeat.state.chats[0]?.result).toContain(`Unchanged; Partial: ${stopReason}`);
    expect(store.files.get("new-metadata")?.body).toBe(sidecar);
    expect(boundary.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(writes);
  });

  it("retains the folder handle after deleting only the recorded leaf files", async () => {
    const store = harness(seed());
    const service = await worker();
    const deleted = await service.handleApp({ protocol: PROTOCOL, type: "delete", key: "registered-1", confirmation: "registered-1", expectedAccountId: "google-1" });
    expect(deleted.ok).toBe(true);
    expect(store.files.get(current.markdownId)?.meta.trashed).toBe(true);
    expect(store.files.get(current.metadataId)?.meta.trashed).toBe(true);
    expect(store.files.get("chat-root")?.meta.trashed).toBe(false);
    expect(deleted.state.chats[0]?.url).toBeNull();
    expect(deleted.state.chats[0]?.archives).toContainEqual({ url: "https://drive.google.com/drive/folders/chat-root", accountId: "google-1", generation: binding.generation, deleted: true });
    const restored = await (await worker()).handleApp({ protocol: PROTOCOL, type: "state" });
    expect(restored.state.chats[0]?.archives).toEqual(deleted.state.chats[0]?.archives);
  });

  it("names the edited message block while preserving its wording and avoiding writes", async () => {
    const store = harness(seed({ current: null }));
    const service = await worker();
    await sync(service);
    const transcript = store.files.get("new-markdown");
    if (!transcript) throw new Error("No transcript was committed");
    transcript.body = transcript.body.replace("text m1", "edit m1");
    const edited = transcript.body;
    const writes = boundary.http.mock.calls.filter(([request]) => request.method !== "GET").length;
    const paused = await sync(service);
    expect(paused.state.chats[0]?.result).toContain("local-edit");
    expect(paused.state.chats[0]?.result).toContain("m1");
    expect(transcript.body).toBe(edited);
    expect(boundary.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(writes);
  });
});

describe("bounded scope coverage", () => {
  it.each(["visible", "loaded"])("treats a legacy %s sidecar with a null stop reason as partial", (requestedScope) => {
    expect(coverageStatus({ requestedScope, stopReason: null, segments: [], gaps: [] })).toBe("partial");
  });

  it.each([undefined, "visible-window", "message-budget", "byte-budget", "time-budget"])("records the collector stop reason %s without inventing a gap", (stopReason) => {
    const first = downloadPass({
      binding, prefix: "", chat: null, markdown: null, chatKey: "registered-1", displayName: "Chat",
      observed, order: "verified", contiguous: true, requestedScope: "visible", ...(stopReason === undefined ? {} : { stopReason }),
    });
    expect(first.phase).toBe("updated");
    expect(first.chat?.sourceOrder).toBe("verified");
    expect(first.chat?.coverage.gaps).toEqual([]);
    expect(first.chat?.coverage.stopReason).toBe(stopReason ?? "visible-window");
  });
});
