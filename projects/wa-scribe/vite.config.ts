import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type UserConfig } from "vite";
import { createManifest, type ExtensionTarget } from "./src/manifest.ts";
import { publicOAuth } from "./src/public-config.ts";

type Entry = "background" | "content" | "media-bridge" | "panel";

function readEntry(): Entry {
  const value = process.env.WA_ENTRY;
  if (value === "background" || value === "content" || value === "media-bridge" || value === "panel") return value;
  throw new Error("Set WA_ENTRY to background, content, media-bridge, or panel. Use npm run build.");
}

const bakedClientId = JSON.stringify(process.env.WA_SCRIBE_OAUTH_CLIENT_ID ?? "");
const bakedExtensionKey = JSON.stringify(process.env.WA_SCRIBE_EXTENSION_KEY ?? "");

export default defineConfig(({ mode }): UserConfig => {
  const entry = readEntry();
  const target: ExtensionTarget = mode === "test" ? "test" : "production";
  const outDir = target === "test" ? "dist-test" : "dist";
  const root = process.cwd();
  const define = {
    WA_SCRIBE_OAUTH_CLIENT_ID: bakedClientId,
    WA_SCRIBE_EXTENSION_KEY: bakedExtensionKey,
  };

  if (entry === "panel") {
    return {
      base: "./",
      publicDir: false,
      define,
      build: {
        outDir,
        emptyOutDir: false,
        sourcemap: false,
        target: "es2022",
        modulePreload: false,
        rollupOptions: {
          input: resolve(root, "src/panel.html"),
          output: {
            entryFileNames: "panel.js",
            assetFileNames: "[name][extname]",
            codeSplitting: false,
          },
        },
      },
      plugins: [
        {
          name: "wa-scribe-panel-output",
          apply: "build",
          enforce: "post",
          generateBundle(_options, bundle) {
            for (const item of Object.values(bundle)) {
              if (item.type !== "asset" || !item.fileName.endsWith("panel.html")) continue;
              item.fileName = "panel.html";
              const html = typeof item.source === "string" ? item.source : new TextDecoder().decode(item.source);
              item.source = html.replace('src="../panel.js"', 'src="./panel.js"');
            }
          },
          closeBundle() {
            const directory = resolve(root, outDir);
            mkdirSync(directory, { recursive: true });
            writeFileSync(
              resolve(directory, "manifest.json"),
              `${JSON.stringify(createManifest(target, publicOAuth(process.env)), null, 2)}\n`,
            );
          },
        },
      ],
    };
  }

  return {
    base: "./",
    publicDir: false,
    define,
    build: {
      outDir,
      emptyOutDir: entry === "background",
      sourcemap: false,
      target: "es2022",
      rollupOptions: {
        input: resolve(root, `src/${entry}.ts`),
        output: {
          format: "iife",
          name: "WaScribe",
          entryFileNames: `${entry}.js`,
          codeSplitting: false,
        },
      },
    },
  };
});
