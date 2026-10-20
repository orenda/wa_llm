import {
  FORMAT_VERSION,
  type Attachment,
  type AttachmentSlot,
  type Binding,
  type ChatExport,
  type Coverage,
  type CoverageGap,
  type CoverageSegment,
  type ExportDraft,
  type MessageDraft,
  type ParsedBlock,
  type SavedMessage,
  type SequenceState,
  type SourceOrder,
  type TimePrecision,
  type Timestamp,
  type Tombstone,
} from "./model";

export type FailureReason =
  | "invalid-json"
  | "unsupported-version"
  | "missing-state"
  | "binding-mismatch"
  | "ambiguous-markdown"
  | "malformed-markdown"
  | "invalid-prefix"
  | "alignment-mismatch"
  | "fingerprint-mismatch"
  | "content-mismatch";

export type CodecFailure = {
  ok: false;
  outcome: "recovery-required" | "parse-error";
  reason: FailureReason;
  input: string;
};

export type CodecResult<T> = { ok: true; value: T } | CodecFailure;

export type AlignedPair = {
  message: SavedMessage;
  block: ParsedBlock;
};

const PRECISIONS: readonly TimePrecision[] = ["instant", "minute", "date", "display-only", "unknown"];
const HEADER_SPECS: readonly { key: string; required: boolean }[] = [
  { key: "sender-name", required: true },
  { key: "sender-key", required: false },
  { key: "time-display", required: true },
  { key: "time-precision", required: true },
  { key: "time-zone", required: false },
  { key: "instant", required: false },
  { key: "sequence", required: true },
  { key: "limitation", required: false },
];

function fail(outcome: CodecFailure["outcome"], reason: FailureReason, input: string): CodecFailure {
  return { ok: false, outcome, reason, input };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const got = Object.keys(value);
  return got.length === keys.length && keys.every((key) => got.includes(key));
}

/** Body lines that are structural sentinels, or that already start with a backslash, gain one backslash. */
function needsBodyEscape(line: string): boolean {
  return line === "### message" || line === "## Transcript" || line.startsWith("\\");
}

function escapeBodyLine(line: string): string {
  return needsBodyEscape(line) ? `\\${line}` : line;
}

function unescapeBodyLine(line: string): string | null {
  if (!line.startsWith("\\")) return line;
  const rest = line.slice(1);
  if (rest === "### message" || rest === "## Transcript" || rest.startsWith("\\")) return rest;
  return null;
}

function escapeHeader(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function unescapeHeader(value: string): string | null {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === undefined) return null;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = value[index + 1];
    if (next === "\\") out += "\\";
    else if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else return null;
    index += 1;
  }
  return out;
}

function fnv1a(text: string): string {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isPrecision(value: string): value is TimePrecision {
  return (PRECISIONS as readonly string[]).includes(value);
}

function isSequence(value: string): value is SequenceState {
  return value === "verified" || value === "unknown";
}

function isSourceOrder(value: string): value is SourceOrder {
  return value === "verified" || value === "unknown";
}

function idOk(value: string): boolean {
  return value.length > 0 && !value.includes("\n") && !value.includes("\r") && !value.includes("\0");
}

function isSafeRelative(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes(":") || path.includes("?") || path.includes("#") || path.includes("\0"))
    return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isPlainName(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\") && !value.includes(":") && !value.includes("\0");
}

function isMediaType(value: string): boolean {
  return value.length > 0 && !value.includes("://") && !value.includes("\\") && !value.includes("\0");
}

function attachmentOk(attachment: Attachment): boolean {
  if (attachment.state === "pending" || attachment.state === "unavailable")
    return attachment.limitation.length > 0 && !attachment.limitation.includes("://");
  if (attachment.state === "unsupported") return attachment.detail.length > 0 && !attachment.detail.includes("://");
  if (!isPlainName(attachment.name) || !isSafeRelative(attachment.relativePath) || encodedRelativePath(attachment.relativePath) === null) return false;
  if (attachment.state === "opaque") return attachment.mediaType === null || isMediaType(attachment.mediaType);
  return isMediaType(attachment.mediaType);
}

function canonicalAttachment(attachment: Attachment): Attachment {
  if (attachment.state === "pending" || attachment.state === "unavailable") return { state: attachment.state, limitation: attachment.limitation };
  if (attachment.state === "unsupported") return { state: "unsupported", detail: attachment.detail };
  if (attachment.state === "opaque") return { state: "opaque", name: attachment.name, mediaType: attachment.mediaType, relativePath: attachment.relativePath };
  return { state: "saved", name: attachment.name, mediaType: attachment.mediaType, relativePath: attachment.relativePath };
}

function attachmentJson(attachment: Attachment): string {
  return JSON.stringify(canonicalAttachment(attachment));
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodedRelativePath(path: string): string | null {
  try {
    return path.split("/").map(encodePathSegment).join("/");
  } catch {
    return null;
  }
}

function attachmentLinkLine(entry: AttachmentSlot): string | null {
  const attachment = entry.attachment;
  if (attachment.state !== "saved" && attachment.state !== "opaque") return null;
  const path = encodedRelativePath(attachment.relativePath);
  if (path === null) return null;
  return `attachment-link-${entry.slot}: [Open attachment](./${path})`;
}

function canonicalAttachments<T extends MessageDraft>(message: T): T {
  return {
    ...message,
    attachments: message.attachments.map((entry) => ({ slot: entry.slot, attachment: canonicalAttachment(entry.attachment) })),
  };
}

function sameSlots(left: readonly AttachmentSlot[], right: readonly AttachmentSlot[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const first = left[index];
    const second = right[index];
    if (first === undefined || second === undefined || first.slot !== second.slot || attachmentJson(first.attachment) !== attachmentJson(second.attachment))
      return false;
  }
  return true;
}

function knownInstantOk(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function timestampOk(timestamp: Timestamp): boolean {
  if (!isPrecision(timestamp.precision)) return false;
  if (timestamp.precision !== "unknown" && timestamp.display === "") return false;
  if (timestamp.timeZone === "") return false;
  if (timestamp.precision === "instant") return timestamp.instant !== null && knownInstantOk(timestamp.instant);
  return timestamp.instant === null;
}

function messageShapeOk(message: MessageDraft): boolean {
  if (message.text.includes("\r") || message.limitation === "" || message.sender.key === "") return false;
  if (!timestampOk(message.timestamp) || !isSequence(message.sequence)) return false;
  const slots = new Set<number>();
  for (const entry of message.attachments) {
    if (!Number.isSafeInteger(entry.slot) || entry.slot < 1 || slots.has(entry.slot) || !attachmentOk(entry.attachment)) return false;
    slots.add(entry.slot);
  }
  return true;
}

function prefixProblem(prefix: string): boolean {
  if (prefix === "") return false;
  if (!prefix.endsWith("\n")) return true;
  let start = 0;
  for (let index = 0; index <= prefix.length; index += 1) {
    if (index !== prefix.length && prefix[index] !== "\n") continue;
    let line = prefix.slice(start, index);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "## Transcript") return true;
    start = index + 1;
  }
  return false;
}

function renderBlock(message: MessageDraft): string | null {
  if (!messageShapeOk(message)) return null;
  const lines = ["### message", `sender-name: ${escapeHeader(message.sender.name)}`];
  if (message.sender.key !== null) lines.push(`sender-key: ${escapeHeader(message.sender.key)}`);
  lines.push(`time-display: ${escapeHeader(message.timestamp.display)}`, `time-precision: ${message.timestamp.precision}`);
  if (message.timestamp.timeZone !== null) lines.push(`time-zone: ${escapeHeader(message.timestamp.timeZone)}`);
  if (message.timestamp.instant !== null) lines.push(`instant: ${escapeHeader(message.timestamp.instant)}`);
  lines.push(`sequence: ${message.sequence}`);
  if (message.limitation !== null) lines.push(`limitation: ${escapeHeader(message.limitation)}`);
  for (const entry of message.attachments) {
    lines.push(`attachment: ${entry.slot} ${attachmentJson(entry.attachment)}`);
    const link = attachmentLinkLine(entry);
    if (link !== null) lines.push(link);
  }
  lines.push("");
  if (message.text !== "") {
    for (const line of message.text.split("\n")) lines.push(escapeBodyLine(line));
  }
  return `${lines.join("\n")}\n`;
}

export function renderTranscript(prefix: string, messages: readonly MessageDraft[]): CodecResult<string> {
  if (prefixProblem(prefix)) return fail("parse-error", "invalid-prefix", prefix);
  let body = "";
  for (const message of messages) {
    const block = renderBlock(message);
    if (block === null) return fail("parse-error", "malformed-markdown", prefix);
    body += block;
  }
  return { ok: true, value: `${prefix}## Transcript\n${body}` };
}

function locateTranscript(input: string): { prefix: string; generated: string } | "ambiguous" | "missing" {
  const hits: { start: number; ending: string }[] = [];
  let start = 0;
  for (let index = 0; index <= input.length; index += 1) {
    if (index !== input.length && input[index] !== "\n") continue;
    let line = input.slice(start, index);
    const crlf = line.endsWith("\r");
    if (crlf) line = line.slice(0, -1);
    if (line === "## Transcript") hits.push({ start, ending: crlf ? "\r\n" : index < input.length ? "\n" : "" });
    if (index === input.length) break;
    start = index + 1;
  }
  if (hits.length === 0) return "missing";
  if (hits.length > 1) return "ambiguous";
  const hit = hits[0];
  if (hit === undefined || hit.ending !== "\n") return "ambiguous";
  const marker = "## Transcript\n";
  return { prefix: input.slice(0, hit.start), generated: input.slice(hit.start + marker.length) };
}

function splitHeader(line: string): { key: string; value: string } | null {
  const mark = line.indexOf(": ");
  if (mark <= 0) return null;
  const key = line.slice(0, mark);
  if (!/^[a-z-]+$/.test(key)) return null;
  const value = unescapeHeader(line.slice(mark + 2));
  if (value === null) return null;
  return { key, value };
}

function normalizeAttachment(value: unknown): Attachment | null {
  if (!isRecord(value) || typeof value.state !== "string") return null;
  if (value.state === "pending" || value.state === "unavailable") {
    if (!exactKeys(value, ["state", "limitation"]) || typeof value.limitation !== "string") return null;
    const attachment: Attachment = { state: value.state, limitation: value.limitation };
    return attachmentOk(attachment) ? attachment : null;
  }
  if (value.state === "unsupported") {
    if (!exactKeys(value, ["state", "detail"]) || typeof value.detail !== "string") return null;
    const attachment: Attachment = { state: "unsupported", detail: value.detail };
    return attachmentOk(attachment) ? attachment : null;
  }
  if (value.state !== "opaque" && value.state !== "saved") return null;
  if (!exactKeys(value, ["state", "name", "mediaType", "relativePath"])) return null;
  if (typeof value.name !== "string" || typeof value.relativePath !== "string") return null;
  if (value.state === "opaque") {
    if (value.mediaType !== null && typeof value.mediaType !== "string") return null;
    const attachment: Attachment = { state: "opaque", name: value.name, mediaType: value.mediaType, relativePath: value.relativePath };
    return attachmentOk(attachment) ? attachment : null;
  }
  if (typeof value.mediaType !== "string") return null;
  const attachment: Attachment = { state: "saved", name: value.name, mediaType: value.mediaType, relativePath: value.relativePath };
  return attachmentOk(attachment) ? attachment : null;
}

function readAttachment(line: string): AttachmentSlot | null {
  const matched = /^attachment: ([1-9]\d*) (\{.*\})$/.exec(line);
  const slotText = matched?.[1];
  const jsonText = matched?.[2];
  if (slotText === undefined || jsonText === undefined) return null;
  try {
    const slot = Number(slotText);
    const attachment = normalizeAttachment(JSON.parse(jsonText));
    if (attachment === null || !Number.isSafeInteger(slot)) return null;
    return { slot, attachment };
  } catch {
    return null;
  }
}

function validAttachmentLink(line: string, entry: AttachmentSlot): boolean {
  return line === attachmentLinkLine(entry);
}

function timestampFrom(fields: Map<string, string>): Timestamp | null {
  const display = fields.get("time-display");
  const precision = fields.get("time-precision");
  if (display === undefined || precision === undefined || !isPrecision(precision)) return null;
  const timeZone = fields.has("time-zone") ? fields.get("time-zone") ?? null : null;
  const instant = fields.has("instant") ? fields.get("instant") ?? null : null;
  const timestamp: Timestamp = { display, precision, timeZone, instant };
  return timestampOk(timestamp) ? timestamp : null;
}

function readBlock(lines: readonly string[], start: number): { block: ParsedBlock; next: number } | null {
  if (lines[start] !== "### message") return null;
  const fields = new Map<string, string>();
  let index = start + 1;
  let specIndex = 0;
  while (specIndex < HEADER_SPECS.length) {
    const spec = HEADER_SPECS[specIndex];
    const line = lines[index];
    if (spec === undefined || line === undefined) return null;
    if (line === "" || line.startsWith("attachment: ")) {
      if (spec.required) return null;
      specIndex += 1;
      continue;
    }
    const header = splitHeader(line);
    if (header === null || header.key !== spec.key) {
      if (spec.required) return null;
      specIndex += 1;
      continue;
    }
    fields.set(spec.key, header.value);
    specIndex += 1;
    index += 1;
  }
  const attachments: AttachmentSlot[] = [];
  const seen = new Set<number>();
  const validatedLinkIndices = new Set<number>();
  while (lines[index] !== undefined && lines[index] !== "") {
    const entry = readAttachment(lines[index] ?? "");
    if (entry === null || seen.has(entry.slot)) return null;
    seen.add(entry.slot);
    attachments.push(entry);
    index += 1;
    const linkLine = lines[index];
    const expectedLink = attachmentLinkLine(entry);
    if (linkLine?.startsWith("attachment-link-")) {
      if (expectedLink === null || !validAttachmentLink(linkLine, entry)) return null;
      validatedLinkIndices.add(index);
      index += 1;
    }
  }
  if (lines[index] !== "") return null;
  index += 1;
  const name = fields.get("sender-name");
  const sequence = fields.get("sequence");
  const timestamp = timestampFrom(fields);
  if (name === undefined || sequence === undefined || !isSequence(sequence) || timestamp === null) return null;
  const senderKey = fields.has("sender-key") ? fields.get("sender-key") ?? null : null;
  if (senderKey === "") return null;
  const limitation = fields.has("limitation") ? fields.get("limitation") ?? null : null;
  if (limitation === "") return null;
  const body: string[] = [];
  while (index < lines.length && lines[index] !== "### message") {
    const unescaped = unescapeBodyLine(lines[index] ?? "");
    if (unescaped === null) return null;
    body.push(unescaped);
    index += 1;
  }
  const blockText = `${lines.slice(start, index).filter((_, lineIndex) => !validatedLinkIndices.has(start + lineIndex)).join("\n")}\n`;
  const block: ParsedBlock = {
    sender: { key: senderKey, name },
    timestamp,
    sequence,
    text: body.join("\n"),
    limitation,
    attachments,
    blockFingerprint: fnv1a(blockText),
  };
  return { block, next: index };
}

function parseGenerated(generated: string): ParsedBlock[] | null {
  if (generated === "") return [];
  if (generated.includes("\r") || !generated.endsWith("\n")) return null;
  const lines = generated.slice(0, -1).split("\n");
  const blocks: ParsedBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const read = readBlock(lines, index);
    if (read === null) return null;
    blocks.push(read.block);
    index = read.next;
  }
  return blocks;
}

export function parseTranscript(input: string): CodecResult<{ prefix: string; blocks: ParsedBlock[] }> {
  const located = locateTranscript(input);
  if (located === "missing") return fail("parse-error", "malformed-markdown", input);
  if (located === "ambiguous") return fail("parse-error", "ambiguous-markdown", input);
  if (prefixProblem(located.prefix)) return fail("parse-error", "invalid-prefix", input);
  const blocks = parseGenerated(located.generated);
  if (blocks === null) return fail("parse-error", "malformed-markdown", input);
  return { ok: true, value: { prefix: located.prefix, blocks } };
}

function sameVisible(block: ParsedBlock, message: MessageDraft): boolean {
  return (
    block.sequence === message.sequence &&
    block.text === message.text &&
    block.limitation === message.limitation &&
    block.sender.key === message.sender.key &&
    block.sender.name === message.sender.name &&
    block.timestamp.display === message.timestamp.display &&
    block.timestamp.precision === message.timestamp.precision &&
    block.timestamp.timeZone === message.timestamp.timeZone &&
    block.timestamp.instant === message.timestamp.instant &&
    sameSlots(block.attachments, message.attachments)
  );
}

export function alignByOrder(blocks: readonly ParsedBlock[], messages: readonly SavedMessage[], input = ""): CodecResult<AlignedPair[]> {
  if (blocks.length !== messages.length) return fail("parse-error", "alignment-mismatch", input);
  const pairs: AlignedPair[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const message = messages[index];
    if (block === undefined || message === undefined) return fail("parse-error", "alignment-mismatch", input);
    if (!sameVisible(block, message)) return fail("parse-error", "content-mismatch", input);
    if (block.blockFingerprint !== message.blockFingerprint) return fail("parse-error", "fingerprint-mismatch", input);
    pairs.push({ message, block });
  }
  return { ok: true, value: pairs };
}

function coverageOk(coverage: Coverage, messages: readonly MessageDraft[], sourceOrder: SourceOrder): boolean {
  if (coverage.requestedScope === "") return false;
  const seen = new Set<string>();
  for (const segment of coverage.segments) {
    if (segment.messageIds.length === 0) return false;
    if ((segment.anchorBefore !== null && !idOk(segment.anchorBefore)) || (segment.anchorAfter !== null && !idOk(segment.anchorAfter))) return false;
    for (const id of segment.messageIds) {
      if (!idOk(id) || seen.has(id)) return false;
      seen.add(id);
    }
  }
  for (const message of messages) {
    if (!seen.has(message.id)) return false;
  }
  if (seen.size !== messages.length) return false;
  for (const gap of coverage.gaps) {
    if (gap.reason === "") return false;
    if ((gap.afterId !== null && !idOk(gap.afterId)) || (gap.beforeId !== null && !idOk(gap.beforeId))) return false;
  }
  if (sourceOrder === "verified") {
    const ordered = coverage.segments.flatMap((segment) => segment.messageIds);
    if (coverage.gaps.length > 0 || ordered.length !== messages.length) return false;
    if (ordered.some((id, index) => id !== messages[index]?.id)) return false;
    if (messages.some((message) => message.sequence !== "verified")) return false;
  }
  return true;
}

function identityOk(chat: ExportDraft): boolean {
  if (!idOk(chat.accountId) || !idOk(chat.chatId) || !idOk(chat.destinationId) || !idOk(chat.generation)) return false;
  if (!idOk(chat.chatKey) || chat.displayName.includes("\0")) return false;
  const ids = new Set<string>();
  for (const message of chat.messages) {
    if (!idOk(message.id) || ids.has(message.id) || !messageShapeOk(message)) return false;
    ids.add(message.id);
  }
  const buried = new Set<string>();
  for (const tombstone of chat.tombstones) {
    if (tombstone.reason !== "local-deletion" || !idOk(tombstone.messageId) || ids.has(tombstone.messageId) || buried.has(tombstone.messageId))
      return false;
    buried.add(tombstone.messageId);
  }
  return coverageOk(chat.coverage, chat.messages, chat.sourceOrder);
}

function fingerprintsOf(messages: readonly MessageDraft[]): string[] | null {
  const rendered = renderTranscript("", messages);
  if (!rendered.ok) return null;
  const parsed = parseTranscript(rendered.value);
  if (!parsed.ok || parsed.value.blocks.length !== messages.length) return null;
  return parsed.value.blocks.map((block, index) => (sameVisible(block, messages[index]!) ? block.blockFingerprint : ""));
}

function documentFrom(chat: ChatExport): Record<string, unknown> {
  return {
    formatVersion: FORMAT_VERSION,
    accountId: chat.accountId,
    chatId: chat.chatId,
    chatKey: chat.chatKey,
    destinationId: chat.destinationId,
    generation: chat.generation,
    displayName: chat.displayName,
    sourceOrder: chat.sourceOrder,
    messages: chat.messages.map(canonicalAttachments),
    tombstones: chat.tombstones,
    coverage: chat.coverage,
  };
}

export function encodeMetadata(chat: ChatExport): CodecResult<string> {
  if (chat.formatVersion !== FORMAT_VERSION || !identityOk(chat)) return fail("recovery-required", "missing-state", "");
  const fingerprints = fingerprintsOf(chat.messages);
  if (fingerprints === null) return fail("recovery-required", "missing-state", "");
  for (let index = 0; index < chat.messages.length; index += 1) {
    if (chat.messages[index]?.blockFingerprint !== fingerprints[index]) return fail("recovery-required", "fingerprint-mismatch", "");
  }
  return { ok: true, value: `${JSON.stringify(documentFrom(chat), null, 2)}\n` };
}

export function encodeExport(prefix: string, draft: ExportDraft): CodecResult<{ markdown: string; metadata: string; chat: ChatExport }> {
  if (!identityOk(draft)) return fail("recovery-required", "missing-state", prefix);
  const rendered = renderTranscript(prefix, draft.messages);
  if (!rendered.ok) return rendered;
  const parsed = parseTranscript(rendered.value);
  if (!parsed.ok || parsed.value.prefix !== prefix || parsed.value.blocks.length !== draft.messages.length)
    return fail("parse-error", "malformed-markdown", prefix);
  const messages = draft.messages.map((message, index) =>
    canonicalAttachments({ ...message, blockFingerprint: parsed.value.blocks[index]!.blockFingerprint }),
  );
  const chat: ChatExport = { ...draft, formatVersion: FORMAT_VERSION, messages };
  const metadata = encodeMetadata(chat);
  if (!metadata.ok) return { ...metadata, input: metadata.input || prefix };
  return { ok: true, value: { markdown: rendered.value, metadata: metadata.value, chat } };
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const got = value[key];
  return typeof got === "string" ? got : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function readTimestamp(value: unknown): Timestamp | null {
  if (!isRecord(value) || !exactKeys(value, ["display", "precision", "timeZone", "instant"])) return null;
  if (typeof value.display !== "string" || typeof value.precision !== "string" || !isPrecision(value.precision)) return null;
  const timeZone = nullableString(value.timeZone);
  const instant = nullableString(value.instant);
  if (timeZone === undefined || instant === undefined) return null;
  const timestamp: Timestamp = { display: value.display, precision: value.precision, timeZone, instant };
  return timestampOk(timestamp) ? timestamp : null;
}

function readSlot(value: unknown): AttachmentSlot | null {
  if (!isRecord(value) || !exactKeys(value, ["slot", "attachment"]) || typeof value.slot !== "number") return null;
  const attachment = normalizeAttachment(value.attachment);
  if (attachment === null || !Number.isSafeInteger(value.slot) || value.slot < 1) return null;
  return { slot: value.slot, attachment };
}

function readMessage(value: unknown): SavedMessage | null {
  if (!isRecord(value)) return null;
  const keys = ["id", "sender", "timestamp", "sequence", "text", "limitation", "attachments", "sourceBaseline", "savedWordingBaseline", "blockFingerprint"];
  if (!exactKeys(value, keys) || typeof value.id !== "string" || typeof value.text !== "string") return null;
  if (typeof value.sequence !== "string" || !isSequence(value.sequence)) return null;
  if (typeof value.sourceBaseline !== "string" || typeof value.savedWordingBaseline !== "string") return null;
  if (typeof value.blockFingerprint !== "string" || !/^[0-9a-f]{8}$/.test(value.blockFingerprint)) return null;
  const limitation = nullableString(value.limitation);
  if (limitation === undefined || !isRecord(value.sender) || !exactKeys(value.sender, ["key", "name"])) return null;
  const senderKey = nullableString(value.sender.key);
  if (senderKey === undefined || typeof value.sender.name !== "string" || !Array.isArray(value.attachments)) return null;
  const timestamp = readTimestamp(value.timestamp);
  if (timestamp === null) return null;
  const attachments: AttachmentSlot[] = [];
  for (const entry of value.attachments) {
    const slot = readSlot(entry);
    if (slot === null) return null;
    attachments.push(slot);
  }
  const message: SavedMessage = {
    id: value.id,
    sender: { key: senderKey, name: value.sender.name },
    timestamp,
    sequence: value.sequence,
    text: value.text,
    limitation,
    attachments,
    sourceBaseline: value.sourceBaseline,
    savedWordingBaseline: value.savedWordingBaseline,
    blockFingerprint: value.blockFingerprint,
  };
  return messageShapeOk(message) ? message : null;
}

function readCoverage(value: unknown): Coverage | null {
  if (!isRecord(value) || !exactKeys(value, ["segments", "gaps", "requestedScope", "stopReason"])) return null;
  if (typeof value.requestedScope !== "string" || !Array.isArray(value.segments) || !Array.isArray(value.gaps)) return null;
  const stopReason = nullableString(value.stopReason);
  if (stopReason === undefined) return null;
  const segments: CoverageSegment[] = [];
  for (const entry of value.segments) {
    if (!isRecord(entry) || !exactKeys(entry, ["messageIds", "anchorBefore", "anchorAfter"]) || !Array.isArray(entry.messageIds)) return null;
    const anchorBefore = nullableString(entry.anchorBefore);
    const anchorAfter = nullableString(entry.anchorAfter);
    if (anchorBefore === undefined || anchorAfter === undefined) return null;
    const messageIds: string[] = [];
    for (const id of entry.messageIds) {
      if (typeof id !== "string") return null;
      messageIds.push(id);
    }
    segments.push({ messageIds, anchorBefore, anchorAfter });
  }
  const gaps: CoverageGap[] = [];
  for (const entry of value.gaps) {
    if (!isRecord(entry) || !exactKeys(entry, ["afterId", "beforeId", "reason"]) || typeof entry.reason !== "string") return null;
    const afterId = nullableString(entry.afterId);
    const beforeId = nullableString(entry.beforeId);
    if (afterId === undefined || beforeId === undefined) return null;
    gaps.push({ afterId, beforeId, reason: entry.reason });
  }
  return { segments, gaps, requestedScope: value.requestedScope, stopReason };
}

function readChat(value: unknown): ChatExport | null {
  if (!isRecord(value)) return null;
  const keys = ["formatVersion", "accountId", "chatId", "chatKey", "destinationId", "generation", "displayName", "sourceOrder", "messages", "tombstones", "coverage"];
  if (!exactKeys(value, keys) || value.formatVersion !== FORMAT_VERSION || !Array.isArray(value.messages) || !Array.isArray(value.tombstones))
    return null;
  const accountId = stringField(value, "accountId");
  const chatId = stringField(value, "chatId");
  const chatKey = stringField(value, "chatKey");
  const destinationId = stringField(value, "destinationId");
  const generation = stringField(value, "generation");
  const displayName = stringField(value, "displayName");
  if (accountId === null || chatId === null || chatKey === null || destinationId === null || generation === null || displayName === null)
    return null;
  if (typeof value.sourceOrder !== "string" || !isSourceOrder(value.sourceOrder)) return null;
  const messages: SavedMessage[] = [];
  for (const entry of value.messages) {
    const message = readMessage(entry);
    if (message === null) return null;
    messages.push(message);
  }
  const tombstones: Tombstone[] = [];
  for (const entry of value.tombstones) {
    if (!isRecord(entry) || !exactKeys(entry, ["messageId", "reason"]) || entry.reason !== "local-deletion" || typeof entry.messageId !== "string")
      return null;
    tombstones.push({ messageId: entry.messageId, reason: "local-deletion" });
  }
  const coverage = readCoverage(value.coverage);
  if (coverage === null) return null;
  return { formatVersion: FORMAT_VERSION, accountId, chatId, chatKey, destinationId, generation, displayName, sourceOrder: value.sourceOrder, messages, tombstones, coverage };
}

function sameBinding(chat: Binding, expected: Binding): boolean {
  return chat.accountId === expected.accountId && chat.chatId === expected.chatId && chat.destinationId === expected.destinationId && chat.generation === expected.generation;
}

export function decodeMetadata(input: string, expected: Binding): CodecResult<ChatExport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return fail("recovery-required", "invalid-json", input);
  }
  if (!isRecord(parsed) || !("formatVersion" in parsed)) return fail("recovery-required", "missing-state", input);
  if (parsed.formatVersion !== FORMAT_VERSION) return fail("recovery-required", "unsupported-version", input);
  const chat = readChat(parsed);
  if (chat === null || !identityOk(chat)) return fail("recovery-required", "missing-state", input);
  if (!sameBinding(chat, expected)) return fail("recovery-required", "binding-mismatch", input);
  const fingerprints = fingerprintsOf(chat.messages);
  if (fingerprints === null) return fail("recovery-required", "missing-state", input);
  for (let index = 0; index < chat.messages.length; index += 1) {
    if (chat.messages[index]?.blockFingerprint !== fingerprints[index]) return fail("recovery-required", "fingerprint-mismatch", input);
  }
  return { ok: true, value: chat };
}
