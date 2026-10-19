export const FORMAT_VERSION = 1;

export type TimePrecision = "instant" | "minute" | "date" | "display-only" | "unknown";

export type SequenceState = "verified" | "unknown";

export type SourceOrder = "verified" | "unknown";

export type Timestamp = {
  display: string;
  precision: TimePrecision;
  timeZone: string | null;
  instant: string | null;
};

export type Sender = {
  key: string | null;
  name: string;
};

export type Attachment =
  | { state: "pending"; limitation: string }
  | { state: "unavailable"; limitation: string }
  | { state: "unsupported"; detail: string }
  | { state: "opaque"; name: string; mediaType: string | null; relativePath: string }
  | { state: "saved"; name: string; mediaType: string; relativePath: string };

export type AttachmentSlot = {
  slot: number;
  attachment: Attachment;
};

/** Caller-supplied message. The rendered block fingerprint is not known yet. */
export type MessageDraft = {
  id: string;
  sender: Sender;
  timestamp: Timestamp;
  sequence: SequenceState;
  text: string;
  limitation: string | null;
  attachments: AttachmentSlot[];
  sourceBaseline: string;
  savedWordingBaseline: string;
};

/** Message as stored in the sidecar, including the fingerprint of its rendered block. */
export type SavedMessage = MessageDraft & {
  blockFingerprint: string;
};

export type Tombstone = {
  messageId: string;
  reason: "local-deletion";
};

export type CoverageSegment = {
  messageIds: string[];
  anchorBefore: string | null;
  anchorAfter: string | null;
};

export type CoverageGap = {
  afterId: string | null;
  beforeId: string | null;
  reason: string;
};

export type Coverage = {
  segments: CoverageSegment[];
  gaps: CoverageGap[];
  requestedScope: string;
  stopReason: string | null;
};

/** Expected account, chat, destination, and export generation. */
export type Binding = {
  accountId: string;
  chatId: string;
  destinationId: string;
  generation: string;
};

export type ExportDraft = Binding & {
  chatKey: string;
  displayName: string;
  sourceOrder: SourceOrder;
  messages: MessageDraft[];
  tombstones: Tombstone[];
  coverage: Coverage;
};

export type ChatExport = Binding & {
  formatVersion: typeof FORMAT_VERSION;
  chatKey: string;
  displayName: string;
  sourceOrder: SourceOrder;
  messages: SavedMessage[];
  tombstones: Tombstone[];
  coverage: Coverage;
};

/** One parsed Markdown block. Identity is not recovered from the prose. */
export type ParsedBlock = {
  sender: Sender;
  timestamp: Timestamp;
  sequence: SequenceState;
  text: string;
  limitation: string | null;
  attachments: AttachmentSlot[];
  blockFingerprint: string;
};
