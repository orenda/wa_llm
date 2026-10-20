import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  alignByOrder,
  decodeMetadata,
  encodeExport,
  encodeMetadata,
  parseTranscript,
  renderTranscript,
  type CodecResult,
} from "../src/format";
import type { AttachmentSlot, Binding, ExportDraft, MessageDraft, TimePrecision, Timestamp } from "../src/model";

const binding: Binding = { accountId: "acct-1", chatId: "chat-1", destinationId: "dest-1", generation: "g1" };

const minute: Timestamp = { display: "09:41", precision: "minute", timeZone: null, instant: null };

const richText = [
  "See you at the gate.",
  "## Notes",
  "## Transcript",
  "### message",
  "```js",
  'console.log("hi")',
  "```",
  "",
  "sender-name: Dana",
  "\\keep",
  "שלום",
].join("\n");

const saved = { state: "saved", name: "photo.jpg", mediaType: "image/jpeg", relativePath: "media/c7a18d2f/01.jpg" } as const;
const unavailable = { state: "unavailable", limitation: "bytes were not delivered" } as const;

function message(overrides: Partial<MessageDraft> = {}): MessageDraft {
  return {
    id: "msg-100",
    sender: { key: "dana-1", name: "Dana" },
    timestamp: minute,
    sequence: "verified",
    text: "See you at the gate.",
    limitation: null,
    attachments: [],
    sourceBaseline: "gate",
    savedWordingBaseline: "gate",
    ...overrides,
  };
}

function rich(id: string): MessageDraft {
  return message({ id, text: richText, sourceBaseline: "rich-v1", savedWordingBaseline: "rich-v1" });
}

function album(): MessageDraft {
  const attachments: AttachmentSlot[] = [
    { slot: 1, attachment: saved },
    { slot: 3, attachment: unavailable },
  ];
  return message({
    id: "msg-300",
    sender: { key: null, name: "Omar" },
    timestamp: { display: "Today", precision: "display-only", timeZone: null, instant: null },
    sequence: "unknown",
    text: "Caption line",
    limitation: "album incomplete",
    attachments,
    sourceBaseline: "caption-v2",
    savedWordingBaseline: "caption-v1",
  });
}

function draft(messages: MessageDraft[], extra: Partial<ExportDraft> = {}): ExportDraft {
  return {
    ...binding,
    chatKey: "c7a18d2f",
    displayName: "Class 3A",
    sourceOrder: "unknown",
    messages,
    tombstones: [{ messageId: "msg-old", reason: "local-deletion" }],
    coverage: {
      segments: [
        { messageIds: ["msg-100", "msg-200"], anchorBefore: null, anchorAfter: null },
        { messageIds: ["msg-300"], anchorBefore: "msg-200", anchorAfter: null },
      ],
      gaps: [{ afterId: "msg-200", beforeId: "msg-300", reason: "unverified-overlap" }],
      requestedScope: "all-available",
      stopReason: "unverified-overlap",
    },
    ...extra,
  };
}

function unwrap<T>(result: CodecResult<T>): T {
  if (!result.ok) throw new Error(`${result.outcome}:${result.reason}`);
  return result.value;
}

const prefix = "## Notes\n\nשלום — notes stay exact.\n\n";
const goldenMessages = [rich("msg-100"), rich("msg-200"), album()];
const fixturePath = new URL("./fixtures/format/transcript.md", import.meta.url);

describe("reversible transcript", () => {
  const fixture = readFileSync(fixturePath, "utf8");

  it("renders the hand-written golden file and keeps both identical messages", () => {
    const first = unwrap(renderTranscript(prefix, goldenMessages));
    const second = unwrap(renderTranscript(prefix, goldenMessages));
    expect(first).toBe(fixture);
    expect(second).toBe(first);
    expect(first.startsWith(prefix)).toBe(true);
    expect(first.includes("<!--")).toBe(false);
    expect(first.includes("msg-")).toBe(false);

    const parsed = unwrap(parseTranscript(first));
    expect(parsed.prefix).toBe(prefix);
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[0]?.text).toBe(richText);
    expect(parsed.blocks[1]?.text).toBe(richText);
    expect(parsed.blocks[0]?.blockFingerprint).toBe(parsed.blocks[1]?.blockFingerprint);
    expect(parsed.blocks[0]?.timestamp).toEqual(minute);
    expect(parsed.blocks[2]?.attachments.map((entry) => entry.slot)).toEqual([1, 3]);
    expect("id" in (parsed.blocks[0] ?? {})).toBe(false);
  });

  it("preserves a CRLF Notes prefix and creates none when the prefix is empty", () => {
    const notes = "## Notes\r\n\r\nשלום — notes stay exact.\r\n\r\n";
    const rendered = unwrap(renderTranscript(notes, [message()]));
    const generated = [
      "## Transcript",
      "### message",
      "sender-name: Dana",
      "sender-key: dana-1",
      "time-display: 09:41",
      "time-precision: minute",
      "sequence: verified",
      "",
      "See you at the gate.",
      "",
    ].join("\n");
    expect(rendered).toBe(`${notes}${generated}`);
    // Same FNV-1a value recorded for this block in docs/FORMAT.md.
    expect(unwrap(parseTranscript(unwrap(renderTranscript("", [message()])))).blocks[0]?.blockFingerprint).toBe("57bbaa27");
    expect(unwrap(parseTranscript(rendered)).prefix).toBe(notes);
    expect(rendered.slice(notes.length).includes("\r")).toBe(false);

    const bare = unwrap(renderTranscript("", [message()]));
    expect(bare.startsWith("## Transcript\n")).toBe(true);
    expect(bare.includes("## Notes")).toBe(false);
  });

  it("keeps unknown precision and does not invent an instant", () => {
    const unknown = message({
      timestamp: { display: "", precision: "unknown", timeZone: null, instant: null },
      text: "later",
    });
    const zoned = message({
      timestamp: { display: "09:41", precision: "minute", timeZone: "Asia/Jerusalem", instant: null },
    });
    const rendered = unwrap(renderTranscript("", [unknown, zoned]));
    expect(rendered.includes("time-precision: unknown")).toBe(true);
    expect(rendered.includes("time-zone: Asia/Jerusalem")).toBe(true);
    expect(rendered.includes("instant:")).toBe(false);
    expect(rendered.includes(":00")).toBe(false);
    const parsed = unwrap(parseTranscript(rendered));
    expect(parsed.blocks[0]?.timestamp.instant).toBeNull();
    expect(parsed.blocks[1]?.timestamp.instant).toBeNull();
    expect(parsed.blocks[1]?.timestamp.timeZone).toBe("Asia/Jerusalem");
  });
});

describe("metadata", () => {
  const exported = unwrap(encodeExport(prefix, draft(goldenMessages)));

  it("round-trips baselines, tombstones, gaps, and distinct ids", () => {
    const decoded = unwrap(decodeMetadata(exported.metadata, binding));
    expect(decoded.messages.map((entry) => entry.id)).toEqual(["msg-100", "msg-200", "msg-300"]);
    expect(decoded.messages[0]?.sourceBaseline).toBe("rich-v1");
    expect(decoded.messages[2]?.sourceBaseline).toBe("caption-v2");
    expect(decoded.messages[2]?.savedWordingBaseline).toBe("caption-v1");
    expect(decoded.tombstones).toEqual([{ messageId: "msg-old", reason: "local-deletion" }]);
    expect(decoded.coverage.segments).toHaveLength(2);
    expect(decoded.coverage.gaps).toEqual([{ afterId: "msg-200", beforeId: "msg-300", reason: "unverified-overlap" }]);
    expect(exported.markdown.includes("msg-old")).toBe(false);
    expect(unwrap(encodeMetadata(decoded))).toBe(exported.metadata);

    const aligned = unwrap(alignByOrder(unwrap(parseTranscript(exported.markdown)).blocks, decoded.messages, exported.markdown));
    expect(aligned.map((pair) => pair.message.id)).toEqual(["msg-100", "msg-200", "msg-300"]);
    const sidecar = readFileSync(new URL("./fixtures/format/sidecar.json", import.meta.url), "utf8");
    expect(exported.metadata).toBe(sidecar);
  });

  it("rejects invalid metadata instead of rebuilding it", () => {
    expect(decodeMetadata("{", binding)).toMatchObject({ ok: false, outcome: "recovery-required", reason: "invalid-json", input: "{" });
    expect(decodeMetadata('{"formatVersion":2}', binding)).toMatchObject({ ok: false, reason: "unsupported-version" });
    expect(decodeMetadata("{}", binding)).toMatchObject({ ok: false, reason: "missing-state" });
    expect(decodeMetadata('{"formatVersion":1}', binding)).toMatchObject({ ok: false, reason: "missing-state" });

    const wrongAccount = exported.metadata.replace('"acct-1"', '"acct-2"');
    const wrongGeneration = exported.metadata.replace('"g1"', '"g2"');
    expect(decodeMetadata(wrongAccount, binding)).toMatchObject({ ok: false, reason: "binding-mismatch", input: wrongAccount });
    expect(decodeMetadata(wrongGeneration, binding)).toMatchObject({ ok: false, reason: "binding-mismatch" });

    const shifted = JSON.parse(exported.metadata) as { messages: { blockFingerprint: string }[] };
    shifted.messages[0]!.blockFingerprint = "00000000";
    const tampered = `${JSON.stringify(shifted)}\n`;
    expect(decodeMetadata(tampered, binding)).toMatchObject({ ok: false, reason: "fingerprint-mismatch", input: tampered });
  });

  it("rejects empty ids, invented instants, unsafe paths, verified gaps, and tombstone overlap", () => {
    expect(encodeExport("", draft([message({ id: "" })]))).toMatchObject({ ok: false, reason: "missing-state" });
    expect(
      renderTranscript("", [message({ timestamp: { display: "09:41", precision: "minute", timeZone: null, instant: "2026-10-19T06:41:00Z" } })]),
    ).toMatchObject({ ok: false, reason: "malformed-markdown" });
    const unsafe = ["../secret.bin", "/tmp/a.bin", "https://example.test/a.bin", "media\\a.bin"];
    for (const relativePath of unsafe) {
      const attachments: AttachmentSlot[] = [{ slot: 1, attachment: { state: "opaque", name: "blob.bin", mediaType: null, relativePath } }];
      expect(renderTranscript("", [message({ attachments })])).toMatchObject({ ok: false, reason: "malformed-markdown" });
    }
    expect(encodeExport("", draft(goldenMessages, { sourceOrder: "verified" }))).toMatchObject({ ok: false, reason: "missing-state" });
    const overlapping = draft(goldenMessages, { tombstones: [{ messageId: "msg-100", reason: "local-deletion" }] });
    expect(encodeExport(prefix, overlapping)).toMatchObject({ ok: false, reason: "missing-state" });
  });
});

describe("parse failures", () => {
  it("returns the original markdown for ambiguous, malformed, and misaligned input", () => {
    const ambiguous = "## Notes\n\n## Transcript\n## Transcript\n";
    expect(parseTranscript(ambiguous)).toEqual({ ok: false, outcome: "parse-error", reason: "ambiguous-markdown", input: ambiguous });
    const escaped = "## Transcript\n### message\nsender-name: Dana\ntime-display: 09:41\ntime-precision: minute\nsequence: verified\n\n\\nope\n";
    expect(parseTranscript(escaped)).toMatchObject({ ok: false, reason: "malformed-markdown", input: escaped });
    expect(renderTranscript("## Notes", [message()])).toMatchObject({ ok: false, reason: "invalid-prefix", input: "## Notes" });

    const exported = unwrap(encodeExport("", draft(goldenMessages)));
    const parsed = unwrap(parseTranscript(exported.markdown));
    const swapped = [exported.chat.messages[2]!, exported.chat.messages[0]!, exported.chat.messages[1]!];
    expect(alignByOrder(parsed.blocks, swapped, exported.markdown)).toMatchObject({ ok: false, reason: "content-mismatch", input: exported.markdown });
    expect(alignByOrder(parsed.blocks.slice(0, 2), exported.chat.messages, exported.markdown)).toMatchObject({
      ok: false,
      reason: "alignment-mismatch",
    });

    const changed = exported.markdown.replace("Caption line", "Caption line!");
    const reparsed = unwrap(parseTranscript(changed));
    expect(alignByOrder(reparsed.blocks, exported.chat.messages, changed)).toMatchObject({ ok: false, reason: "content-mismatch", input: changed });
  });

  it("rejects a CRLF transcript boundary and a carriage return in message text", () => {
    const crlf = "## Notes\r\n## Transcript\r\n";
    expect(parseTranscript(crlf)).toEqual({ ok: false, outcome: "parse-error", reason: "ambiguous-markdown", input: crlf });
    expect(renderTranscript("", [message({ text: "line\r\nnext" })])).toMatchObject({ ok: false, reason: "malformed-markdown" });
  });

  it("round-trips header escapes without turning them into extra headers", () => {
    const entry = message({ sender: { key: "k\\1", name: "Dana\nEve" }, text: "### message\n## Transcript\n\\keep" });
    const rendered = unwrap(renderTranscript("", [entry]));
    expect(rendered).toContain("sender-name: Dana\\nEve\n");
    expect(rendered).toContain("sender-key: k\\\\1\n");
    expect(rendered).toContain("\n\\### message\n\\## Transcript\n\\\\keep\n");
    const parsed = unwrap(parseTranscript(rendered));
    expect(parsed.blocks[0]?.sender).toEqual({ key: "k\\1", name: "Dana\nEve" });
    expect(parsed.blocks[0]?.text).toBe("### message\n## Transcript\n\\keep");
  });

  it("keeps an opaque attachment and a known instant only when supplied", () => {
    const opaque = message({
      id: "msg-900",
      attachments: [{ slot: 1, attachment: { state: "opaque", name: "blob.bin", mediaType: null, relativePath: "media/c7a18d2f/blob.bin" } }],
      text: "file",
    });
    const instant = message({
      timestamp: { display: "09:41:08", precision: "instant", timeZone: "Asia/Jerusalem", instant: "2026-10-19T06:41:08.000Z" },
    });
    const single = (entry: MessageDraft): ExportDraft => ({
      ...binding,
      chatKey: "c7a18d2f",
      displayName: "Class 3A",
      sourceOrder: "verified",
      messages: [entry],
      tombstones: [],
      coverage: {
        segments: [{ messageIds: [entry.id], anchorBefore: null, anchorAfter: null }],
        gaps: [],
        requestedScope: "all-available",
        stopReason: null,
      },
    });
    const savedOpaque = unwrap(encodeExport("", single(opaque)));
    expect(unwrap(parseTranscript(savedOpaque.markdown)).blocks[0]?.attachments[0]?.attachment).toEqual({
      state: "opaque",
      name: "blob.bin",
      mediaType: null,
      relativePath: "media/c7a18d2f/blob.bin",
    });
    const savedInstant = unwrap(encodeExport("", single(instant)));
    expect(unwrap(parseTranscript(savedInstant.markdown)).blocks[0]?.timestamp.instant).toBe("2026-10-19T06:41:08.000Z");
  });
});

describe("known timestamps and attachment order", () => {
  const known = "2026-10-19T06:41:08.000Z";

  function at(instant: string | null, precision: TimePrecision = "instant"): MessageDraft {
    return message({
      timestamp: {
        display: precision === "unknown" ? "" : "09:41:08",
        precision,
        timeZone: precision === "instant" ? "UTC" : null,
        instant,
      },
    });
  }

  function verified(entry: MessageDraft): ExportDraft {
    return {
      ...binding,
      chatKey: "c7a18d2f",
      displayName: "Class 3A",
      sourceOrder: "verified",
      messages: [entry],
      tombstones: [],
      coverage: {
        segments: [{ messageIds: [entry.id], anchorBefore: null, anchorAfter: null }],
        gaps: [],
        requestedScope: "all-available",
        stopReason: null,
      },
    };
  }

  it("keeps a canonical instant and an explicit unknown timestamp", () => {
    const rendered = unwrap(renderTranscript("", [at(known), at(null, "unknown")]));
    const parsed = unwrap(parseTranscript(rendered));
    expect(parsed.blocks[0]?.timestamp.instant).toBe(known);
    expect(parsed.blocks[0]?.timestamp.precision).toBe("instant");
    expect(parsed.blocks[1]?.timestamp).toEqual({ display: "", precision: "unknown", timeZone: null, instant: null });
    const exported = unwrap(encodeExport("", verified(at(known))));
    expect(unwrap(decodeMetadata(exported.metadata, binding)).messages[0]?.timestamp.instant).toBe(known);
  });

  it("rejects invalid known instants at render, parse, and metadata boundaries", () => {
    const rejected = [
      "not-a-timestamp",
      "Invalid Date",
      "NaN",
      "2026-10-19T25:00:00.000Z",
      "2026-02-31T00:00:00.000Z",
      "2026-10-19T06:41:08Z",
      "2026-10-19T06:41:08+00:00",
    ];
    const good = unwrap(renderTranscript("", [at(known)]));
    const goodMeta = unwrap(encodeExport("", verified(at(known)))).metadata;
    for (const instant of rejected) {
      expect(renderTranscript("", [at(instant)])).toMatchObject({ ok: false, reason: "malformed-markdown" });
      const markdown = good.replace(known, instant);
      expect(parseTranscript(markdown)).toEqual({ ok: false, outcome: "parse-error", reason: "malformed-markdown", input: markdown });
      const metadata = goodMeta.replaceAll(known, instant);
      expect(decodeMetadata(metadata, binding)).toMatchObject({ ok: false, outcome: "recovery-required", reason: "missing-state", input: metadata });
    }
  });

  it("serializes the same attachment when its property order changes", () => {
    const ordered = message({
      id: "msg-900",
      text: "file",
      attachments: [{ slot: 1, attachment: { state: "saved", name: "photo.jpg", mediaType: "image/jpeg", relativePath: "media/c7a18d2f/01.jpg" } }],
    });
    const shuffled = message({
      id: "msg-900",
      text: "file",
      attachments: [
        {
          attachment: { relativePath: "media/c7a18d2f/01.jpg", mediaType: "image/jpeg", name: "photo.jpg", state: "saved" },
          slot: 1,
        },
      ],
    });
    const left = unwrap(encodeExport("", verified(ordered)));
    const right = unwrap(encodeExport("", verified(shuffled)));
    expect(right.markdown).toBe(left.markdown);
    expect(right.metadata).toBe(left.metadata);
    expect(right.markdown).toContain('attachment: 1 {"state":"saved","name":"photo.jpg","mediaType":"image/jpeg","relativePath":"media/c7a18d2f/01.jpg"}');
    const parsed = unwrap(parseTranscript(right.markdown));
    expect(parsed.blocks[0]?.attachments).toEqual([
      { slot: 1, attachment: { state: "saved", name: "photo.jpg", mediaType: "image/jpeg", relativePath: "media/c7a18d2f/01.jpg" } },
    ]);
    expect(unwrap(decodeMetadata(right.metadata, binding)).messages[0]?.attachments).toEqual(parsed.blocks[0]?.attachments);
    const again = unwrap(encodeExport("", verified(message({ ...shuffled, attachments: parsed.blocks[0]?.attachments ?? [] }))));
    expect(again.metadata).toBe(right.metadata);
  });

  it("renders validated relative links while retaining legacy v1 attachment metadata and fingerprints", () => {
    const source = message({
      attachments: [{ slot: 2, attachment: { state: "saved", name: "my photo (1).jpg", mediaType: "image/jpeg", relativePath: "media/c7a18d2f/my photo (1).jpg" } }],
    });
    const encoded = unwrap(encodeExport("", verified(source)));
    expect(encoded.markdown).toContain("attachment-link-2: [Open attachment](./media/c7a18d2f/my%20photo%20%281%29.jpg)");
    expect(encoded.metadata).not.toContain('"link"');

    const legacyMarkdown = encoded.markdown.replace("attachment-link-2: [Open attachment](./media/c7a18d2f/my%20photo%20%281%29.jpg)\n", "");
    expect(unwrap(parseTranscript(legacyMarkdown)).blocks[0]?.blockFingerprint).toBe(encoded.chat.messages[0]?.blockFingerprint);
    expect(unwrap(decodeMetadata(encoded.metadata, binding)).messages[0]?.blockFingerprint).toBe(encoded.chat.messages[0]?.blockFingerprint);
  });

  it("rejects changed derived links and fingerprints body text that resembles a link header", () => {
    const source = message({
      text: "attachment-link-1: [Open attachment](./guessed.jpg)",
      attachments: [{ slot: 1, attachment: saved }],
    });
    const encoded = unwrap(encodeExport("", verified(source)));
    const changedLink = encoded.markdown.replace("./media/c7a18d2f/01.jpg", "./media/other.jpg");
    expect(parseTranscript(changedLink)).toMatchObject({ ok: false, reason: "malformed-markdown" });
    const parsed = unwrap(parseTranscript(encoded.markdown));
    expect(parsed.blocks[0]?.text).toBe(source.text);
    expect(parsed.blocks[0]?.blockFingerprint).toBe(encoded.chat.messages[0]?.blockFingerprint);
  });
});
