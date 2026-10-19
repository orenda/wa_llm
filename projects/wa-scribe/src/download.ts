import { encodeExport, parseTranscript } from "./format";
import type { AttachmentSlot, Binding, ChatExport, CoverageGap, ExportDraft, MessageDraft, SavedMessage, Sender, Timestamp } from "./model";

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
  reason: "unknown-order" | "disjoint" | "ambiguous-local" | null;
  markdown: string | null;
  metadata: string | null;
  chat: ChatExport | null;
  inserted: string[];
  unresolved: string[];
};

function pause(
  reason: DownloadResult["reason"],
  markdown: string | null,
  metadata: string | null,
  chat: ChatExport | null,
  unresolved: string[],
): DownloadResult {
  return { phase: "paused", reason, markdown, metadata, chat, inserted: [], unresolved };
}

function mergeIds(committed: readonly string[], observed: readonly string[], buried: ReadonlySet<string>): { ids: string[] } | { conflict: true } | { disjoint: string[] } {
  const committedSet = new Set(committed);
  const observedSet = new Set(observed);
  if (committed.length > 0 && !committed.some((id) => observedSet.has(id))) {
    return { disjoint: observed.filter((id) => !committedSet.has(id) && !buried.has(id)) };
  }
  const rank = new Map(observed.map((id, index) => [id, index]));
  let last = -1;
  for (const id of committed) {
    const value = rank.get(id);
    if (value === undefined) continue;
    if (value < last) return { conflict: true };
    last = value;
  }
  const ids: string[] = [];
  const emitted = new Set<string>();
  let cursor = 0;
  const emitNew = (next: string) => {
    if (committedSet.has(next) || buried.has(next) || emitted.has(next)) return;
    ids.push(next);
    emitted.add(next);
  };
  for (const id of committed) {
    if (rank.has(id)) {
      while (cursor < observed.length && observed[cursor] !== id) {
        emitNew(observed[cursor] ?? "");
        cursor += 1;
      }
      if (observed[cursor] === id) cursor += 1;
    }
    if (!buried.has(id) && !emitted.has(id)) {
      ids.push(id);
      emitted.add(id);
    }
  }
  while (cursor < observed.length) {
    emitNew(observed[cursor] ?? "");
    cursor += 1;
  }
  return { ids };
}

function uniqueKept(messages: readonly SavedMessage[], fingerprints: readonly string[]): number[] | "ambiguous" | "impossible" {
  const options: number[][] = [];
  const chosen: number[] = [];
  const search = (blockIndex: number, messageIndex: number): void => {
    if (options.length > 1) return;
    if (blockIndex === fingerprints.length) {
      options.push([...chosen]);
      return;
    }
    for (let index = messageIndex; index < messages.length; index += 1) {
      if (messages[index]?.blockFingerprint !== fingerprints[blockIndex]) continue;
      chosen.push(index);
      search(blockIndex + 1, index + 1);
      chosen.pop();
    }
  };
  search(0, 0);
  if (options.length > 1) return "ambiguous";
  const only = options[0];
  if (!only) return "impossible";
  return only;
}

function applyLocalDeletions(markdown: string, chat: ChatExport): { chat: ChatExport; prefix: string } | { paused: true } {
  const parsed = parseTranscript(markdown);
  if (!parsed.ok) return { paused: true };
  if (parsed.value.blocks.length === chat.messages.length) return { chat, prefix: parsed.value.prefix };
  if (parsed.value.blocks.length > chat.messages.length) return { paused: true };
  const kept = uniqueKept(chat.messages, parsed.value.blocks.map((block) => block.blockFingerprint));
  if (kept === "ambiguous" || kept === "impossible") return { paused: true };
  if (kept.length === chat.messages.length) return { chat, prefix: parsed.value.prefix };
  const keep = new Set(kept);
  const removed = chat.messages.filter((_, index) => !keep.has(index));
  const messages = chat.messages.filter((_, index) => keep.has(index));
  const tombstones = [...chat.tombstones, ...removed.map((message) => ({ messageId: message.id, reason: "local-deletion" as const }))];
  return { chat: { ...chat, messages, tombstones }, prefix: parsed.value.prefix };
}

function gapsFor(ids: readonly string[], previous: readonly CoverageGap[], observed: readonly string[], contiguous: boolean): CoverageGap[] {
  const present = new Set(ids);
  let gaps = previous.filter((gap) => gap.afterId !== null && gap.beforeId !== null && present.has(gap.afterId) && present.has(gap.beforeId));
  if (contiguous && observed.length > 1) {
    const start = ids.indexOf(observed[0] ?? "");
    const end = ids.indexOf(observed[observed.length - 1] ?? "");
    if (start >= 0 && end > start) {
      gaps = gaps.filter((gap) => {
        const after = ids.indexOf(gap.afterId ?? "");
        const before = ids.indexOf(gap.beforeId ?? "");
        return !(after >= start && before <= end);
      });
    }
    return gaps;
  }
  for (let index = 0; index < observed.length - 1; index += 1) {
    const afterId = observed[index];
    const beforeId = observed[index + 1];
    if (!afterId || !beforeId || !present.has(afterId) || !present.has(beforeId)) continue;
    if (ids.indexOf(beforeId) !== ids.indexOf(afterId) + 1) continue;
    if (gaps.some((gap) => gap.afterId === afterId && gap.beforeId === beforeId)) continue;
    gaps.push({ afterId, beforeId, reason: "unverified-between" });
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
  if (current.length > 0) segments.push({ messageIds: current, anchorBefore: null, anchorAfter: null });
  return segments;
}

function draftsFor(ids: readonly string[], chat: ChatExport | null, observed: readonly ObservedMessage[]): MessageDraft[] {
  const saved = new Map((chat?.messages ?? []).map((message) => [message.id, message]));
  const seen = new Map(observed.map((message) => [message.id, message]));
  return ids.map((id) => {
    const existing = saved.get(id);
    const next = seen.get(id);
    if (existing) {
      return {
        id: existing.id,
        sender: existing.sender,
        timestamp: existing.timestamp,
        sequence: existing.sequence,
        text: existing.text,
        limitation: existing.limitation,
        attachments: existing.attachments,
        sourceBaseline: next?.sourceBaseline ?? existing.sourceBaseline,
        savedWordingBaseline: existing.savedWordingBaseline,
      };
    }
    if (!next) return null;
    return {
      id: next.id,
      sender: next.sender,
      timestamp: next.timestamp,
      sequence: next.sequence,
      text: next.text,
      limitation: null,
      attachments: next.attachments,
      sourceBaseline: next.sourceBaseline,
      savedWordingBaseline: next.sourceBaseline,
    };
  }).filter((message): message is MessageDraft => message !== null);
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
  let chat = input.chat;
  let prefix = input.prefix;
  if (chat && input.markdown !== null) {
    const local = applyLocalDeletions(input.markdown, chat);
    if ("paused" in local) return pause("ambiguous-local", input.markdown, null, chat, []);
    chat = local.chat;
    prefix = local.prefix;
  }
  const buried = new Set((chat?.tombstones ?? []).map((tombstone) => tombstone.messageId));
  const observedIds = input.observed.map((message) => message.id).filter((id) => !buried.has(id));
  if (input.order !== "verified") {
    const unresolved = observedIds.filter((id) => !chat?.messages.some((message) => message.id === id));
    if (unresolved.length > 0) return pause("unknown-order", input.markdown, null, chat, unresolved);
  }
  const merged = mergeIds(chat?.messages.map((message) => message.id) ?? [], observedIds, buried);
  if ("conflict" in merged) return pause("unknown-order", input.markdown, null, chat, observedIds);
  if ("disjoint" in merged) return pause("disjoint", input.markdown, null, chat, merged.disjoint);
  const inserted = merged.ids.filter((id) => !chat?.messages.some((message) => message.id === id));
  const gaps = gapsFor(merged.ids, chat?.coverage.gaps ?? [], observedIds, input.contiguous);
  const messages = draftsFor(merged.ids, chat, input.observed);
  const verified = input.order === "verified" && gaps.length === 0 && messages.every((message) => message.sequence === "verified");
  const draft: ExportDraft = {
    ...(chat ?? input.binding),
    accountId: chat?.accountId ?? input.binding.accountId,
    chatId: chat?.chatId ?? input.binding.chatId,
    destinationId: chat?.destinationId ?? input.binding.destinationId,
    generation: chat?.generation ?? input.binding.generation,
    chatKey: chat?.chatKey ?? input.chatKey,
    displayName: input.displayName,
    sourceOrder: verified ? "verified" : "unknown",
    messages,
    tombstones: chat?.tombstones ?? [],
    coverage: {
      segments: segmentsFor(merged.ids, gaps),
      gaps,
      requestedScope: input.requestedScope,
      stopReason: gaps.length > 0 ? "unverified-between" : null,
    },
  };
  if (draft.messages.length === 0) return pause("unknown-order", input.markdown, null, chat, []);
  const encoded = encodeExport(prefix, draft);
  if (!encoded.ok) return pause("ambiguous-local", input.markdown, null, chat, []);
  const removedLocally = (chat?.tombstones.length ?? 0) !== (input.chat?.tombstones.length ?? 0);
  const previous = chat ? encodeExport(prefix, chat) : null;
  const same = !removedLocally && previous?.ok === true && previous.value.markdown === encoded.value.markdown && previous.value.metadata === encoded.value.metadata;
  return {
    phase: same ? "unchanged" : "updated",
    reason: null,
    markdown: encoded.value.markdown,
    metadata: encoded.value.metadata,
    chat: encoded.value.chat,
    inserted,
    unresolved: [],
  };
}
