import { describe, expect, it } from "vitest";
import { projectOriginalMetadata } from "../src/original-metadata";

const messageId = "false_15551234567@c.us_ABC123";
const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const base64 = btoa(String.fromCharCode(...bytes));

describe("selected message original metadata", () => {
  it("normalizes only exact supported plaintext hash encodings", () => {
    for (const filehash of [digest, digest.toUpperCase(), base64, bytes]) {
      expect(projectOriginalMetadata(messageId, { id: messageId, filehash })).toEqual({ digest, size: null, mediaType: null, name: null });
    }
    for (const filehash of [undefined, null, "", "ab", digest + "00", ` ${digest}`, base64.slice(0, -1), base64 + "\n", Array.from(bytes), bytes.buffer, new Uint8Array(31), new Uint8Array(33)]) {
      expect(projectOriginalMetadata(messageId, { id: messageId, filehash })).toBeNull();
    }
    // Alternate trailing padding bits must not be accepted as the same digest.
    expect(projectOriginalMetadata(messageId, { id: messageId, filehash: "A".repeat(42) + "B=" })).toBeNull();
  });

  it("requires the full canonical message identity", () => {
    expect(projectOriginalMetadata(messageId, { id: messageId + "OTHER", filehash: digest })).toBeNull();
    for (const key of ["ABC123", "false_status@broadcast_ABC123", "false_15551234567@c.us_ABC123\n", "true_15551234567@c.us_ABC123_extra"]) {
      expect(projectOriginalMetadata(key, { id: key, filehash: digest })).toBeNull();
    }
    const group = "true_12345-67890@g.us_ABC123_15551234567@lid";
    expect(projectOriginalMetadata(group, { id: group, filehash: digest })?.digest).toBe(digest);
  });

  it("validates optional metadata without guessing malformed values", () => {
    expect(projectOriginalMetadata(messageId, { id: messageId, filehash: digest, size: 0, mimetype: "Application/PDF; charset=UTF-8", filename: "report.pdf" })).toEqual({
      digest, size: 0, mediaType: "application/pdf", name: "report.pdf",
    });
    expect(projectOriginalMetadata(messageId, { id: messageId, filehash: digest, size: null, mimetype: undefined, filename: null })).toEqual({
      digest, size: null, mediaType: null, name: null,
    });
    for (const size of [NaN, Infinity, -1, 1.5, 8 * 1024 * 1024 + 1, "12"]) {
      expect(projectOriginalMetadata(messageId, { id: messageId, filehash: digest, size })).toBeNull();
    }
    expect(projectOriginalMetadata(messageId, { id: messageId, filehash: digest, size: 8 * 1024 * 1024 })?.size).toBe(8 * 1024 * 1024);
    for (const mimetype of ["", "application", "text/", "https://signed.example/file", 3]) {
      expect(projectOriginalMetadata(messageId, { id: messageId, filehash: digest, mimetype })).toBeNull();
    }
    for (const filename of ["", " ", "../file.pdf", "x\\file.pdf", "x:y.pdf", "file\n.pdf", "x".repeat(257), 3]) {
      expect(projectOriginalMetadata(messageId, { id: messageId, filehash: digest, filename })).toBeNull();
    }
  });

  it("never falls back to encrypted hashes or reads message contents and keys", () => {
    const opaque = {
      get body(): never { throw new Error("Message body must stay opaque"); },
      get caption(): never { throw new Error("Message caption must stay opaque"); },
      get mediaKey(): never { throw new Error("Media decryption keys must stay opaque"); },
      get encFilehash(): never { throw new Error("Encrypted digest must stay opaque"); },
    };
    const noHash = Object.create(null, { ...Object.getOwnPropertyDescriptors(opaque), id: { value: messageId } });
    expect(projectOriginalMetadata(messageId, noHash)).toBeNull();
    const record = Object.create(null, { ...Object.getOwnPropertyDescriptors(opaque), id: { value: messageId }, filehash: { value: digest } });
    expect(projectOriginalMetadata(messageId, record)).toEqual({ digest, size: null, mediaType: null, name: null });
    expect(projectOriginalMetadata(messageId, { id: messageId, encFilehash: digest })).toBeNull();
  });
});
