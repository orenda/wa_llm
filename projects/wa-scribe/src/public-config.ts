import { EXTENSION_KEY } from "./extension-key.ts";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export type PublicOAuth = {
  clientId: string;
  extensionKey: string;
};

declare const WA_SCRIBE_OAUTH_CLIENT_ID: string;
declare const WA_SCRIBE_EXTENSION_KEY: string;

export function publicOAuth(env: { WA_SCRIBE_OAUTH_CLIENT_ID?: string; WA_SCRIBE_EXTENSION_KEY?: string }): PublicOAuth {
  return {
    clientId: (env.WA_SCRIBE_OAUTH_CLIENT_ID ?? "").trim(),
    extensionKey: (env.WA_SCRIBE_EXTENSION_KEY ?? EXTENSION_KEY).trim() || EXTENSION_KEY,
  };
}

/** Values compiled into the extension. Empty means the owner has not configured setup. */
export function bakedOAuth(): PublicOAuth {
  // Owners can configure the installed manifest without a Node/build toolchain.
  if (typeof chrome !== "undefined" && chrome.runtime?.getManifest) {
    const manifest = chrome.runtime.getManifest();
    return { clientId: manifest.oauth2?.client_id ?? "", extensionKey: manifest.key ?? EXTENSION_KEY };
  }
  return publicOAuth({
    WA_SCRIBE_OAUTH_CLIENT_ID,
    WA_SCRIBE_EXTENSION_KEY,
  });
}

export function oauthReady(config: PublicOAuth): boolean {
  if (!/^[0-9]{6,}-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(config.clientId)) return false;
  if (config.extensionKey.length < 80 || config.extensionKey.length > 2000) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(config.extensionKey);
}
