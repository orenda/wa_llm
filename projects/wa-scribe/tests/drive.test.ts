import { describe, expect, it } from "vitest";
import {
  DRIVE_FILE_SCOPE,
  DRIVE_PROTOCOL,
  PROBE_JSON,
  PROBE_MARKDOWN,
  PROBE_MARKDOWN_UPDATED,
  PROBE_MEDIA,
  classifyIdentityError,
  connectDrive,
  dispatchDrive,
  panelCopy,
  runProbe,
  unresolvedKey,
  type DriveAccount,
  type HttpClient,
  type HttpRequest,
  type HttpResult,
  type ProbeRecord,
  type ProbeStorage,
  type TokenClient,
  type TokenResult,
} from "../src/drive";
import { readProbeRecord } from "../src/chrome-drive";
import { MAX_BUSY_POLLS, initialPanelView, panelRequest, planPanel } from "../src/panel-state";
import { oauthReady, type PublicOAuth } from "../src/public-config";

const config: PublicOAuth = {
  clientId: "1234567890-abc.apps.googleusercontent.com",
  extensionKey: "A".repeat(120),
};
const account: DriveAccount = { permissionId: "perm-1", emailAddress: "ada@example.com", displayName: "Ada" };
const tokenText = "ya29.test-token";
const encoder = new TextEncoder();

function json(value: unknown): HttpResult {
  return { kind: "response", status: 200, bytes: encoder.encode(JSON.stringify(value)) };
}

function memory(initial: ProbeRecord | null = null): ProbeStorage & { current: () => ProbeRecord | null } {
  let record = initial;
  return {
    get: async () => record,
    set: async (next) => {
      record = next;
    },
    current: () => record,
  };
}

function tokens(result: TokenResult, removed: string[]): TokenClient {
  return {
    get: async () => result,
    remove: async (token) => {
      removed.push(token);
    },
  };
}

function scripted(mode?: { at: number; result: HttpResult }): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const http: HttpClient = async (request) => {
    calls.push(request);
    if (mode && calls.length === mode.at) return mode.result;
    if (request.url.includes("/about")) return json({ user: account });
    if (request.method === "POST" && request.url.includes("/drive/v3/files?") && !request.url.includes("uploadType")) {
      return json({ id: "root-1", name: "wa-scribe test", mimeType: "application/vnd.google-apps.folder" });
    }
    if (request.method === "POST" && request.url.includes("uploadType=multipart")) {
      const body = new TextDecoder().decode(request.body ?? new Uint8Array());
      const name = body.includes("note.md") ? "note.md" : body.includes("meta.json") ? "meta.json" : "dot.bin";
      const id = name === "note.md" ? "file-md" : name === "meta.json" ? "file-json" : "file-bin";
      const mime = name === "note.md" ? "text/markdown" : name === "meta.json" ? "application/json" : "application/octet-stream";
      return json({ id, name, mimeType: mime, parents: ["root-1"] });
    }
    if (request.method === "PATCH") return json({ id: "file-md", name: "note.md", mimeType: "text/markdown" });
    if (request.url.includes("file-md") && request.url.includes("alt=media")) {
      const updated = calls.some((call) => call.method === "PATCH");
      return { kind: "response", status: 200, bytes: encoder.encode(updated ? PROBE_MARKDOWN_UPDATED : PROBE_MARKDOWN) };
    }
    if (request.url.includes("file-json")) return { kind: "response", status: 200, bytes: encoder.encode(PROBE_JSON) };
    if (request.url.includes("file-bin")) return { kind: "response", status: 200, bytes: PROBE_MEDIA };
    if (request.url.includes("/files/root-1")) return json({ id: "root-1", trashed: false, mimeType: "application/vnd.google-apps.folder" });
    return { kind: "response", status: 404, bytes: encoder.encode("{}") };
  };
  return { http, calls };
}

function noToken(result: DriveResultLike): void {
  expect(JSON.stringify(result)).not.toContain(tokenText);
  expect(JSON.stringify(result)).not.toContain("Bearer");
}

type DriveResultLike = { phase: string };

describe("drive probe", () => {
  it("accepts only the drive.file scope and a public client id", () => {
    expect(DRIVE_FILE_SCOPE).toBe("https://www.googleapis.com/auth/drive.file");
    expect(oauthReady(config)).toBe(true);
    expect(oauthReady({ clientId: "", extensionKey: "" })).toBe(false);
    expect(oauthReady({ clientId: "ya29.secret", extensionKey: "A".repeat(120) })).toBe(false);
    expect(classifyIdentityError("The user did not approve access.", true)).toBe("denied");
    expect(classifyIdentityError("OAuth2 not granted or revoked.", false)).toBe("signed-out");
    expect(classifyIdentityError("Invalid credentials", true)).toBe("expired");
  });

  it("does not fetch or create files when setup, consent, or identity is missing", async () => {
    const denied = scripted();
    const removed: string[] = [];
    const missing = await connectDrive({
      config: { clientId: "", extensionKey: "" },
      interactive: true,
      http: denied.http,
      token: tokens({ ok: true, token: tokenText }, removed),
      storage: memory(),
    });
    expect(missing.phase).toBe("missing-setup");
    expect(denied.calls).toHaveLength(0);
    expect(panelCopy(missing).status).toContain("Google setup is missing");

    const noConsent = scripted();
    const refused = await connectDrive({
      config,
      interactive: true,
      http: noConsent.http,
      token: tokens({ ok: false, reason: "denied" }, removed),
      storage: memory(),
    });
    expect(refused.phase).toBe("denied");
    expect(noConsent.calls).toHaveLength(0);

    const anonymous = await connectDrive({
      config,
      interactive: true,
      http: scripted().http,
      token: tokens({ ok: false, reason: "no-identity" }, removed),
      storage: memory(),
    });
    expect(anonymous.phase).toBe("no-identity");

    const expiredIdentity = scripted();
    const expired = await connectDrive({
      config,
      interactive: true,
      http: expiredIdentity.http,
      token: tokens({ ok: false, reason: "expired" }, removed),
      storage: memory(),
    });
    expect(expired.phase).toBe("auth-expired");
    expect(expiredIdentity.calls).toHaveLength(0);
    noToken(refused);
  });

  it("shows the account from the Drive about response and does not create files", async () => {
    const drive = scripted();
    const connected = await connectDrive({
      config,
      interactive: true,
      http: drive.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: memory(),
    });
    expect(connected).toMatchObject({ phase: "connected", account });
    expect(drive.calls.map((call) => call.method)).toEqual(["GET"]);
    expect(drive.calls[0]?.url).toContain("/about");
    expect(panelCopy(connected).account).toBe("ada@example.com");
    noToken(connected);
  });

  it("verifies raw markdown, json, and media bytes for one isolated folder", async () => {
    const drive = scripted();
    const store = memory();
    const verified = await runProbe({
      config,
      session: account,
      http: drive.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: store,
      lock: { held: false },
    });
    expect(verified.phase).toBe("verified");
    expect(drive.calls).toHaveLength(10);
    expect(drive.calls.filter((call) => call.method === "POST").length).toBe(4);
    const bodies = drive.calls.map((call) => new TextDecoder().decode(call.body ?? new Uint8Array()));
    expect(bodies.some((body) => body.includes("application/vnd.google-apps.document"))).toBe(false);
    expect(bodies.some((body) => body.includes(PROBE_MARKDOWN) && body.includes('"parents":["root-1"]'))).toBe(true);
    expect(bodies.some((body) => body.includes(PROBE_JSON))).toBe(true);
    expect(bodies.some((body) => body.includes("wa-s"))).toBe(true);
    expect(store.current()).toMatchObject({
      accountId: "perm-1",
      rootId: "root-1",
      pendingMutation: false,
      files: [
        { name: "note.md", id: "file-md" },
        { name: "meta.json", id: "file-json" },
        { name: "dot.bin", id: "file-bin" },
      ],
    });
    noToken(verified);
  });

  it("stops on HTTP errors and invalid JSON without a success result", async () => {
    const store = memory();
    const httpError = scripted({ at: 3, result: { kind: "response", status: 503, bytes: encoder.encode("nope") } });
    const failed = await runProbe({
      config,
      session: account,
      http: httpError.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: store,
      lock: { held: false },
    });
    expect(failed).toMatchObject({ phase: "unknown-mutation", warning: "previous-unknown", httpStatus: 503 });
    expect(store.current()).toMatchObject({ rootId: "root-1", pendingMutation: true });
    expect(httpError.calls.some((call) => call.url.includes("meta.json") || new TextDecoder().decode(call.body ?? new Uint8Array()).includes("meta.json"))).toBe(false);
    const later = scripted();
    const restored = await connectDrive({
      config,
      interactive: false,
      http: later.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: store,
    });
    expect(restored).toMatchObject({ phase: "unknown-mutation", warning: "previous-unknown" });
    expect(later.calls.some((call) => call.method === "POST")).toBe(false);

    const invalid = scripted({ at: 1, result: { kind: "response", status: 200, bytes: encoder.encode("{") } });
    const bad = await connectDrive({
      config,
      interactive: true,
      http: invalid.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: memory(),
    });
    expect(bad.phase).toBe("invalid-json");
    expect(invalid.calls).toHaveLength(1);
  });

  it("pauses a changed account and a missing root instead of creating a replacement", async () => {
    const changed = scripted();
    const paused = await connectDrive({
      config,
      interactive: false,
      http: changed.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: memory({ accountId: "perm-old", rootId: "root-old", files: [], pendingMutation: false }),
    });
    expect(paused.phase).toBe("account-changed");
    expect(changed.calls.every((call) => call.method === "GET" && !call.url.includes("root-old"))).toBe(true);

    const missing = scripted();
    const gone = await connectDrive({
      config,
      interactive: false,
      http: missing.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: memory({ accountId: "perm-1", rootId: "root-old", files: [{ name: "note.md", id: "old-file" }], pendingMutation: false }),
    });
    expect(gone).toMatchObject({ phase: "root-missing", warning: "root-missing" });
    expect(missing.calls.some((call) => call.method === "POST")).toBe(false);
    expect(missing.calls.some((call) => call.url.includes("root-old"))).toBe(true);

    const kept = scripted();
    const restored = await connectDrive({
      config,
      interactive: false,
      http: kept.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: memory({ accountId: "perm-1", rootId: "root-1", files: [{ name: "note.md", id: "file-md" }], pendingMutation: false }),
    });
    expect(restored.phase).toBe("connected");
    expect(kept.calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(kept.calls.some((call) => call.method === "POST")).toBe(false);

    const unresolved = scripted();
    const pausedWrite = await connectDrive({
      config,
      interactive: false,
      http: unresolved.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: memory({ accountId: "perm-1", rootId: "root-1", files: [], pendingMutation: true }),
    });
    expect(pausedWrite).toMatchObject({ phase: "unknown-mutation", warning: "previous-unknown" });
    expect(unresolved.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("rejects a second probe while one is in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drive = scripted();
    const http: HttpClient = async (request) => {
      await gate;
      return drive.http(request);
    };
    const lock = { held: false };
    const input = {
      config,
      session: account,
      http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: memory(),
      lock,
    };
    const first = runProbe(input);
    const second = await runProbe(input);
    expect(second.phase).toBe("busy");
    release();
    expect((await first).phase).toBe("verified");
  });

  it("drops a cached token on 401 and does not replay the mutation", async () => {
    const removed: string[] = [];
    const store = memory();
    const drive = scripted({ at: 3, result: { kind: "response", status: 401, bytes: encoder.encode("{}") } });
    const expired = await runProbe({
      config,
      session: account,
      http: drive.http,
      token: tokens({ ok: true, token: tokenText }, removed),
      storage: store,
      lock: { held: false },
    });
    expect(expired.phase).toBe("auth-expired");
    expect(expired.warning).toBeNull();
    expect(removed).toEqual([tokenText]);
    expect(drive.calls).toHaveLength(3);
    expect(store.current()).toMatchObject({ rootId: "root-1", pendingMutation: false });
    expect(panelCopy(expired).status).toContain("not retried");
    noToken(expired);
  });

  it("keeps known ids when a mutation response is lost and the next attempt uses a new folder", async () => {
    const prior: ProbeRecord = { accountId: "perm-1", rootId: "root-old", files: [{ name: "note.md", id: "old-file" }], pendingMutation: false };
    const lost = scripted({ at: 2, result: { kind: "unknown" } });
    const store = memory(prior);
    const stopped = await runProbe({
      config,
      session: account,
      http: lost.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: store,
      lock: { held: false },
    });
    expect(stopped).toMatchObject({ phase: "unknown-mutation", warning: "previous-unknown" });
    expect(store.current()).toMatchObject({ rootId: "root-old", pendingMutation: true });
    expect(lost.calls).toHaveLength(2);

    const blocked = scripted();
    const held = await runProbe({
      config,
      session: account,
      http: blocked.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: store,
      lock: { held: false },
    });
    expect(held.phase).toBe("unknown-mutation");
    expect(blocked.calls).toHaveLength(0);

    const again = scripted();
    const retried = await runProbe({
      config,
      session: account,
      http: again.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: store,
      lock: { held: false },
      ackPendingId: stopped.pendingId,
    });
    expect(retried).toMatchObject({ phase: "verified", warning: "previous-unknown" });
    expect(again.calls.some((call) => call.url.includes("old-file") || call.url.includes("root-old"))).toBe(false);
    expect(store.current()?.rootId).toBe("root-1");

    const otherAccount = scripted();
    const switched = await runProbe({
      config,
      session: { ...account, permissionId: "perm-old" },
      http: otherAccount.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: memory(),
      lock: { held: false },
    });
    expect(switched.phase).toBe("account-changed");
    expect(otherAccount.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("keeps a mutating 5xx unresolved after the folder was applied", async () => {
    for (const status of [503, 504]) {
      const store = memory({ accountId: "perm-1", rootId: "root-old", files: [{ name: "note.md", id: "old-file" }], pendingMutation: false });
      const drive = scripted({ at: 2, result: { kind: "response", status, bytes: encoder.encode("{}") } });
      const failed = await runProbe({
        config,
        session: account,
        http: drive.http,
        token: tokens({ ok: true, token: tokenText }, []),
        storage: store,
        lock: { held: false },
      });
      expect(failed).toMatchObject({ phase: "unknown-mutation", warning: "previous-unknown", httpStatus: status });
      expect(panelCopy(failed).status).toContain(`HTTP ${status}`);
      expect(failed.pendingId).toBe(unresolvedKey(store.current()));
      expect(store.current()).toEqual({
        accountId: "perm-1",
        rootId: "root-old",
        files: [{ name: "note.md", id: "old-file" }],
        pendingMutation: true,
        pendingRevision: expect.any(String),
        pendingAccountId: "perm-1",
      });
      expect(drive.calls).toHaveLength(2);
      const later = scripted();
      const restored = await connectDrive({
        config,
        interactive: false,
        http: later.http,
        token: tokens({ ok: true, token: tokenText }, []),
        storage: store,
      });
      expect(restored.phase).toBe("unknown-mutation");
      expect(restored.warning).toBe("previous-unknown");
      expect(later.calls.some((call) => call.method === "POST")).toBe(false);
    }
  });

  it("does not mark a GET failure as an unresolved mutation", async () => {
    const store = memory({ accountId: "perm-1", rootId: "root-1", files: [{ name: "note.md", id: "file-md" }], pendingMutation: false });
    const drive = scripted({ at: 2, result: { kind: "response", status: 503, bytes: encoder.encode("{}") } });
    const failed = await connectDrive({
      config,
      interactive: false,
      http: drive.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: store,
    });
    expect(failed).toMatchObject({ phase: "http-error", httpStatus: 503, warning: null, pendingId: null });
    expect(store.current()?.pendingMutation).toBe(false);
    expect(drive.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("keeps the older unresolved root when a new attempt is rejected", async () => {
    for (const status of [403, 401]) {
      const prior: ProbeRecord = { accountId: "perm-1", rootId: "root-old", files: [{ name: "note.md", id: "old-file" }], pendingMutation: false };
      const store = memory(prior);
      const lost = scripted({ at: 2, result: { kind: "unknown" } });
      const stopped = await runProbe({
        config,
        session: account,
        http: lost.http,
        token: tokens({ ok: true, token: tokenText }, []),
        storage: store,
        lock: { held: false },
      });
      const key = unresolvedKey(store.current());
      expect(stopped.pendingId).toBe(key);
      expect(store.current()).toMatchObject({ rootId: "root-old", pendingMutation: true });

      const removed: string[] = [];
      const rejected = scripted({ at: 2, result: { kind: "response", status, bytes: encoder.encode("{}") } });
      const failed = await runProbe({
        config,
        session: account,
        http: rejected.http,
        token: tokens({ ok: true, token: tokenText }, removed),
        storage: store,
        lock: { held: false },
        ackPendingId: key,
      });
      expect(failed.warning).toBe("previous-unknown");
      expect(failed.phase).toBe(status === 401 ? "auth-expired" : "http-error");
      expect(store.current()).toEqual({
        accountId: "perm-1",
        rootId: "root-old",
        files: [{ name: "note.md", id: "old-file" }],
        pendingMutation: true,
        pendingRevision: key,
        pendingAccountId: "perm-1",
      });
      expect(rejected.calls.filter((call) => call.method === "POST")).toHaveLength(1);
      expect(removed).toEqual(status === 401 ? [tokenText] : []);

      const later = scripted();
      const restored = await connectDrive({
        config,
        interactive: false,
        http: later.http,
        token: tokens({ ok: true, token: tokenText }, []),
        storage: store,
      });
      expect(restored).toMatchObject({ phase: "unknown-mutation", warning: "previous-unknown", pendingId: key });
      expect(restored.phase).not.toBe("connected");
      expect(later.calls.some((call) => call.method === "POST")).toBe(false);
      expect(store.current()?.pendingMutation).toBe(true);
    }
  });

  it("warns a stale panel before the new folder request", async () => {
    const prior: ProbeRecord = { accountId: "perm-1", rootId: "root-old", files: [{ name: "note.md", id: "old-file" }], pendingMutation: true };
    const key = unresolvedKey(prior);
    let panel = planPanel(initialPanelView, { phase: "connected", account, warning: null, httpStatus: null, pendingId: null });
    expect(panel.notice).toBe("");
    expect(panel.seenPendingId).toBeNull();

    const store = memory(prior);
    const early = scripted();
    const request = panelRequest("probe", panel.seenPendingId);
    const stopped = await runProbe({
      config,
      session: account,
      http: early.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: store,
      lock: { held: false },
      ackPendingId: request.ackPendingId ?? null,
    });
    expect(early.calls).toHaveLength(0);
    expect(stopped).toMatchObject({ phase: "unknown-mutation", warning: "previous-unknown", pendingId: key });
    panel = planPanel(panel, stopped);
    expect(panel.notice).toContain("may have succeeded");
    expect(panel.seenPendingId).toBe(key);
    expect(store.current()).toEqual(prior);

    const stale = scripted();
    const ignored = await runProbe({
      config,
      session: account,
      http: stale.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: store,
      lock: { held: false },
      ackPendingId: "other-panel",
    });
    expect(stale.calls).toHaveLength(0);
    expect(ignored.pendingId).toBe(key);

    const refresh = scripted();
    const restored = await connectDrive({
      config,
      interactive: false,
      http: refresh.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: store,
    });
    expect(panelRequest("restore", key)).toEqual({ protocol: DRIVE_PROTOCOL, type: "restore" });
    expect(refresh.calls.some((call) => call.method === "POST")).toBe(false);
    expect(restored.phase).toBe("unknown-mutation");

    const started = scripted();
    const acked = panelRequest("probe", panel.seenPendingId);
    expect(acked.ackPendingId).toBe(key);
    const created = await runProbe({
      config,
      session: account,
      http: started.http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: store,
      lock: { held: false },
      ackPendingId: acked.ackPendingId ?? null,
    });
    expect(created.phase).toBe("verified");
    expect(started.calls.some((call) => call.method === "POST")).toBe(true);
    expect(panelCopy(created).notice).toContain("new folder");
  });

  it("clears a reopened Busy panel after the probe finishes", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drive = scripted();
    const http: HttpClient = async (request) => {
      await gate;
      return drive.http(request);
    };
    const lock = { held: false };
    const store = memory();
    const deps = {
      config,
      session: account,
      http,
      token: tokens({ ok: true, token: tokenText }, []),
      storage: store,
      lock,
    };
    const running = dispatchDrive({ ...deps, message: { protocol: DRIVE_PROTOCOL, type: "probe", expectedAccountId: account.permissionId } });
    const reopened = await dispatchDrive({ ...deps, message: { protocol: DRIVE_PROTOCOL, type: "restore" } });
    expect(reopened.phase).toBe("busy");
    let panel = planPanel(initialPanelView, reopened);
    expect(panel.connectDisabled).toBe(true);
    expect(panel.probeDisabled).toBe(true);
    expect(panel.refresh).toBe(true);
    let steps = 1;
    while (panel.refresh) {
      panel = planPanel(panel, reopened);
      steps += 1;
      expect(steps).toBeLessThanOrEqual(MAX_BUSY_POLLS + 1);
    }
    expect(steps).toBe(MAX_BUSY_POLLS + 1);
    expect(panelRequest("restore", panel.seenPendingId).type).toBe("restore");

    release();
    const done = await running;
    expect(done.phase).toBe("verified");
    panel = planPanel(panel, done);
    expect(panel.refresh).toBe(false);
    expect(panel.probeDisabled).toBe(false);
    expect(panel.connectDisabled).toBe(false);

    const after = scripted();
    const settled = await dispatchDrive({
      ...deps,
      http: after.http,
      message: { protocol: DRIVE_PROTOCOL, type: "restore" },
    });
    expect(settled.phase).toBe("connected");
    expect(after.calls.some((call) => call.method === "POST")).toBe(false);
    panel = planPanel(panel, settled);
    expect(panel.refresh).toBe(false);
    expect(panel.probeDisabled).toBe(false);
  });

  it("keeps stored probe ids and drops any token field", () => {
    const record = readProbeRecord({
      accountId: "perm-1",
      rootId: "root-1",
      files: [{ name: "note.md", id: "file-md", token: tokenText }],
      pendingMutation: false,
      token: tokenText,
    });
    expect(record).toEqual({
      accountId: "perm-1",
      rootId: "root-1",
      files: [{ name: "note.md", id: "file-md" }],
      pendingMutation: false,
    });
    expect(JSON.stringify(record)).not.toContain(tokenText);
  });
});
