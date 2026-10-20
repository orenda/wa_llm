import { describe, expect, it } from "vitest";
import { DRIVE_FILE_SCOPE } from "../src/public-config";
import { FIXTURE_MATCH, createManifest } from "../src/manifest";

const clientId = "1234567890-abc.apps.googleusercontent.com";
const extensionKey = "B".repeat(120);

describe("createManifest", () => {
  it("grants production only WhatsApp and scoped Google API access", () => {
    const manifest = createManifest("production");
    const text = JSON.stringify(manifest);
    expect(manifest.permissions).toEqual(["sidePanel", "identity", "storage", "tabs"]);
    expect(manifest.host_permissions).toEqual(["https://web.whatsapp.com/*", "https://www.googleapis.com/*"]);
    expect(manifest.content_scripts).toEqual([
      { matches: ["https://web.whatsapp.com/*"], js: ["content.js"], run_at: "document_idle" },
    ]);
    expect(text).not.toContain("127.0.0.1");
    expect(text).toContain("web.whatsapp.com");
    expect(text).toContain("googleapis.com");
    expect(text).not.toContain("oauth");
    expect("oauth2" in manifest).toBe(false);
  });

  it("adds only the fixture origin beyond production access to the test manifest", () => {
    const manifest = createManifest("test");
    expect(manifest.permissions).toEqual(["sidePanel", "identity", "storage", "tabs"]);
    expect(manifest.host_permissions).toEqual(["https://web.whatsapp.com/*", "https://www.googleapis.com/*", FIXTURE_MATCH]);
    expect(manifest.content_scripts).toEqual([
      { matches: ["https://web.whatsapp.com/*", FIXTURE_MATCH], js: ["content.js"], run_at: "document_idle" },
    ]);
  });

  it("adds drive.file OAuth configuration while keeping scoped WhatsApp and Google access", () => {
    const manifest = createManifest("production", { clientId, extensionKey });
    expect(manifest.permissions).toEqual(["sidePanel", "identity", "storage", "tabs"]);
    expect(manifest.host_permissions).toEqual(["https://web.whatsapp.com/*", "https://www.googleapis.com/*"]);
    expect(manifest.content_scripts?.[0]?.matches).toEqual(["https://web.whatsapp.com/*"]);
    expect(manifest.oauth2).toEqual({ client_id: clientId, scopes: [DRIVE_FILE_SCOPE] });
    expect(manifest.key).toBe(extensionKey);
    const text = JSON.stringify(manifest);
    expect(text).not.toContain("client_secret");
    expect(text).toContain("web.whatsapp.com");
    expect(text).not.toContain("ya29.");
  });
});
