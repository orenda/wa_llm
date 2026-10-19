import { DRIVE_FILE_SCOPE, oauthReady, type PublicOAuth } from "./public-config";

export const FIXTURE_MATCH = "http://127.0.0.1:4179/*";
const GOOGLE_API = "https://www.googleapis.com/*";

export type ExtensionTarget = "production" | "test";

export type ExtensionManifest = {
  manifest_version: 3;
  name: string;
  version: string;
  description: string;
  minimum_chrome_version: string;
  action: { default_title: string };
  side_panel: { default_path: string };
  background: { service_worker: string };
  permissions: string[];
  host_permissions?: string[];
  oauth2?: { client_id: string; scopes: [typeof DRIVE_FILE_SCOPE] };
  key?: string;
  content_scripts?: [
    {
      matches: [typeof FIXTURE_MATCH];
      js: ["content.js"];
      run_at: "document_idle";
    },
  ];
};

const EMPTY_OAUTH: PublicOAuth = { clientId: "", extensionKey: "" };

function shell(): ExtensionManifest {
  return {
    manifest_version: 3,
    name: "wa-scribe",
    version: "0.0.1",
    description: "Synthetic Drive probe. Chat export is not included.",
    minimum_chrome_version: "114",
    action: { default_title: "wa-scribe" },
    side_panel: { default_path: "panel.html" },
    background: { service_worker: "background.js" },
    permissions: ["sidePanel"],
  };
}

export function createManifest(target: ExtensionTarget, oauth: PublicOAuth = EMPTY_OAUTH): ExtensionManifest {
  const manifest = shell();
  const hosts: string[] = [];
  if (target === "test") hosts.push(FIXTURE_MATCH);
  if (oauthReady(oauth)) {
    manifest.permissions = ["sidePanel", "identity", "storage"];
    manifest.oauth2 = { client_id: oauth.clientId, scopes: [DRIVE_FILE_SCOPE] };
    manifest.key = oauth.extensionKey;
    hosts.push(GOOGLE_API);
  }
  if (hosts.length > 0) manifest.host_permissions = hosts;
  if (target === "production") return manifest;
  // The fixture origin exists only in the test build. Production cannot read that page.
  return {
    ...manifest,
    content_scripts: [{ matches: [FIXTURE_MATCH], js: ["content.js"], run_at: "document_idle" }],
  };
}
