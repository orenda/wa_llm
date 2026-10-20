import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeMetadata } from "../src/format";
import type { HttpRequest, HttpResult } from "../src/drive";

const io = vi.hoisted(() => ({
  http: vi.fn<(request: HttpRequest) => Promise<HttpResult>>(),
  bytes: new Map<string, Uint8Array>(),
}));
vi.mock("../src/chrome-drive", () => ({
  chromeHttp: io.http,
  identityToken: async () => ({ ok: true, token: "fixture-token" }),
  removeToken: async () => undefined,
  handleDrive: async () => ({ phase: "connected", account: { permissionId: "google-1", emailAddress: "fixture@example.test", displayName: "Fixture" }, warning: null, httpStatus: null, pendingId: null }),
}));
vi.mock("../src/media-stage", async (original) => {
  const real = await original<typeof import("../src/media-stage")>();
  return {
    ...real,
    stageMedia: async (bytes: Uint8Array, name: string, type: string | null) => {
      const key = await real.sha256Bytes(bytes);
      io.bytes.set(key, new Uint8Array(bytes));
      return real.mediaDescriptor(key, name, type, bytes.length);
    },
    readStagedMedia: async (key: string) => {
      const bytes = io.bytes.get(key);
      if (!bytes) throw new Error("Fixture staged bytes are missing");
      return new Uint8Array(bytes);
    },
    pruneStagedMedia: async (keep: ReadonlySet<string>) => {
      for (const key of io.bytes.keys()) if (!keep.has(key)) io.bytes.delete(key);
    },
  };
});

const APP = "wa-scribe.app", EXTENSION = "fixture-extension", FOLDER = "application/vnd.google-apps.folder";
const source = { accountId: "15551234567@c.us", chatId: "15551110000@c.us", name: "Fixture" };
const messageId = `false_${source.chatId}_0123456789abcdefabcd`;
const binary = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x0a, 0x00, 0xff, 0x80, 0xfe]);
const binding = { ...source, destinationId: "google-1:chat-root", generation: "generation-1" };
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function mediaHarness(loseMediaCreate = false) {
  let disk: unknown = { schema: 1, job: null, roots: [{ accountId: "google-1", id: "desk-root", operationId: "root-operation", ready: true }], chats: [{
    ...source, key: "chat-key", selected: true, generation: binding.generation, driveAccountId: "google-1", rootId: "chat-root", rootReady: true,
    current: null, pending: null, retired: [], deleting: false, archives: [], result: "Not synced", lastSuccess: null,
  }] };
  const files = new Map<string, { meta: Record<string, unknown>; bytes: Uint8Array }>();
  const fileAttempts: { id: string; status: number | "lost" }[] = [];
  let collections = 0, allocations = 0;
  const response = (value: unknown, status = 200): HttpResult => ({ kind: "response", status, bytes: new TextEncoder().encode(JSON.stringify(value)) });
  for (const [id, parent, operation] of [["desk-root", null, "root-operation"], ["chat-root", "desk-root", binding.generation]]) {
    files.set(String(id), { meta: { id, parents: parent ? [parent] : [], mimeType: FOLDER, trashed: false,
      appProperties: { waScribe: EXTENSION, operation, digest: "folder" } }, bytes: new Uint8Array() });
  }
  io.bytes.clear(); io.http.mockReset();
  io.http.mockImplementation(async (request) => {
    const url = new URL(request.url), id = url.pathname.split("/").at(-1) ?? "";
    if (id === "about") return response({ user: { permissionId: "google-1", emailAddress: "fixture@example.test" } });
    if (id === "generateIds") { allocations += 1; return response({ ids: ["new-generation", "new-markdown", "new-sidecar", "new-pdf"] }); }
    if (request.method === "GET") {
      const file = files.get(id);
      if (!file) return response({}, 404);
      return url.searchParams.get("alt") === "media" ? { kind: "response", status: 200, bytes: new Uint8Array(file.bytes) } : response(file.meta);
    }
    if (request.method === "PATCH") { const file = files.get(id); if (!file) throw new Error("Unknown fixture file"); file.meta.trashed = true; return response({ id, trashed: true }); }
    if (request.method !== "POST" || !request.body) throw new Error("Unexpected fixture request");
    let metadataText = new TextDecoder().decode(request.body), bytes = new Uint8Array();
    if (request.contentType?.startsWith("multipart/related")) {
      const marker = request.contentType.split("boundary=")[1];
      if (!marker) throw new Error("Missing multipart boundary");
      const wire = Buffer.from(request.body), separator = Buffer.from("\r\n\r\n"), delimiter = Buffer.from(`\r\n--${marker}`);
      const metadataStart = wire.indexOf(separator) + separator.length, metadataEnd = wire.indexOf(delimiter, metadataStart);
      const bytesStart = wire.indexOf(separator, metadataEnd + delimiter.length) + separator.length;
      const bytesEnd = wire.lastIndexOf(Buffer.from(`\r\n--${marker}--\r\n`));
      if (metadataStart < separator.length || metadataEnd < metadataStart || bytesStart < separator.length || bytesEnd < bytesStart) throw new Error("Invalid multipart body");
      metadataText = wire.subarray(metadataStart, metadataEnd).toString("utf8");
      bytes = new Uint8Array(wire.subarray(bytesStart, bytesEnd));
    }
    const meta: unknown = JSON.parse(metadataText);
    if (!record(meta) || typeof meta.id !== "string") throw new Error("Invalid fixture file metadata");
    const status = files.has(meta.id) ? 409 : 200;
    if (meta.mimeType === "application/pdf") {
      if (!record(disk) || !Array.isArray(disk.chats) || !record(disk.chats[0]) || !record(disk.chats[0].pending)) throw new Error("Media create preceded its durable journal");
      const pending = disk.chats[0].pending;
      expect(pending).toMatchObject({ target: { media: [{ id: meta.id, size: binary.length }] } });
    }
    if (status !== 409) files.set(meta.id, { meta: { ...meta, trashed: false }, bytes });
    if (meta.mimeType === "application/pdf") {
      if (loseMediaCreate) { loseMediaCreate = false; fileAttempts.push({ id: meta.id, status: "lost" }); return { kind: "unknown" }; }
      fileAttempts.push({ id: meta.id, status });
    }
    return response({ id: meta.id }, status);
  });
  vi.stubGlobal("chrome", {
    runtime: { id: EXTENSION, getManifest: () => ({ oauth2: { client_id: "1234567890-public.apps.googleusercontent.com" }, key: "A".repeat(120) }) },
    storage: { local: { get: async () => ({ waScribeExports: structuredClone(disk) }), set: async (value: Record<string, unknown>) => { disk = structuredClone(value.waScribeExports); } } },
    tabs: {
      query: async () => [{ id: 1, url: "https://web.whatsapp.com/" }],
      sendMessage: async () => ({ ok: true, accountId: source.accountId }),
      connect: () => {
        let receive: (message: unknown) => void = () => undefined;
        let disconnect: () => void = () => undefined;
        return {
          onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
          onDisconnect: { addListener: (listener: () => void) => { disconnect = listener; } }, disconnect: () => disconnect(),
          postMessage: (message: unknown) => {
            if (!record(message)) return;
            if (message.type === "collect") {
              collections += 1;
              queueMicrotask(() => receive({ type: "media", requestId: "media-request", messageId, slot: 1, name: "fixture.pdf", mediaType: "application/pdf", base64: Buffer.from(binary).toString("base64") }));
            } else if (message.type === "media-ack") {
              if (message.ok !== true) throw new Error("Fixture original was not staged");
              queueMicrotask(() => receive({ type: "result", value: { chat: source, order: "verified", contiguous: true, stopReason: "visible-window", deletedIds: [], messages: [{
                id: messageId, text: "PDF caption", sourceBaseline: "PDF source revision", sender: { key: null, name: "Fixture" }, sequence: "verified",
                timestamp: { display: "10:30", precision: "display-only", timeZone: null, instant: null }, attachments: [{ slot: 1, attachment: message.attachment }],
              }] } }));
            }
          },
        };
      },
    },
  });
  return { files, fileAttempts, read: () => structuredClone(disk), get collections() { return collections; }, get allocations() { return allocations; } };
}

async function worker() { vi.resetModules(); const service = await import("../src/export-service"); expect((await service.handleApp({ protocol: APP, type: "state" })).ok).toBe(true); return service; }
async function sync(service: Awaited<ReturnType<typeof worker>>) {
  expect((await service.handleApp({ protocol: APP, type: "sync", mode: "download", scope: "visible", limit: 20, expectedAccountId: "google-1" })).ok).toBe(true);
  await expect.poll(async () => (await service.handleApp({ protocol: APP, type: "state" })).state.job).toBeNull();
  return service.handleApp({ protocol: APP, type: "state" });
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("original media on the installed Drive path", () => {
  it("publishes exact binary bytes and a matching saved attachment descriptor", async () => {
    const store = mediaHarness(), service = await worker();
    const result = await sync(service);
    expect(result.state.chats[0]?.result).toMatch(/\b1 files? saved\b/);
    expect(store.files.get("new-pdf")?.bytes).toEqual(binary);
    expect(store.files.get("new-pdf")?.meta.appProperties).toMatchObject({ digest: createHash("sha256").update(binary).digest("hex") });
    const sidecar = store.files.get("new-sidecar"), transcript = store.files.get("new-markdown");
    if (!sidecar || !transcript) throw new Error("A coherent generation was not published");
    const decoded = decodeMetadata(new TextDecoder().decode(sidecar.bytes), binding);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("Saved sidecar was invalid");
    const attachment = decoded.value.messages[0]?.attachments[0]?.attachment;
    expect(attachment).toMatchObject({ state: "saved", name: "fixture.pdf", mediaType: "application/pdf" });
    if (!attachment || attachment.state !== "saved") throw new Error("Original attachment was not saved");
    expect(store.files.get("new-pdf")?.meta.name).toBe(attachment.relativePath);
    expect(new TextDecoder().decode(transcript.bytes)).toContain(`](./${attachment.relativePath})`);
    expect(store.read()).toMatchObject({ chats: [{ pending: null, current: { media: [{ id: "new-pdf", size: binary.length }] } }] });
  });

  it("retains a lost media create and recovers the same ID after a verified 409", async () => {
    const store = mediaHarness(true), service = await worker();
    expect((await sync(service)).state.chats[0]?.result).toContain("Recovery required");
    const pending = store.read(), allocations = store.allocations;
    expect(store.files.get("new-pdf")?.bytes).toEqual(binary);
    expect(store.files.has("new-markdown")).toBe(false);
    expect((await sync(service)).state.chats[0]?.result).toContain("Use Recover");
    expect(store.allocations).toBe(allocations);
    expect(store.collections).toBe(1);
    expect(store.fileAttempts).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toContain(Buffer.from(binary).toString("base64"));
    expect(store.read()).toMatchObject({ chats: [{ pending: expect.any(Object) }] });
    const recovered = await (await worker()).handleApp({ protocol: APP, type: "recover", key: "chat-key", expectedAccountId: "google-1" });
    expect(recovered.ok).toBe(true);
    expect(store.allocations).toBe(allocations);
    expect(store.fileAttempts).toEqual([{ id: "new-pdf", status: "lost" }, { id: "new-pdf", status: 409 }]);
    expect(store.files.get("new-pdf")?.bytes).toEqual(binary);
    expect(pending).toMatchObject({ chats: [{ current: null, pending: { target: { media: [{ id: "new-pdf" }] } } }] });
    expect(store.read()).toMatchObject({ chats: [{ pending: null, current: { media: [{ id: "new-pdf" }] } }] });
  });

  it("rejects a 409 whose bytes changed despite matching ownership and digest metadata", async () => {
    const store = mediaHarness(true), service = await worker();
    await sync(service);
    const uploaded = store.files.get("new-pdf");
    if (!uploaded) throw new Error("Lost create did not reach the fake Drive");
    uploaded.bytes = new Uint8Array([1, 2, 3]);
    const recovered = await (await worker()).handleApp({ protocol: APP, type: "recover", key: "chat-key", expectedAccountId: "google-1" });
    expect(recovered.ok).toBe(false);
    expect(recovered.error).toContain("read-back bytes");
    expect(store.files.has("new-markdown")).toBe(false);
    expect(store.read()).toMatchObject({ chats: [{ current: null, pending: { target: { media: [{ id: "new-pdf" }] } } }] });
  });
});
