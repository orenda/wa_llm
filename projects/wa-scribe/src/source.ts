import type { TimePrecision } from "./model";

const PRECISIONS: readonly TimePrecision[] = ["instant", "minute", "date", "display-only", "unknown"];

export type SourceDiagnostic = {
  mode: "diagnostic";
  accountPresent: boolean;
  chatPresent: boolean;
  rowCount: number;
  placeholderCount: number;
  rowsMissingId: number;
};

export type SourceMessage = {
  id: string;
  senderKey: string | null;
  senderName: string;
  timeDisplay: string;
  precision: TimePrecision;
  text: string;
  sequence: "verified" | "unknown";
};

export type SourceSnapshot = {
  accountId: string;
  chatId: string;
  order: "verified" | "unknown";
  messages: SourceMessage[];
};

export type SourceFailure = {
  ok: false;
  reason: "missing-account" | "missing-chat" | "unknown-order" | "unresolved-row" | "chat-mismatch";
  index: number | null;
};

export type SourceRead = { ok: true; snapshot: SourceSnapshot } | SourceFailure;

function isPrecision(value: string): value is TimePrecision {
  return (PRECISIONS as readonly string[]).includes(value);
}

function attr(opening: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(opening);
  const value = match?.[1];
  return value === undefined || value.length === 0 ? null : value;
}

function decode(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function articles(html: string): { opening: string; inner: string }[] {
  const found: { opening: string; inner: string }[] = [];
  const pattern = /<article\b([^>]*)>([\s\S]*?)<\/article>/gi;
  for (const match of html.matchAll(pattern)) {
    found.push({ opening: match[1] ?? "", inner: match[2] ?? "" });
  }
  return found;
}

function selectedMain(html: string): { opening: string; inner: string } | null {
  const matches = [...html.matchAll(/<main\b([^>]*)>([\s\S]*?)<\/main>/gi)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (!match || /<main\b/i.test(match[2] ?? "")) return null;
  return { opening: match[1] ?? "", inner: match[2] ?? "" };
}

/** Counts structure only. Message text is not returned. */
export function diagnose(html: string): SourceDiagnostic {
  const selected = selectedMain(html);
  const main = selected?.opening ?? null;
  const rows = articles(selected?.inner ?? "");
  return {
    mode: "diagnostic",
    accountPresent: main !== null && attr(main, "data-account-id") !== null,
    chatPresent: main !== null && attr(main, "data-chat-id") !== null,
    rowCount: rows.length,
    placeholderCount: rows.filter((row) => attr(row.opening, "data-placeholder") !== null).length,
    rowsMissingId: rows.filter((row) => attr(row.opening, "data-placeholder") === null && attr(row.opening, "data-message-id") === null).length,
  };
}

export function readSource(html: string, expected?: { accountId: string; chatId: string }): SourceRead {
  const selected = selectedMain(html);
  const main = selected?.opening ?? null;
  if (!main) return { ok: false, reason: "missing-account", index: null };
  const accountId = attr(main, "data-account-id");
  const chatId = attr(main, "data-chat-id");
  const orderText = attr(main, "data-order");
  if (!accountId) return { ok: false, reason: "missing-account", index: null };
  if (!chatId) return { ok: false, reason: "missing-chat", index: null };
  if (orderText !== "verified" && orderText !== "unknown") return { ok: false, reason: "unknown-order", index: null };
  if (expected && (expected.accountId !== accountId || expected.chatId !== chatId)) {
    return { ok: false, reason: "chat-mismatch", index: null };
  }
  const messages: SourceMessage[] = [];
  const seen = new Set<string>();
  const rows = articles(selected?.inner ?? "");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || attr(row.opening, "data-placeholder") !== null) continue;
    const id = attr(row.opening, "data-message-id");
    const senderName = attr(row.opening, "data-sender-name");
    const precision = attr(row.opening, "data-time-precision");
    const timeDisplay = attr(row.opening, "data-time-display");
    const sequence = attr(row.opening, "data-sequence");
    if (!id || !senderName || !precision || !isPrecision(precision) || !timeDisplay || (sequence !== "verified" && sequence !== "unknown")) {
      return { ok: false, reason: "unresolved-row", index };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    messages.push({
      id,
      senderKey: attr(row.opening, "data-sender-key"),
      senderName: decode(senderName),
      timeDisplay: decode(timeDisplay),
      precision,
      text: decode(row.inner.replace(/<[^>]+>/g, "").trim()),
      sequence,
    });
  }
  return { ok: true, snapshot: { accountId, chatId, order: orderText, messages } };
}
