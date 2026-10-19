import { describe, expect, it } from "vitest";
import { DRIVE_FILE_SCOPE } from "../src/public-config";
import { FIXTURE_MATCH, createManifest } from "../src/manifest";

const clientId = "1234567890-abc.apps.googleusercontent.com";
const extensionKey = "B".repeat(120);

describe("createManifest", () => {
  it("keeps fixture access out of the production manifest", () => {
    const manifest = createManifest("production");
    const text = JSON.stringify(manifest);
    expect(manifest.permissions).toEqual(["sidePanel"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("web.whatsapp.com");
    expect(text).not.toContain("googleapis");
    expect(text).not.toContain("oauth");
    expect("oauth2" in manifest).toBe(false);
  });

  it("adds only the fixture origin to the test manifest", () => {
    const manifest = createManifest("test");
    expect(manifest.permissions).toEqual(["sidePanel"]);
    expect(manifest.host_permissions).toEqual([FIXTURE_MATCH]);
    expect(manifest.content_scripts).toEqual([
      { matches: [FIXTURE_MATCH], js: ["content.js"], run_at: "document_idle" },
    ]);
  });

  it("adds only drive.file when public OAuth configuration is present", () => {
    const manifest = createManifest("production", { clientId, extensionKey });
    expect(manifest.permissions).toEqual(["sidePanel", "identity", "storage"]);
    expect(manifest.host_permissions).toEqual(["https://www.googleapis.com/*"]);
    expect(manifest.oauth2).toEqual({ client_id: clientId, scopes: [DRIVE_FILE_SCOPE] });
    expect(manifest.key).toBe(extensionKey);
    const text = JSON.stringify(manifest);
    expect(text).not.toContain("client_secret");
    expect(text).not.toContain("web.whatsapp.com");
    expect(text).not.toContain("ya29.");
  });
});
