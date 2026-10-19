import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

function pack(args: string[]) {
  return spawnSync(process.execPath, ["scripts/package-release.mjs", ...args], { cwd: root, encoding: "utf8" });
}

describe("release zip", () => {
  it("packs dist and refuses a private key without publishing", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-scribe-pack-"));
    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "manifest.json"), '{ "name": "wa-scribe", "version": "0.0.1" }\n');
    writeFileSync(join(dist, "panel.html"), "<p>panel</p>\n");
    const zip = join(dir, "wa-scribe.zip");
    const packed = pack([dist, zip]);
    expect(packed.status).toBe(0);
    expect(packed.stdout).toContain("not published");
    const bytes = readFileSync(zip);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect(bytes.includes(Buffer.from("manifest.json"))).toBe(true);
    expect(bytes.includes(Buffer.from("panel.html"))).toBe(true);
    expect(bytes.includes(Buffer.from("client_secret"))).toBe(false);

    writeFileSync(join(dist, "extension.pem"), "private");
    const refused = pack([dist, join(dir, "refused.zip")]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("refused");
    const missing = pack([join(dir, "absent"), join(dir, "missing.zip")]);
    expect(missing.status).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
