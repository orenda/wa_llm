import { downloadPass, type DownloadResult, type ObservedMessage } from "./download";
import { encodeExport, parseTranscript } from "./format";
import type { Binding, ChatExport, CoverageGap, ExportDraft, MessageDraft } from "./model";

export type EditResult = DownloadResult & { conflicts: string[] };

function localText(markdown: string | null, chat: ChatExport | null): Map<string, string> | "paused" {
  if (!markdown || !chat) return new Map();
  const parsed = parseTranscript(markdown);
  if (!parsed.ok || parsed.value.blocks.length !== chat.messages.length) return new Map();
  const found = new Map<string, string>();
  for (let index = 0; index < chat.messages.length; index += 1) {
    const message = chat.messages[index];
    const block = parsed.value.blocks[index];
    if (!message || !block) return "paused";
    if (block.text !== message.text) found.set(message.id, block.text);
  }
  return found;
}

export function editPass(input: {
  prefix: string;
  markdown: string | null;
  chat: ChatExport | null;
  binding: Binding;
  chatKey: string;
  displayName: string;
  observed: ObservedMessage[];
  deletedIds: string[];
  order: "verified" | "unknown";
  contiguous: boolean;
  requestedScope: string;
}): EditResult {
  const locals = localText(input.markdown, input.chat);
  if (locals === "paused") {
    return { phase: "paused", reason: "ambiguous-local", markdown: input.markdown, metadata: null, chat: input.chat, inserted: [], unresolved: [], conflicts: [] };
  }
  const placed = downloadPass(input);
  if (placed.phase === "paused" || !placed.chat || placed.markdown === null) return { ...placed, conflicts: [] };
  const deleted = new Set(input.deletedIds);
  const observed = new Map(input.observed.map((message) => [message.id, message]));
  const conflicts: string[] = [];
  const messages: MessageDraft[] = [];
  for (const message of placed.chat.messages) {
    if (deleted.has(message.id)) continue;
    const next = observed.get(message.id);
    const local = locals.get(message.id);
    if (local !== undefined && next && next.text !== message.text) {
      conflicts.push(message.id);
      messages.push({ ...message, text: local, savedWordingBaseline: local, sourceBaseline: next.sourceBaseline });
      continue;
    }
    if (next && next.text !== message.text && local === undefined) {
      messages.push({ ...message, text: next.text, sourceBaseline: next.sourceBaseline, savedWordingBaseline: next.sourceBaseline });
      continue;
    }
    messages.push(message);
  }
  const changed =
    placed.chat.messages.length !== messages.length ||
    conflicts.length > 0 ||
    messages.some((message, index) => message.text !== placed.chat?.messages[index]?.text);
  if (!changed) return { ...placed, conflicts };
  const kept = new Set(messages.map((message) => message.id));
  const gaps: CoverageGap[] = placed.chat.coverage.gaps.filter(
    (gap) => gap.afterId !== null && gap.beforeId !== null && kept.has(gap.afterId) && kept.has(gap.beforeId),
  );
  const segments = placed.chat.coverage.segments
    .map((segment) => ({ ...segment, messageIds: segment.messageIds.filter((id) => kept.has(id)) }))
    .filter((segment) => segment.messageIds.length > 0);
  const draft: ExportDraft = {
    ...placed.chat,
    messages,
    displayName: input.displayName,
    sourceOrder: gaps.length === 0 && messages.every((message) => message.sequence === "verified") ? "verified" : "unknown",
    coverage: { ...placed.chat.coverage, gaps, segments, stopReason: gaps.length > 0 ? placed.chat.coverage.stopReason : null },
  };
  const parsed = parseTranscript(placed.markdown);
  const encoded = encodeExport(parsed.ok ? parsed.value.prefix : input.prefix, draft);
  if (!encoded.ok) {
    return { phase: "paused", reason: "ambiguous-local", markdown: input.markdown, metadata: null, chat: input.chat, inserted: [], unresolved: [], conflicts };
  }
  return {
    phase: "updated",
    reason: null,
    markdown: encoded.value.markdown,
    metadata: encoded.value.metadata,
    chat: encoded.value.chat,
    inserted: placed.inserted,
    unresolved: [],
    conflicts,
  };
}
