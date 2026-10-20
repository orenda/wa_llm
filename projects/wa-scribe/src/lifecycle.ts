import { decodeMetadata } from "./format";
import type { Binding, ChatExport } from "./model";

export function editModeWarning(): string {
  return "Edit mode can remove saved messages that WhatsApp showed as changed or deleted. Finish editing the file before starting.";
}

export type OwnedFile = { id: string; generation: string; kind: "transcript" | "metadata" | "media" | "foreign" };

export function deleteExport(files: readonly OwnedFile[], generation: string, failAfter: number | null = null): { deleted: string[]; remaining: string[]; foreign: string[] } {
  const foreign = files.filter((file) => file.kind === "foreign" || file.generation !== generation).map((file) => file.id);
  const owned = files.filter((file) => file.kind !== "foreign" && file.generation === generation);
  const limit = failAfter === null ? owned.length : failAfter;
  return {
    deleted: owned.slice(0, limit).map((file) => file.id),
    remaining: owned.slice(limit).map((file) => file.id),
    foreign,
  };
}

export function freshExport(previousRoot: string): {
  rootId: null;
  rootPlan: "allocate-new-root";
  generation: string;
  previousRoot: string;
  warning: string;
} {
  return {
    rootId: null,
    rootPlan: "allocate-new-root",
    generation: crypto.randomUUID(),
    previousRoot,
    warning: "A fresh export does not inherit local-deletion tombstones from missing metadata. The previous tree is left in place.",
  };
}

export function restoreCheckpoint(checkpoint: unknown, expected: Binding): { restored: ChatExport } | { phase: "recovery-required" } {
  if (typeof checkpoint !== "string") return { phase: "recovery-required" };
  const decoded = decodeMetadata(checkpoint, expected);
  if (!decoded.ok) return { phase: "recovery-required" };
  return { restored: decoded.value };
}

export function richMarker(kind: "quote" | "poll" | "reaction" | "contact" | "location" | "view-once", text: string | null): { text: string; limitation: string; opened: false } {
  if (kind === "view-once") return { text: text ?? "", limitation: "view-once content was not opened", opened: false };
  if (kind === "quote") return { text: text ?? "", limitation: "quoted text only; the original chat was not opened", opened: false };
  return { text: text ?? "", limitation: `${kind} is preserved as an unsupported marker`, opened: false };
}

export function aggregate(results: readonly { chatId: string; result: string }[]): { overall: "complete" | "partial"; failed: string[] } {
  const failed = results.filter((result) => result.result !== "complete for requested scope").map((result) => result.chatId);
  return { overall: failed.length === 0 ? "complete" : "partial", failed };
}

export function accountChanged(previousAccount: string, nextAccount: string): { paused: boolean } {
  return { paused: previousAccount !== nextAccount };
}
