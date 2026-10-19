import { downloadPass, type ObservedMessage } from "./download";
import { commitChat, type Desk, type Journal } from "./journal";
import type { Binding, Timestamp } from "./model";
import { readSource, type SourceMessage } from "./source";

export type AlphaResult = {
  phase: "updated" | "unchanged" | "paused";
  reason: string | null;
  ids: string[];
  desk: Desk;
  journal: Journal | null;
};

function observedFrom(message: SourceMessage): ObservedMessage {
  const timestamp: Timestamp = { display: message.timeDisplay, precision: message.precision, timeZone: null, instant: null };
  return {
    id: message.id,
    sender: { key: message.senderKey, name: message.senderName },
    timestamp,
    sequence: message.sequence,
    text: message.text,
    attachments: [],
    sourceBaseline: message.text,
  };
}

/** Fixture text download. It does not call Google and it is not a v1 export. */
export function runTextDownload(input: {
  html: string;
  expected: { accountId: string; chatId: string };
  prefix: string;
  binding: Binding;
  chatKey: string;
  displayName: string;
  desk: Desk;
  journal: Journal | null;
  chat: import("./model").ChatExport | null;
}): AlphaResult {
  const read = readSource(input.html, input.expected);
  if (!read.ok) return { phase: "paused", reason: read.reason, ids: [], desk: input.desk, journal: input.journal };
  const downloaded = downloadPass({
    prefix: input.prefix,
    markdown: input.desk.markdown,
    chat: input.chat,
    binding: input.binding,
    chatKey: input.chatKey,
    displayName: input.displayName,
    observed: read.snapshot.messages.map(observedFrom),
    order: read.snapshot.order,
    contiguous: false,
    requestedScope: "fixture",
  });
  if (downloaded.phase === "paused" || !downloaded.markdown || !downloaded.metadata) {
    return { phase: "paused", reason: downloaded.reason, ids: [], desk: input.desk, journal: input.journal };
  }
  const committed = commitChat({
    desk: input.desk,
    journal: input.journal,
    binding: input.binding,
    operationId: `download-${read.snapshot.chatId}`,
    generation: input.binding.generation,
    markdown: downloaded.markdown,
    metadata: downloaded.metadata,
    cleanupIds: [],
    unknownMutation: false,
    failAt: null,
    capturedMarkdown: input.desk.markdown,
    currentMarkdown: input.desk.markdown,
  });
  return {
    phase: downloaded.phase,
    reason: null,
    ids: downloaded.chat?.messages.map((message) => message.id) ?? [],
    desk: committed.desk,
    journal: committed.journal,
  };
}
