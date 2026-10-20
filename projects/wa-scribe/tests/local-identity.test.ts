import { describe, expect, it } from "vitest";
import { resolveMessageKeyList } from "../src/local-identity";

const id20 = "0123456789abcdefabcd";
const id32 = "0123456789abcdef0123456789abcdef";
const chat = "12025550123@c.us";
const group = "12025550123-456789@g.us";

function success(rawIds: string[], keys: readonly IDBValidKey[]) {
  const result = resolveMessageKeyList(rawIds, keys);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.keys;
}

function failure(rawIds: string[], keys: readonly IDBValidKey[]) {
  expect(resolveMessageKeyList(rawIds, keys).ok).toBe(false);
}

describe("resolveMessageKeyList", () => {
  it("resolves 20 and 32 character opaque IDs to stable keys and preserves key casing", () => {
    const upperId = id20.toUpperCase();
    const key20 = `false_${chat}_${upperId}`;
    const key32 = `true_${chat}_${id32}`;
    const keys = success([upperId, id32], [key20, key32]);

    expect(keys.get(upperId)).toEqual({ id: key20, chatId: chat, outgoing: false, senderId: null });
    expect(keys.get(id32)).toEqual({ id: key32, chatId: chat, outgoing: true, senderId: null });
  });

  it("does not normalize the opaque ID when matching key casing", () => {
    failure([id20], [`false_${chat}_${id20.toUpperCase()}`]);
  });

  it("keeps a supported participant suffix on the resolved key", () => {
    const participant = "15551234567:4@lid";
    const key = `false_${chat}_${id20}_${participant}`;

    expect(success([id20], [key]).get(id20)).toEqual({
      id: key,
      chatId: chat,
      outgoing: false,
      senderId: participant,
    });
  });

  it("rejects an ID with no key and IDs whose matches span chats", () => {
    failure([id20], [`false_${chat}_${id32}`]);
    failure([id20, id32], [`false_${chat}_${id20}`, `true_${group}_${id32}`]);
  });

  it("rejects collisions across direction, unsupported remote JID, or participant", () => {
    failure([id20], [`false_${chat}_${id20}`, `true_${chat}_${id20}`]);
    failure([id20], [`false_${chat}_${id20}`, `true_99999999999@broadcast_${id20}`]);
    failure([id20], [
      `false_${chat}_${id20}_15551234567:1@lid`,
      `false_${chat}_${id20}_15551234567:2@lid`,
    ]);
  });

  it("ignores unrelated unknown string keys but rejects malformed keys containing a requested ID", () => {
    const key = `false_${chat}_${id20}`;
    expect(success([id20], ["unrecognized local key", key]).get(id20)?.id).toBe(key);
    failure([id20], [key, `unrecognized_${id20}`]);
  });

  it("rejects non-string keys", () => {
    failure([id20], [7]);
  });

  it("rejects repeated inputs and requests or snapshots beyond their bounds", () => {
    failure([id20, id20], [`false_${chat}_${id20}`]);
    failure(Array.from({ length: 501 }, (_, index) => index.toString(16).padStart(20, "0")), []);
    failure([id20], Array.from({ length: 100_001 }, (_, index) => `false_${chat}_${index}`));
  });

  it("rejects keys beyond the per-key and total byte limits", () => {
    failure([id20], ["x".repeat(4_097)]);
    failure([id20], Array.from({ length: 1_025 }, () => "x".repeat(4_096)));
  });
});
