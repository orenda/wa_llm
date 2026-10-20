import type { Attachment, AttachmentSlot, MessageDraft } from "./model";

export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const MAX_MEDIA_ATTEMPTS = 3;

export type ByteClass = "original" | "empty-document" | "thumbnail" | "error-page" | "over-budget";

const encoder = new TextEncoder();

export function slotPath(chatKey: string, messageId: string, slot: number, extension: string): string {
  const safeExtension = extension.replace(/[^a-z0-9]/gi, "") || "bin";
  return `media/${chatKey}/${messageId}-${String(slot).padStart(2, "0")}.${safeExtension}`;
}

export function classifyBytes(bytes: Uint8Array, claimedType: string | null): ByteClass {
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return "over-budget";
  const head = new TextDecoder().decode(bytes.slice(0, 64)).trim().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "error-page";
  if (bytes.byteLength === 0 && claimedType === "text/plain") return "empty-document";
  if (bytes.byteLength > 0 && bytes.byteLength < 64 && claimedType?.startsWith("image/")) return "thumbnail";
  if (bytes.byteLength === 0) return "thumbnail";
  return "original";
}

export function shouldRetry(state: Attachment["state"], attempt: number, userRequested: boolean): boolean {
  if (attempt >= MAX_MEDIA_ATTEMPTS) return false;
  if (state === "unsupported") return userRequested;
  return state === "pending";
}

export function stageAttachment(input: {
  chatKey: string;
  messageId: string;
  slot: number;
  name: string;
  claimedType: string | null;
  bytes: Uint8Array | null;
  originalEvidence?: { resourceVerified: boolean; complete: boolean };
  tombstoned: boolean;
}): AttachmentSlot | { suppressed: true } | { limited: string } {
  if (input.tombstoned) return { suppressed: true };
  if (!/^[a-zA-Z0-9_-]+$/.test(input.chatKey) || !/^[a-zA-Z0-9_-]+$/.test(input.messageId) ||
      !Number.isSafeInteger(input.slot) || input.slot < 1) {
    return { limited: "invalid attachment path or slot" };
  }
  if (input.bytes === null) {
    return { slot: input.slot, attachment: { state: "pending", limitation: "bytes were not delivered" } };
  }
  if (input.originalEvidence?.resourceVerified !== true || input.originalEvidence.complete !== true) {
    return { slot: input.slot, attachment: { state: "unavailable", limitation: "original completeness was not verified" } };
  }
  const verdict = classifyBytes(input.bytes, input.claimedType);
  if (verdict === "error-page" || verdict === "thumbnail") {
    return { slot: input.slot, attachment: { state: "unavailable", limitation: verdict } };
  }
  if (verdict === "over-budget") return { limited: "attachment byte budget" };
  if (verdict === "empty-document") {
    return {
      slot: input.slot,
      attachment: { state: "saved", name: input.name, mediaType: "text/plain", relativePath: slotPath(input.chatKey, input.messageId, input.slot, "txt") },
    };
  }
  const known = input.claimedType !== null && input.claimedType !== "application/octet-stream";
  if (!known) {
    return {
      slot: input.slot,
      attachment: {
        state: "opaque",
        name: input.name,
        mediaType: input.claimedType,
        relativePath: slotPath(input.chatKey, input.messageId, input.slot, "bin"),
      },
    };
  }
  const extension = input.claimedType?.includes("jpeg") ? "jpg" : input.claimedType?.includes("ogg") ? "ogg" : "bin";
  return {
    slot: input.slot,
    attachment: {
      state: "saved",
      name: input.name,
      mediaType: input.claimedType ?? "application/octet-stream",
      relativePath: slotPath(input.chatKey, input.messageId, input.slot, extension),
    },
  };
}

export function enrich(
  message: MessageDraft,
  slot: AttachmentSlot,
  tombstoned: boolean,
  expectedBaseline?: AttachmentSlot,
): MessageDraft | { suppressed: true } | { conflict: true } {
  if (tombstoned) return { suppressed: true };
  const existing = message.attachments.find((entry) => entry.slot === slot.slot);
  if (existing && (expectedBaseline === undefined || JSON.stringify(existing) !== JSON.stringify(expectedBaseline))) return { conflict: true };
  if (!existing && expectedBaseline !== undefined) return { conflict: true };
  const attachments = [...message.attachments.filter((entry) => entry.slot !== slot.slot), slot].sort((left, right) => left.slot - right.slot);
  return { ...message, text: message.text, attachments };
}

export function containsSignedUrl(value: string): boolean {
  return value.includes("://");
}

export function acceptRevision(captured: string, current: string, tombstoned: boolean): { link: true } | { deferred: "revision-changed" } | { suppressed: true } {
  if (tombstoned) return { suppressed: true };
  if (captured !== current) return { deferred: "revision-changed" };
  return { link: true };
}

export function classifyMissingFile(filePresent: boolean, tombstoned: boolean): { availability: "saved" | "missing-bytes" | "suppressed"; messageDeleted: false } {
  if (tombstoned) return { availability: "suppressed", messageDeleted: false };
  if (!filePresent) return { availability: "missing-bytes", messageDeleted: false };
  return { availability: "saved", messageDeleted: false };
}

export function sampleErrorPage(): Uint8Array {
  return encoder.encode("<!doctype html><title>login</title>");
}
