import { describe, expect, it } from "vitest";
import {
  applyLate,
  backoffMs,
  isInsideTree,
  mayRetry,
  mutate,
  readOwned,
  resolveOwned,
  type FileMutation,
  type FileTree,
  type Transport,
  type TransportResult,
} from "../src/files";

const encoder = new TextEncoder();

function tree(): FileTree {
  return {
    accountId: "acct-1",
    rootId: "root-1",
    files: [{ id: "note-1", parentId: "root-1", name: "class.md" }],
  };
}

function createMutation(operationId: string, generation: number): FileMutation {
  return {
    operationId,
    generation,
    accountId: "acct-1",
    rootId: "root-1",
    action: "create",
    parentId: "root-1",
    fileId: null,
    name: "class.md",
    mimeType: "text/markdown",
  };
}

function scripted(result: TransportResult): { transport: Transport; calls: number } {
  const state = { calls: 0 };
  const transport: Transport = async () => {
    state.calls += 1;
    return result;
  };
  return { transport, get calls() { return state.calls; } };
}

describe("drive file adapter", () => {
  it("rejects name adoption and files outside the recorded tree", () => {
    const owned = tree();
    expect(resolveOwned(owned, { name: "class.md" })).toEqual({ phase: "blocked", reason: "name-adoption" });
    expect(resolveOwned(owned, { id: "note-1" })).toEqual({ id: "note-1" });
    const moved: FileTree = { ...owned, files: [{ id: "note-1", parentId: "foreign", name: "class.md" }] };
    expect(isInsideTree(moved, "note-1")).toBe(false);
    expect(resolveOwned(moved, { id: "note-1" })).toEqual({ phase: "blocked", reason: "outside-tree" });
    expect(resolveOwned(owned, { id: "missing" })).toEqual({ phase: "blocked", reason: "missing-id" });
  });

  it("keeps fail-before-apply distinct from a lost response and does not create a second file", async () => {
    const notSent = scripted({ kind: "not-sent" });
    const first = await mutate({
      tree: tree(),
      pending: null,
      mutation: createMutation("op-1", 1),
      body: encoder.encode("hello"),
      transport: notSent.transport,
      currentAccountId: "acct-1",
    });
    expect(first.result).toEqual({ phase: "not-applied", class: "not-sent", httpStatus: null, retryAfterMs: null });
    expect(first.pending).toBeNull();
    expect(first.tree.files).toHaveLength(1);

    const applied = scripted({
      kind: "response",
      status: 200,
      bytes: encoder.encode(JSON.stringify({ id: "note-2", parents: ["root-1"] })),
      retryAfterMs: null,
    });
    const retried = await mutate({
      tree: first.tree,
      pending: first.pending,
      mutation: createMutation("op-1", 1),
      body: encoder.encode("hello"),
      transport: applied.transport,
      currentAccountId: "acct-1",
    });
    expect(retried.result).toMatchObject({ phase: "applied", fileId: "note-2", generation: 1 });
    expect(retried.pending).toBeNull();
    expect(retried.tree.files.map((file) => file.id)).toEqual(["note-1", "note-2"]);

    const lost = scripted({ kind: "unknown" });
    const uncertain = await mutate({
      tree: tree(),
      pending: null,
      mutation: createMutation("op-2", 1),
      body: encoder.encode("hello"),
      transport: lost.transport,
      currentAccountId: "acct-1",
    });
    expect(uncertain.result).toMatchObject({ phase: "unknown", generation: 1 });
    expect(uncertain.pending?.operationId).toBe("op-2");
    expect(uncertain.tree.files).toHaveLength(1);

    const again = scripted({ kind: "response", status: 200, bytes: encoder.encode("{}"), retryAfterMs: null });
    const replay = await mutate({
      tree: uncertain.tree,
      pending: uncertain.pending,
      mutation: createMutation("op-3", 2),
      body: encoder.encode("newer"),
      transport: again.transport,
      currentAccountId: "acct-1",
    });
    expect(replay.result).toEqual({ phase: "blocked", reason: "unresolved-older" });
    expect(replay.calls).toBe(0);
    expect(replay.tree.files).toHaveLength(1);

    const late = applyLate(uncertain.tree, uncertain.pending, { operationId: "op-2", fileId: "note-late", parentId: "root-1" });
    expect(late.result).toMatchObject({ phase: "applied", fileId: "note-late" });
    expect(late.pending).toBeNull();
    expect(late.tree.files.filter((file) => file.id === "note-late")).toHaveLength(1);
    const duplicate = applyLate(late.tree, null, { operationId: "op-2", fileId: "note-other", parentId: "root-1" });
    expect(duplicate.tree.files.some((file) => file.id === "note-other")).toBe(false);
  });

  it("does not treat a later read as proof that an aborted write stopped", async () => {
    const lost = await mutate({
      tree: tree(),
      pending: null,
      mutation: createMutation("op-4", 1),
      body: encoder.encode("x"),
      transport: async () => ({ kind: "response", status: 503, bytes: encoder.encode("down"), retryAfterMs: null }),
      currentAccountId: "acct-1",
    });
    expect(lost.result).toMatchObject({ phase: "unknown", httpStatus: 503 });
    const read = await readOwned({
      tree: lost.tree,
      pending: lost.pending,
      fileId: "note-1",
      currentAccountId: "acct-1",
      transport: async () => ({ kind: "response", status: 404, bytes: encoder.encode("{}"), retryAfterMs: null }),
    });
    expect(read.pending?.operationId).toBe("op-4");
    expect(read.result).toMatchObject({ phase: "not-applied", httpStatus: 404 });
  });

  it("classifies auth, permission, quota, and rate limits without replaying them", async () => {
    const quota = await mutate({
      tree: tree(),
      pending: null,
      mutation: createMutation("op-5", 1),
      body: encoder.encode("x"),
      transport: async () => ({
        kind: "response",
        status: 403,
        bytes: encoder.encode('{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}'),
        retryAfterMs: null,
      }),
      currentAccountId: "acct-1",
    });
    expect(quota.result).toMatchObject({ phase: "not-applied", class: "quota" });
    expect(quota.pending).toBeNull();
    expect(mayRetry("quota", 1)).toBe(false);
    expect(mayRetry("permission", 1)).toBe(false);
    expect(mayRetry("auth", 1)).toBe(false);
    expect(mayRetry("rate-limit", 1)).toBe(true);
    expect(mayRetry("rate-limit", 3)).toBe(false);
    expect(backoffMs(1, 1500, 9)).toBe(1500);
    expect(backoffMs(4, null, 10)).toBeLessThanOrEqual(30_000);

    const otherAccount = await mutate({
      tree: tree(),
      pending: null,
      mutation: createMutation("op-6", 1),
      body: encoder.encode("x"),
      transport: async () => {
        throw new Error("should not send");
      },
      currentAccountId: "acct-2",
    });
    expect(otherAccount.result).toEqual({ phase: "blocked", reason: "account-changed" });
    expect(otherAccount.calls).toBe(0);
  });
});