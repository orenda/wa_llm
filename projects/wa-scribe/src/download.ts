import { encodeExport, encodeMetadata, parseTranscript } from "./format";
import type { AttachmentSlot, Binding, ChatExport, Coverage, CoverageGap, ExportDraft, MessageDraft, ParsedBlock, SavedMessage, Sender, Timestamp } from "./model";

export type ObservedMessage = {
  id: string;
  sender: Sender;
  timestamp: Timestamp;
  sequence: "verified" | "unknown";
  text: string;
  attachments: AttachmentSlot[];
  sourceBaseline: string;
};

export type DownloadResult = {
  phase: "updated" | "unchanged" | "paused";
  reason: "unknown-order" | "disjoint" | "ambiguous-local" | "local-edit" | "binding-mismatch" | "missing-state" | null;
  markdown: string | null;
  metadata: string | null;
  chat: ChatExport | null;
  inserted: string[];
  unresolved: string[];
};

function pause(reason: DownloadResult["reason"], markdown: string | null, chat: ChatExport | null, unresolved: string[] = []): DownloadResult {
  return { phase: "paused", reason, markdown, metadata: null, chat, inserted: [], unresolved };
}

export function sameBinding(left: Binding, right: Binding): boolean {
  return left.accountId === right.accountId && left.chatId === right.chatId && left.destinationId === right.destinationId && left.generation === right.generation;
}

/** Both chains must establish a unique order; array position is not new evidence. */
function mergeIds(committed: readonly string[], observed: readonly string[], contiguous: boolean): { ids: string[] } | { conflict: true } | { disjoint: string[] } {
  const saved = new Set(committed);
  if (committed.length && observed.length && !observed.some((id) => saved.has(id))) return { disjoint: [...observed] };
  const edges = new Map<string, Set<string>>();
  const incoming = new Map<string, number>();
  for (const id of [...committed, ...observed]) {
    if (!edges.has(id)) edges.set(id, new Set());
    if (!incoming.has(id)) incoming.set(id, 0);
  }
  const connect = (before: string | undefined, after: string | undefined) => {
    if (!before || !after || before === after || edges.get(before)?.has(after)) return;
    edges.get(before)?.add(after);
    incoming.set(after, (incoming.get(after) ?? 0) + 1);
  };
  for (const chain of [committed, observed]) {
    for (let index = 1; index < chain.length; index += 1) connect(chain[index - 1], chain[index]);
  }
  if (contiguous) {
    // A contiguous new prefix/suffix sits directly beside its surviving anchor.
    const anchors = observed.map((id, index) => saved.has(id) ? index : -1).filter((index) => index >= 0);
    const first = anchors[0];
    const last = anchors.at(-1);
    if (first !== undefined && first > 0) connect(committed[committed.indexOf(observed[first] ?? "") - 1], observed[0]);
    if (last !== undefined && last < observed.length - 1) connect(observed.at(-1), committed[committed.indexOf(observed[last] ?? "") + 1]);
  }
  const ids: string[] = [];
  const ready = [...incoming].filter(([, degree]) => degree === 0).map(([id]) => id);
  while (ready.length === 1) {
    const id = ready.pop();
    if (id === undefined) break;
    ids.push(id);
    for (const next of edges.get(id) ?? []) {
      const degree = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, degree);
      if (degree === 0) ready.push(next);
    }
  }
  return ids.length === incoming.size ? { ids } : { conflict: true };
}

function blockKey(block: ParsedBlock | SavedMessage): string {
  const attachments = block.attachments.map(({ slot, attachment }) => {
    if (attachment.state === "pending" || attachment.state === "unavailable") return [slot, attachment.state, attachment.limitation];
    if (attachment.state === "unsupported") return [slot, attachment.state, attachment.detail];
    return [slot, attachment.state, attachment.name, attachment.mediaType, attachment.relativePath];
  });
  return JSON.stringify([block.blockFingerprint, block.sender.key, block.sender.name, block.timestamp.display, block.timestamp.precision,
    block.timestamp.timeZone, block.timestamp.instant, block.sequence, block.text, block.limitation, attachments]);
}

function uniqueKept(messages: readonly SavedMessage[], blocks: readonly ParsedBlock[]): number[] | "ambiguous" {
  if (!blocks.length) return [];
  if (blocks.length > messages.length) return "ambiguous";
  const saved = messages.map(blockKey);
  const current = blocks.map(blockKey);
  if (saved.length === current.length) return saved.every((key, index) => key === current[index]) ? saved.map((_, index) => index) : "ambiguous";
  // Bound alignment work even for a large export containing many equal blocks.
  const width = current.length + 1;
  if ((saved.length + 1) * width > 1_000_000) return "ambiguous";
  const ways = new Uint8Array((saved.length + 1) * width);
  for (let index = 0; index <= saved.length; index += 1) ways[index * width + current.length] = 1;
  for (let index = saved.length - 1; index >= 0; index -= 1) {
    for (let block = current.length - 1; block >= 0; block -= 1) {
      ways[index * width + block] = Math.min(2, (ways[(index + 1) * width + block] ?? 0) +
        (saved[index] === current[block] ? ways[(index + 1) * width + block + 1] ?? 0 : 0));
    }
  }
  if (ways[0] !== 1) return "ambiguous";
  const kept: number[] = [];
  for (let index = 0, block = 0; index < saved.length && block < current.length; index += 1) {
    if (saved[index] === current[block] && ways[(index + 1) * width + block + 1]) {
      kept.push(index);
      block += 1;
    }
  }
  return kept;
}

function applyLocalDeletions(markdown: string, chat: ChatExport): { chat: ChatExport; prefix: string } | { reason: "local-edit" | "ambiguous-local" } {
  const parsed = parseTranscript(markdown);
  if (!parsed.ok) return { reason: "ambiguous-local" };
  const kept = uniqueKept(chat.messages, parsed.value.blocks);
  if (kept === "ambiguous") return { reason: parsed.value.blocks.length === chat.messages.length ? "local-edit" : "ambiguous-local" };
  const keep = new Set(kept);
  const removed = chat.messages.filter((_, index) => !keep.has(index));
  const messages = chat.messages.filter((_, index) => keep.has(index));
  const tombstones = [...chat.tombstones, ...removed.map((message) => ({ messageId: message.id, reason: "local-deletion" as const }))];
  return { chat: { ...chat, messages, tombstones }, prefix: parsed.value.prefix };
}

function gapsFor(ids: readonly string[], coverage: Coverage | undefined, observed: readonly string[], contiguous: boolean): CoverageGap[] {
  const present = new Set(ids);
  const adjacency = new Map<string, Set<string>>();
  const connect = (before: string | undefined, after: string | undefined) => {
    if (!before || !after) return;
    if (!adjacency.has(before)) adjacency.set(before, new Set());
    adjacency.get(before)?.add(after);
  };
  for (const segment of coverage?.segments ?? []) {
    const kept = segment.messageIds.filter((id) => present.has(id));
    for (let index = 1; index < kept.length; index += 1) connect(kept[index - 1], kept[index]);
  }
  const previousIds = coverage?.segments.flatMap((segment) => segment.messageIds) ?? [];
  for (const gap of coverage?.gaps ?? []) {
    if (gap.afterId === null || gap.beforeId === null) continue;
    const start = previousIds.indexOf(gap.afterId);
    const end = previousIds.indexOf(gap.beforeId);
    if (start < 0 || end <= start) continue;
    for (let index = start; index < end; index += 1) adjacency.get(previousIds[index] ?? "")?.delete(previousIds[index + 1] ?? "");
  }
  if (contiguous) {
    const kept = observed.filter((id) => present.has(id));
    for (let index = 1; index < kept.length; index += 1) connect(kept[index - 1], kept[index]);
  }
  const gaps: CoverageGap[] = [];
  const add = (gap: CoverageGap) => {
    if (!gaps.some((entry) => entry.afterId === gap.afterId && entry.beforeId === gap.beforeId)) gaps.push(gap);
  };
  for (const gap of coverage?.gaps ?? []) {
    const bridged = contiguous && gap.afterId !== null && gap.beforeId !== null && observed.includes(gap.afterId) && observed.includes(gap.beforeId);
    if (!bridged && (gap.afterId === null || gap.beforeId === null || !present.has(gap.afterId) || !present.has(gap.beforeId))) {
      add({ ...gap, afterId: gap.afterId !== null && present.has(gap.afterId) ? gap.afterId : null, beforeId: gap.beforeId !== null && present.has(gap.beforeId) ? gap.beforeId : null });
    }
  }
  for (let index = 1; index < ids.length; index += 1) {
    const afterId = ids[index - 1];
    const beforeId = ids[index];
    if (afterId && beforeId && !adjacency.get(afterId)?.has(beforeId)) add({ afterId, beforeId, reason: "unverified-between" });
  }
  return gaps;
}

function segmentsFor(ids: readonly string[], gaps: readonly CoverageGap[]) {
  const splitAfter = new Set(gaps.map((gap) => gap.afterId));
  const segments: { messageIds: string[]; anchorBefore: null; anchorAfter: null }[] = [];
  let current: string[] = [];
  for (const id of ids) {
    current.push(id);
    if (splitAfter.has(id)) {
      segments.push({ messageIds: current, anchorBefore: null, anchorAfter: null });
      current = [];
    }
  }
  if (current.length) segments.push({ messageIds: current, anchorBefore: null, anchorAfter: null });
  return segments;
}

function draftsFor(ids: readonly string[], chat: ChatExport | null, observed: readonly ObservedMessage[]): MessageDraft[] {
  const saved = new Map((chat?.messages ?? []).map((message) => [message.id, message]));
  const seen = new Map(observed.map((message) => [message.id, message]));
  const messages: MessageDraft[] = [];
  for (const id of ids) {
    const existing = saved.get(id);
    const next = seen.get(id);
    if (existing) messages.push({ ...existing, sourceBaseline: next?.sourceBaseline ?? existing.sourceBaseline });
    else if (next) messages.push({
      id: next.id, sender: next.sender, timestamp: next.timestamp, sequence: next.sequence, text: next.text,
      attachments: next.attachments, limitation: null, sourceBaseline: next.sourceBaseline, savedWordingBaseline: next.sourceBaseline,
    });
  }
  return messages;
}

export function downloadPass(input: {
  prefix: string;
  markdown: string | null;
  chat: ChatExport | null;
  binding: Binding;
  chatKey: string;
  displayName: string;
  observed: ObservedMessage[];
  order: "verified" | "unknown";
  contiguous: boolean;
  requestedScope: string;
}): DownloadResult {
  if (input.chat && !sameBinding(input.chat, input.binding)) return pause("binding-mismatch", input.markdown, input.chat);
  if ((input.chat === null) !== (input.markdown === null)) return pause("missing-state", input.markdown, input.chat);
  const originalMetadata = input.chat ? encodeMetadata(input.chat) : null;
  if (originalMetadata && !originalMetadata.ok) return pause("missing-state", input.markdown, input.chat);
  let chat = input.chat;
  let prefix = input.prefix;
  if (chat && input.markdown !== null) {
    const local = applyLocalDeletions(input.markdown, chat);
    if ("reason" in local) return pause(local.reason, input.markdown, chat);
    chat = local.chat;
    prefix = local.prefix;
  }
  const buried = new Set((chat?.tombstones ?? []).map((tombstone) => tombstone.messageId));
  const observedIds = input.observed.map((message) => message.id).filter((id) => !buried.has(id));
  if (new Set(observedIds).size !== observedIds.length || observedIds.some((id) => id === "")) return pause("unknown-order", input.markdown, input.chat, observedIds);
  if (input.order !== "verified") {
    const unresolved = observedIds.filter((id) => !chat?.messages.some((message) => message.id === id));
    if (unresolved.length) return pause("unknown-order", input.markdown, input.chat, unresolved);
  }
  const merged = mergeIds(chat?.messages.map((message) => message.id) ?? [], observedIds, input.contiguous && input.order === "verified");
  if ("conflict" in merged) return pause("unknown-order", input.markdown, input.chat, observedIds);
  if ("disjoint" in merged) return pause("disjoint", input.markdown, input.chat, merged.disjoint);
  const inserted = merged.ids.filter((id) => !chat?.messages.some((message) => message.id === id));
  const gaps = gapsFor(merged.ids, chat?.coverage, input.observed.map((message) => message.id), input.contiguous && input.order === "verified");
  const messages = draftsFor(merged.ids, chat, input.observed);
  const draft: ExportDraft = {
    ...input.binding,
    chatKey: chat?.chatKey ?? input.chatKey,
    displayName: input.displayName,
    sourceOrder: gaps.length === 0 && messages.every((message) => message.sequence === "verified") ? "verified" : "unknown",
    messages,
    tombstones: chat?.tombstones ?? [],
    coverage: { segments: segmentsFor(merged.ids, gaps), gaps, requestedScope: input.requestedScope, stopReason: gaps.length ? "unverified-between" : null },
  };
  const encoded = encodeExport(prefix, draft);
  if (!encoded.ok) return pause("missing-state", input.markdown, input.chat);
  const same = input.markdown === encoded.value.markdown && originalMetadata?.ok === true && originalMetadata.value === encoded.value.metadata;
  return { phase: same ? "unchanged" : "updated", reason: null, markdown: encoded.value.markdown, metadata: encoded.value.metadata, chat: encoded.value.chat, inserted, unresolved: [] };
}
