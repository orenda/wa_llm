import { downloadPass, type DownloadResult, type ObservedMessage } from "./download";
import { encodeExport, parseTranscript } from "./format";
import type { Binding, ChatExport, ExportDraft, MessageDraft } from "./model";

export type EditResult = DownloadResult & { conflicts: string[] };

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
  // Download validates binding and exact local block alignment before any source change.
  const placed = downloadPass(input);
  if (placed.phase === "paused" || !placed.chat || placed.markdown === null) {
    const parsed = input.markdown === null ? null : parseTranscript(input.markdown);
    const conflicts = placed.reason === "local-edit" && parsed?.ok
      ? input.chat?.messages.filter((message, index) => parsed.value.blocks[index]?.blockFingerprint !== message.blockFingerprint).map((message) => message.id) ?? []
      : [];
    return { ...placed, conflicts };
  }
  const deleted = new Set(input.deletedIds);
  const observed = new Map(input.observed.map((message) => [message.id, message]));
  const messages: MessageDraft[] = [];
  for (const message of placed.chat.messages) {
    if (deleted.has(message.id)) continue;
    const next = observed.get(message.id);
    messages.push(next && next.sourceBaseline !== message.savedWordingBaseline
      ? { ...message, text: next.text, sourceBaseline: next.sourceBaseline, savedWordingBaseline: next.sourceBaseline }
      : message);
  }
  const changed = placed.chat.messages.length !== messages.length || messages.some((message, index) =>
    message.text !== placed.chat?.messages[index]?.text || message.savedWordingBaseline !== placed.chat?.messages[index]?.savedWordingBaseline);
  if (!changed) return { ...placed, conflicts: [] };
  const kept = new Set(messages.map((message) => message.id));
  const gaps = placed.chat.coverage.gaps.map((gap) => ({
    ...gap,
    afterId: gap.afterId !== null && kept.has(gap.afterId) ? gap.afterId : null,
    beforeId: gap.beforeId !== null && kept.has(gap.beforeId) ? gap.beforeId : null,
  }));
  const segments = placed.chat.coverage.segments
    .map((segment) => ({ ...segment, messageIds: segment.messageIds.filter((id) => kept.has(id)) }))
    .filter((segment) => segment.messageIds.length > 0);
  const draft: ExportDraft = {
    ...placed.chat,
    messages,
    sourceOrder: placed.chat.sourceOrder === "verified" && gaps.length === 0 ? "verified" : "unknown",
    coverage: { ...placed.chat.coverage, gaps, segments },
  };
  const parsed = parseTranscript(placed.markdown);
  const encoded = encodeExport(parsed.ok ? parsed.value.prefix : input.prefix, draft);
  if (!encoded.ok) return { phase: "paused", reason: "missing-state", markdown: input.markdown, metadata: null, chat: input.chat, inserted: [], unresolved: [], conflicts: [] };
  return { phase: "updated", reason: null, markdown: encoded.value.markdown, metadata: encoded.value.metadata, chat: encoded.value.chat, inserted: placed.inserted, unresolved: [], conflicts: [] };
}
