# Opaque message identity compatibility

The owner's Chrome showed visible text messages but no canonical conversation ID in the checked DOM attributes. The observed `data-id` values were opaque 20/32-character hex strings. Their message nodes contained `.selectable-text` and `[data-pre-plain-text]`, while `.message-in`/`.message-out` matched nothing. Neither base64 nor hex decoding produced a serialized message key. Chat names and selected sidebar element IDs were not used as identity.

## Owner-run evidence

Sanitized, read-only Console checks established:

- Existing IndexedDB database `model-storage`, version 2070; store `message`, primary key path `id`.
- Sample primary message keys were serialized direction/conversation/message keys.
- Direct primary-key, `internalId` and `rowId` index lookups did not match the four sampled opaque IDs.
- A complete snapshot contained 14,640 message keys. Each of the four sampled opaque IDs matched exactly one serialized key payload; all four keys identified one conversation.
- Eleven unrelated keys used another grammar. No raw keys, identifiers or message records were supplied to the agent.

This establishes a candidate mapping for the observed serialization. It does not verify the updated unpacked extension, a real collection pass, Google consent or Drive export.

## Implemented boundary

`local-identity.ts` opens only the existing exact database version and aborts any upgrade. It reads primary keys only, using `count` and `getAllKeys` in one readonly transaction. It requires a complete snapshot and checks every opaque ID in each rendered batch without a per-chat cache. The canonical full key remains the exported message ID, preserving compatibility with canonical DOM IDs.

One raw ID must map to exactly one full key globally. Direction, participant and unsupported-remote collisions are rejected before selecting a conversation. Matching preserves case and literal payload equality. Unknown string keys are ignored only when they contain none of the requested IDs anywhere; otherwise identity is unresolved. Nonstring keys and alternate encodings are unsupported.

Bounds: 500 rendered IDs, 100,000 stored keys, 4 MiB UTF-8 key bytes, 4,096 characters per key, five seconds. Count bounds apply to the IndexedDB request; byte validation happens after its result is allocated. Limits produce a failure rather than a partial uniqueness claim. No message records, session stores or private modules/endpoints are inspected.

The DOM adapter rechecks account, pane, row IDs and sidebar selection around asynchronous lookup. Selection only detects change. Each collection batch resolves identities again; message bodies remain DOM observations. Envelopes no longer require the obsolete bubble/copyable CSS classes, and quoted envelopes cannot supply the outer message's sender/time. Scroll restoration requires the last verified row binding to remain unchanged.

## Verification boundary

The unit suite covers exact mapping, ambiguity, unknown keys, bounds, asynchronous context changes and DOM collection. The offline browser regression uses a synthetic WhatsApp-origin page, native IndexedDB and the unpacked extension; it is provided for the owner and has not been run by the agent. It blocks real network calls. Exact typecheck/unit/build results and source SHA are recorded in `install/BUILD.txt`.
