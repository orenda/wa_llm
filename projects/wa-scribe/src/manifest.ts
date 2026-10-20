import { DRIVE_FILE_SCOPE, oauthReady, type PublicOAuth } from "./public-config.ts";
import { EXTENSION_KEY } from "./extension-key.ts";

export const FIXTURE_MATCH = "http://127.0.0.1:4179/*";
export const WHATSAPP_MATCH = "https://web.whatsapp.com/*";
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
      matches: string[];
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
    version: "0.1.1",
    description: "Export explicitly selected WhatsApp Web conversations to Markdown in your Google Drive.",
    minimum_chrome_version: "116",
    action: { default_title: "wa-scribe" },
    side_panel: { default_path: "panel.html" },
    background: { service_worker: "background.js" },
    permissions: ["sidePanel", "identity", "storage", "tabs"],
    key: EXTENSION_KEY,
  };
}

export function createManifest(target: ExtensionTarget, oauth: PublicOAuth = EMPTY_OAUTH): ExtensionManifest {
  const manifest = shell();
  const hosts: string[] = [WHATSAPP_MATCH, GOOGLE_API];
  if (target === "test") hosts.push(FIXTURE_MATCH);
  if (oauthReady(oauth)) {
    manifest.oauth2 = { client_id: oauth.clientId, scopes: [DRIVE_FILE_SCOPE] };
    manifest.key = oauth.extensionKey;
  }
  if (hosts.length > 0) manifest.host_permissions = hosts;
  return {
    ...manifest,
    content_scripts: [{ matches: target === "test" ? [WHATSAPP_MATCH, FIXTURE_MATCH] : [WHATSAPP_MATCH], js: ["content.js"], run_at: "document_idle" }],
  };
}
