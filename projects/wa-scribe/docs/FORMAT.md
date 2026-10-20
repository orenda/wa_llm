# Format version 1

wa-scribe stores one Markdown transcript and one JSON sidecar per chat. The codec in `src/format.ts` renders and parses that pair. It does not scrape, download, reconcile, or recover missing metadata.

Message identity stays in the sidecar. The transcript never contains message IDs, HTML comments, or hidden per-message markers. Equal sender, time, and text are still separate messages when the sidecar gives them distinct IDs.

## Transcript bytes

A file is the caller-supplied prefix, then the line `## Transcript`, then zero or more generated blocks. The prefix is owned by the user. When it is non-empty it must already end in a newline. The codec copies those bytes unchanged: it does not trim, rewrite newlines, or convert between LF and CRLF.

An empty prefix means the file begins with `## Transcript`. The codec does not invent `## Notes`.

The generated section uses LF only. A CR in that section is a parse error. Every line whose text is exactly `## Transcript` is a boundary candidate: none is `malformed-markdown`, and more than one, or a candidate that is not ended by a single LF, is `ambiguous-markdown`. On render, a non-empty prefix must already end in a newline, and a prefix line whose text is exactly `## Transcript` is `invalid-prefix`. The original string is returned with the error.

```text
<prefix bytes, copied exactly>
## Transcript
<block>
<block>
```

## Message block

```text
### message
sender-name: <display name>
sender-key: <observed key>          # omitted when unknown
time-display: <source display>
time-precision: instant|minute|date|display-only|unknown
time-zone: <zone>                   # omitted when unknown
instant: <ISO instant>              # required only when precision is instant
sequence: verified|unknown
limitation: <message-level note>    # omitted when none
attachment: <slot> <json>           # zero or more, slot order kept
attachment-link-<slot>: [Open attachment](./<encoded-relative-path>)  # saved/opaque only; derived
<blank line>
<body>
```

Header order is fixed. Unknown headers, duplicate slots, an invalid attachment link, and a missing blank line before the body are parse errors. Slot numbers are integers `>= 1`. Missing numbers are not filled in: slots 1 and 3 may be saved while 2 is absent. The derived link line, when present, must immediately follow its matching attachment JSON header and exactly encode that entry's relative path. Older v1 transcripts may omit it. A link line cannot stand alone or refer to a different slot/path.

`time-precision` records what was actually observed. `instant` is present only for `instant`, and then only as a canonical UTC value `YYYY-MM-DDTHH:mm:ss.sssZ` that `Date` parses unchanged. Unparseable strings, `NaN`, `Invalid Date`, overflowed calendar values, and other spellings such as `Z` without milliseconds or a `+00:00` offset are rejected. The codec does not rewrite them as `unknown` or fill in a default. Minute, date, display-only, and unknown values do not gain seconds, a zone, or a UTC offset. `sequence: unknown` does not become source order.

Body lines are joined with `\n`. The codec escapes only a body line that is exactly `### message`, exactly `## Transcript`, or already starts with `\`, by prefixing one `\`. On parse, a leading `\` is removed only when the remainder is one of those two sentinels or itself starts with `\`. Any other leading `\`, such as `\nope`, is a parse error. Header values use a different escape: `\\`, `\n`, and `\r`. That keeps a sender name on one physical line. A CR in message text is rejected rather than converted.

Attachment JSON is one object and remains unchanged by the link line:

| `state` | Fields | Meaning |
| --- | --- | --- |
| `pending` | `limitation` | Not delivered yet |
| `unavailable` | `limitation` | No bytes and no supported path |
| `unsupported` | `detail` | Envelope recognized; this part is not saved |
| `opaque` | `name`, `mediaType` (or null), `relativePath` | Original bytes kept without a known type |
| `saved` | `name`, `mediaType`, `relativePath` | Delivered original stored at that path |

Paths are relative to the export root. The codec rejects absolute paths, backslashes, `.` or `..` segments, colons, queries, and `://`. Saved and opaque entries render a Markdown link with each path segment URL-encoded. The link is derived from the JSON entry; it adds no sidecar field. Legacy v1 attachment headers without a link remain valid. Markdown and sidecar output write each attachment with a fixed field order, so the input object's key order does not change the bytes.

## Sidecar

`formatVersion` is the number `1`. The document binds `accountId`, `chatId`, `destinationId`, and `generation`, plus `chatKey`, `displayName`, and `sourceOrder` (`verified` or `unknown`). `sourceOrder: verified` is rejected when any gap exists, any saved message has `sequence: unknown`, or the segment IDs are not the message IDs in transcript order.

Each message stores `sourceBaseline` and `savedWordingBaseline` separately, so a saved block can keep older wording. `blockFingerprint` is FNV-1a 32-bit over the UTF-8 bytes of that message's rendered block (`### message` through the block's trailing newline), written as 8 lowercase hex digits. A validated derived attachment-link header is excluded from the hash; all JSON and body text remains fingerprinted. This keeps fingerprints and sidecars compatible with v1 transcripts that predate links. Link-like prose in a message body is ordinary fingerprinted text. Identical blocks share a fingerprint. The fingerprint is not an ID.

`tombstones` are `{ "messageId", "reason": "local-deletion" }`. They are disjoint from saved messages and produce no transcript block. Coverage stores `segments` (`messageIds`, `anchorBefore`, `anchorAfter`), `gaps` (`afterId`, `beforeId`, `reason`), `requestedScope`, and `stopReason`. The codec keeps those arrays as given. It does not join segments or close a gap.

`sourceOrder: verified` establishes the ordering of saved messages, not a complete chat archive. Reconciliation retains the collector's `stopReason`, including `visible-window`, `message-budget`, `byte-budget`, and `time-budget`. Without supplied boundary evidence it records `visible-window` for rendered scope or `scope-boundary-unverified` otherwise. A non-null stop reason or any gap means partial coverage; `visible` and `loaded` scopes are also partial when legacy metadata has a null stop reason. A null legacy reason does not prove completeness for either bounded scope. The panel derives status from the same coverage record. Repeating an identical pass can be unchanged while its coverage remains partial.

Every saved message ID appears in exactly one segment. Extra segment IDs are rejected. That check does not turn unknown order into verified order.

## Failures

| Condition | `outcome` | `reason` |
| --- | --- | --- |
| Metadata is not JSON | `recovery-required` | `invalid-json` |
| `formatVersion` is present and is not `1` | `recovery-required` | `unsupported-version` |
| Version or required state is missing, or a field is invalid | `recovery-required` | `missing-state` |
| Valid document bound to a different account, chat, destination, or generation | `recovery-required` | `binding-mismatch` |
| Stored fingerprint does not match the rendered block | `recovery-required` | `fingerprint-mismatch` |
| More than one transcript boundary, or a boundary that is not a single LF | `parse-error` | `ambiguous-markdown` |
| Prefix is not empty and does not end in a newline, or it contains its own transcript heading | `parse-error` | `invalid-prefix` |
| Generated Markdown does not match the grammar | `parse-error` | `malformed-markdown` |
| Parsed blocks and sidecar messages differ in length | `parse-error` | `alignment-mismatch` |
| Same index, different visible content | `parse-error` | `content-mismatch` |
| Same visible content, different fingerprint | `parse-error` | `fingerprint-mismatch` |

Parse and metadata errors include the original input string. The codec does not build an empty chat, guess an ID from text, or assign a tombstone for a missing block. `alignByOrder` pairs by index only.

Rendering the same drafts twice is byte-identical. `encodeExport` renders the transcript, fills fingerprints from those blocks, and writes the sidecar.

## Example

```markdown
## Transcript
### message
sender-name: Dana
sender-key: dana-1
time-display: 09:41
time-precision: minute
sequence: verified

See you at the gate.
```

```json
{
  "formatVersion": 1,
  "accountId": "acct-1",
  "chatId": "chat-1",
  "chatKey": "c7a18d2f",
  "destinationId": "dest-1",
  "generation": "g1",
  "displayName": "Class 3A",
  "sourceOrder": "verified",
  "messages": [
    {
      "id": "msg-100",
      "sender": {
        "key": "dana-1",
        "name": "Dana"
      },
      "timestamp": {
        "display": "09:41",
        "precision": "minute",
        "timeZone": null,
        "instant": null
      },
      "sequence": "verified",
      "text": "See you at the gate.",
      "limitation": null,
      "attachments": [],
      "sourceBaseline": "gate",
      "savedWordingBaseline": "gate",
      "blockFingerprint": "57bbaa27"
    }
  ],
  "tombstones": [],
  "coverage": {
    "segments": [
      {
        "messageIds": [
          "msg-100"
        ],
        "anchorBefore": null,
        "anchorAfter": null
      }
    ],
    "gaps": [],
    "requestedScope": "all-available",
    "stopReason": "scope-boundary-unverified"
  }
}
```

`57bbaa27` is FNV-1a of the rendered block above. `tests/fixtures/format/transcript.md` is a larger hand-written transcript: a Notes prefix, two identical rich blocks, and a third block with slots 1 and 3. `tests/fixtures/format/sidecar.json` is the matching sidecar, including a tombstone that does not appear in the transcript.
