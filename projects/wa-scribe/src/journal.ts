import type { Binding } from "./model";

export const JOURNAL_SCHEMA = 1;
export const MAX_JOURNAL_BYTES = 256 * 1024;

export type JournalStep = "prepared" | "markdown" | "metadata" | "cleanup" | "committed";

export type Journal = {
  schema: number;
  binding: Binding;
  operationId: string;
  generation: string;
  step: JournalStep;
  markdown: string;
  metadata: string;
  cleanupIds: string[];
  unknownMutation: boolean;
};

export type Desk = {
  markdown: string | null;
  metadata: string | null;
  mediaIds: string[];
};

export type CommitPhase = "committed" | "recovery-required" | "paused" | "aborted" | "blocked";

export function journalBytes(journal: Journal): number {
  return new TextEncoder().encode(JSON.stringify(journal)).byteLength;
}

function paused(desk: Desk, journal: Journal | null): { desk: Desk; journal: Journal | null; phase: CommitPhase } {
  return { desk, journal, phase: "paused" };
}

export function recover(desk: Desk, journal: Journal | null): { desk: Desk; journal: Journal | null; phase: CommitPhase } {
  if (!journal) return { desk, journal: null, phase: "committed" };
  if (journal.schema !== JOURNAL_SCHEMA) return paused(desk, journal);
  if (journal.unknownMutation) return { desk, journal, phase: "recovery-required" };
  return finish(desk, journal);
}

function finish(desk: Desk, journal: Journal): { desk: Desk; journal: Journal | null; phase: CommitPhase } {
  return {
    desk: {
      markdown: journal.markdown,
      metadata: journal.metadata,
      mediaIds: desk.mediaIds.filter((id) => !journal.cleanupIds.includes(id)),
    },
    journal: null,
    phase: "committed",
  };
}

export function commitChat(input: {
  desk: Desk;
  journal: Journal | null;
  binding: Binding;
  operationId: string;
  generation: string;
  markdown: string;
  metadata: string;
  cleanupIds: string[];
  unknownMutation: boolean;
  failAt: JournalStep | null;
  capturedMarkdown: string | null;
  currentMarkdown: string | null;
}): { desk: Desk; journal: Journal | null; phase: CommitPhase } {
  if (input.journal && input.journal.schema !== JOURNAL_SCHEMA) return paused(input.desk, input.journal);
  if (input.journal && input.journal.unknownMutation && input.generation !== input.journal.generation) {
    return { desk: input.desk, journal: input.journal, phase: "blocked" };
  }
  if (input.journal && input.journal.step !== "committed" && input.journal.operationId !== input.operationId) {
    return { desk: input.desk, journal: input.journal, phase: "recovery-required" };
  }
  if (input.capturedMarkdown !== null && input.currentMarkdown !== input.capturedMarkdown) {
    return { desk: input.desk, journal: input.journal, phase: "aborted" };
  }
  const journal: Journal = {
    schema: JOURNAL_SCHEMA,
    binding: input.binding,
    operationId: input.operationId,
    generation: input.generation,
    step: "prepared",
    markdown: input.markdown,
    metadata: input.metadata,
    cleanupIds: input.cleanupIds,
    unknownMutation: input.unknownMutation,
  };
  if (journalBytes(journal) > MAX_JOURNAL_BYTES) return paused(input.desk, input.journal);
  if (input.failAt === "prepared") return { desk: input.desk, journal, phase: "recovery-required" };
  let desk = input.desk;
  journal.step = "markdown";
  desk = { ...desk, markdown: journal.markdown };
  if (input.failAt === "markdown") return { desk, journal, phase: "recovery-required" };
  journal.step = "metadata";
  desk = { ...desk, metadata: journal.metadata };
  if (input.failAt === "metadata") return { desk, journal, phase: "recovery-required" };
  if (input.failAt === "cleanup" || journal.unknownMutation) return { desk, journal: { ...journal, step: "cleanup" }, phase: "recovery-required" };
  desk = { ...desk, mediaIds: desk.mediaIds.filter((id) => !journal.cleanupIds.includes(id)) };
  return { desk, journal: null, phase: "committed" };
}

/** Stop does not roll back a transcript write that already landed. */
export function stopCommit(desk: Desk, journal: Journal | null): { desk: Desk; journal: Journal | null; phase: CommitPhase } {
  if (!journal || journal.step === "committed") return { desk, journal, phase: "committed" };
  return { desk, journal, phase: "recovery-required" };
}
