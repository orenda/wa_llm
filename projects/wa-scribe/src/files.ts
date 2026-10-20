import type { HttpClient, HttpResult } from "./drive";

export type FailureClass = "auth" | "permission" | "rate-limit" | "quota" | "server" | "rejected";

export type TransportResult =
  | { kind: "response"; status: number; bytes: Uint8Array; retryAfterMs: number | null }
  | { kind: "unknown" }
  | { kind: "not-sent" };

export type TransportRequest = {
  method: "GET" | "POST" | "PATCH";
  url: string;
  contentType?: string;
  body?: Uint8Array;
};

export type Transport = (request: TransportRequest) => Promise<TransportResult>;

export type OwnedFile = { id: string; parentId: string; name: string };

export type FileTree = { accountId: string; rootId: string; files: OwnedFile[] };

export type FileMutation = {
  operationId: string;
  generation: number;
  accountId: string;
  rootId: string;
  action: "create" | "update";
  parentId: string;
  fileId: string | null;
  name: string;
  mimeType: string;
};

export type PendingMutation = FileMutation;

export type FileBlockReason = "unresolved-older" | "outside-tree" | "account-changed" | "missing-id" | "name-adoption";

export type FileResult =
  | { phase: "applied"; fileId: string; generation: number }
  | { phase: "not-applied"; class: FailureClass | "not-sent"; httpStatus: number | null; retryAfterMs: number | null }
  | { phase: "unknown"; httpStatus: number | null; generation: number }
  | { phase: "blocked"; reason: FileBlockReason };

const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const textEncoder = new TextEncoder();

export function backoffMs(attempt: number, retryAfterMs: number | null, unit: number): number {
  if (retryAfterMs !== null && retryAfterMs >= 0) return Math.min(retryAfterMs, 30_000);
  const step = Math.min(Math.max(attempt, 1), 5);
  const base = 250 * 2 ** (step - 1);
  const jitter = Math.abs(unit) % base;
  return Math.min(base + jitter, 30_000);
}

export function mayRetry(failure: FailureClass, attempt: number): boolean {
  if (attempt >= 3) return false;
  return failure === "rate-limit";
}

export function isInsideTree(tree: FileTree, id: string): boolean {
  if (id === tree.rootId) return true;
  const byId = new Map(tree.files.map((file) => [file.id, file]));
  const seen = new Set<string>();
  let current = id;
  while (current !== tree.rootId) {
    if (seen.has(current)) return false;
    seen.add(current);
    const node = byId.get(current);
    if (!node) return false;
    current = node.parentId;
  }
  return true;
}

/** A name is never an identity. Same-named replacements stay paused. */
export function resolveOwned(tree: FileTree, query: { id: string } | { name: string }): { id: string } | FileResult {
  if ("name" in query) return { phase: "blocked", reason: "name-adoption" };
  if (query.id !== tree.rootId && !tree.files.some((file) => file.id === query.id)) return { phase: "blocked", reason: "missing-id" };
  if (!isInsideTree(tree, query.id)) return { phase: "blocked", reason: "outside-tree" };
  return { id: query.id };
}

export function classifyHttp(status: number, bytes: Uint8Array): FailureClass {
  const text = new TextDecoder().decode(bytes);
  if (text.includes("storageQuotaExceeded")) return "quota";
  if (status === 401) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 403) return "permission";
  if (status >= 500 && status <= 599) return "server";
  return "rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readId(bytes: Uint8Array): { id: string; parents: string[] } | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    const parents = Array.isArray(parsed.parents) ? parsed.parents.filter((entry): entry is string => typeof entry === "string") : [];
    return { id: parsed.id, parents };
  } catch {
    return null;
  }
}

function blocked(reason: FileBlockReason): FileResult {
  return { phase: "blocked", reason };
}

function unknown(httpStatus: number | null, generation: number): FileResult {
  return { phase: "unknown", httpStatus, generation };
}

export function rereadDoesNotResolve(pending: PendingMutation | null): PendingMutation | null {
  return pending;
}

export function applyLate(
  tree: FileTree,
  pending: PendingMutation | null,
  late: { operationId: string; fileId: string; parentId: string; generation?: number },
): { tree: FileTree; pending: PendingMutation | null; result: FileResult } {
  if (!pending || pending.operationId !== late.operationId) return { tree, pending, result: blocked("unresolved-older") };
  if (pending.accountId !== tree.accountId || pending.rootId !== tree.rootId) return { tree, pending, result: blocked("account-changed") };
  if (late.generation !== undefined && late.generation !== pending.generation) return { tree, pending, result: blocked("unresolved-older") };
  if (!late.fileId || late.fileId === tree.rootId) return { tree, pending, result: blocked("missing-id") };
  const current = tree.files.find((file) => file.id === late.fileId);
  const expectedParent = pending.parentId;
  if (late.parentId !== expectedParent || !isInsideTree(tree, late.parentId)) return { tree, pending, result: blocked("outside-tree") };
  if (pending.fileId !== null && late.fileId !== pending.fileId) return { tree, pending, result: blocked("missing-id") };
  if (pending.action === "update" && (!current || !isInsideTree(tree, late.fileId))) return { tree, pending, result: blocked("missing-id") };
  if (current && (current.parentId !== late.parentId || current.name !== pending.name)) return { tree, pending, result: blocked("outside-tree") };
  const files = current ? tree.files : [...tree.files, { id: late.fileId, parentId: late.parentId, name: pending.name }];
  return {
    tree: { ...tree, files },
    pending: null,
    result: { phase: "applied", fileId: late.fileId, generation: pending.generation },
  };
}

export async function mutate(input: {
  tree: FileTree;
  pending: PendingMutation | null;
  mutation: FileMutation;
  body: Uint8Array;
  transport: Transport;
  currentAccountId: string;
}): Promise<{ tree: FileTree; pending: PendingMutation | null; result: FileResult; calls: number }> {
  const { tree, mutation } = input;
  if (mutation.accountId !== tree.accountId || mutation.accountId !== input.currentAccountId || mutation.rootId !== tree.rootId) {
    return { tree, pending: input.pending, result: blocked("account-changed"), calls: 0 };
  }
  if (input.pending && input.pending.operationId !== mutation.operationId) {
    return { tree, pending: input.pending, result: blocked("unresolved-older"), calls: 0 };
  }
  if (input.pending) return { tree, pending: input.pending, result: unknown(null, input.pending.generation), calls: 0 };
  const parentOk = mutation.action === "create" ? isInsideTree(tree, mutation.parentId) : false;
  const targetOk = mutation.action === "update" && mutation.fileId !== null && tree.files.some((file) => file.id === mutation.fileId && file.parentId === mutation.parentId && file.name === mutation.name) && isInsideTree(tree, mutation.fileId);
  if (!parentOk && !targetOk) return { tree, pending: input.pending, result: blocked("outside-tree"), calls: 0 };

  const request = mutationRequest(mutation, input.body);
  const response = await input.transport(request);
  if (response.kind === "not-sent") {
    return { tree, pending: input.pending, result: { phase: "not-applied", class: "not-sent", httpStatus: null, retryAfterMs: null }, calls: 1 };
  }
  if (response.kind === "unknown") return { tree, pending: mutation, result: unknown(null, mutation.generation), calls: 1 };
  if (response.status >= 500 && response.status <= 599) {
    return { tree, pending: mutation, result: unknown(response.status, mutation.generation), calls: 1 };
  }
  if (response.status < 200 || response.status >= 300) {
    const failure = classifyHttp(response.status, response.bytes);
    return {
      tree,
      pending: input.pending,
      result: { phase: "not-applied", class: failure, httpStatus: response.status, retryAfterMs: response.retryAfterMs },
      calls: 1,
    };
  }
  const created = readId(response.bytes);
  if (!created) return { tree, pending: mutation, result: unknown(response.status, mutation.generation), calls: 1 };
  if (mutation.action === "update" && created.id !== mutation.fileId) {
    return { tree, pending: mutation, result: unknown(response.status, mutation.generation), calls: 1 };
  }
  const parentId = mutation.action === "create" ? mutation.parentId : mutation.fileId ? parentOf(tree, mutation.fileId) : mutation.parentId;
  if (!created.parents.includes(parentId)) return { tree, pending: mutation, result: blocked("outside-tree"), calls: 1 };
  const files =
    mutation.action === "create"
      ? [...tree.files, { id: created.id, parentId, name: mutation.name }]
      : tree.files.map((file) => (file.id === created.id ? { ...file, name: mutation.name } : file));
  return { tree: { ...tree, files }, pending: null, result: { phase: "applied", fileId: created.id, generation: mutation.generation }, calls: 1 };
}

function parentOf(tree: FileTree, id: string): string {
  return tree.files.find((file) => file.id === id)?.parentId ?? "";
}

function mutationRequest(mutation: FileMutation, body: Uint8Array): TransportRequest {
  if (mutation.action === "update" && mutation.fileId) {
    return { method: "PATCH", url: `${UPLOAD_URL}/${mutation.fileId}?uploadType=media&fields=id,parents`, contentType: mutation.mimeType, body };
  }
  const boundary = `wa-scribe-${crypto.randomUUID()}`;
  const meta = JSON.stringify({ ...(mutation.fileId ? { id: mutation.fileId } : {}), name: mutation.name, mimeType: mutation.mimeType, parents: [mutation.parentId] });
  const head = textEncoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mutation.mimeType}\r\n\r\n`);
  const tail = textEncoder.encode(`\r\n--${boundary}--\r\n`);
  const combined = new Uint8Array(head.byteLength + body.byteLength + tail.byteLength);
  combined.set(head);
  combined.set(body, head.byteLength);
  combined.set(tail, head.byteLength + body.byteLength);
  return { method: "POST", url: `${UPLOAD_URL}?uploadType=multipart&fields=id,parents`, contentType: `multipart/related; boundary=${boundary}`, body: combined };
}

export function transportFromHttp(http: HttpClient, token: string): Transport {
  return async (request) => {
    const sent: HttpResult = await http({ method: request.method, url: request.url, token, ...(request.contentType ? { contentType: request.contentType } : {}), ...(request.body ? { body: request.body } : {}) });
    if (sent.kind === "unknown") return { kind: "unknown" };
    return { kind: "response", status: sent.status, bytes: sent.bytes, retryAfterMs: null };
  };
}

export async function readOwned(input: {
  tree: FileTree;
  pending: PendingMutation | null;
  fileId: string;
  transport: Transport;
  currentAccountId: string;
}): Promise<{ pending: PendingMutation | null; result: FileResult | { phase: "bytes"; fileId: string; bytes: Uint8Array } }> {
  const resolved = resolveOwned(input.tree, { id: input.fileId });
  if ("phase" in resolved) return { pending: input.pending, result: resolved };
  if (input.currentAccountId !== input.tree.accountId) return { pending: input.pending, result: blocked("account-changed") };
  const response = await input.transport({ method: "GET", url: `${FILES_URL}/${input.fileId}?alt=media` });
  if (response.kind !== "response") return { pending: rereadDoesNotResolve(input.pending), result: unknown(null, input.pending?.generation ?? 0) };
  if (response.status < 200 || response.status >= 300) {
    return {
      pending: rereadDoesNotResolve(input.pending),
      result: { phase: "not-applied", class: classifyHttp(response.status, response.bytes), httpStatus: response.status, retryAfterMs: response.retryAfterMs },
    };
  }
  return { pending: input.pending, result: { phase: "bytes", fileId: input.fileId, bytes: response.bytes } };
}
