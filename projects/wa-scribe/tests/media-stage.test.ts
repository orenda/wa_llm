import { describe, expect, it } from "vitest";
import { decodeMediaBase64, mediaDescriptor, sha256Bytes } from "../src/media-stage";

const key = "ab".repeat(32);

describe("attachment staging boundaries", () => {
  it("decodes exact binary bytes and rejects alternate padding, whitespace and oversize input", () => {
    expect([...decodeMediaBase64("AP8BgA==")]).toEqual([0, 255, 1, 128]);
    expect([...decodeMediaBase64("")]).toEqual([]);
    for (const invalid of ["AB==", "AAA", "AA==\n", "AA-_", "A===", "A".repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4 + 4)]) {
      expect(() => decodeMediaBase64(invalid)).toThrow();
    }
  });

  it("keeps a safe leaf path independent of an untrusted original filename", () => {
    expect(mediaDescriptor(key, "../../report:2026.PDF", "Application/PDF; charset=UTF-8", 17)).toEqual({
      key, relativePath: `${key}.pdf`, name: ".._.._report_2026.PDF", mediaType: "application/pdf", size: 17,
    });
    expect(mediaDescriptor(key, "\u0000photo.jpeg", "image/jpeg", 32).relativePath).toBe(`${key}.jpg`);
    expect(mediaDescriptor(key, "unknown", null, 0).relativePath).toBe(`${key}.bin`);
  });

  it("rejects invalid content identity, MIME, size and bytes", () => {
    expect(() => mediaDescriptor("not-a-digest", "file", null, 0)).toThrow();
    expect(() => mediaDescriptor(key, "file", "https://signed.example/file", 1)).toThrow();
    expect(() => mediaDescriptor(key, "file", "image/" + "x".repeat(128), 1)).toThrow();
    expect(() => mediaDescriptor(key, "file", null, 8 * 1024 * 1024 + 1)).toThrow();
    expect(() => mediaDescriptor(key, "file", null, -1)).toThrow();
  });

  it("hashes the raw bytes without UTF-8 decoding", async () => {
    expect(await sha256Bytes(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Bytes(new Uint8Array([0xff]))).not.toBe(await sha256Bytes(new TextEncoder().encode("�")));
  });
});
