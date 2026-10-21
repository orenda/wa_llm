import { build } from "vite";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

for (const entry of ["main", "page-entry", "panel"]) {
  const node = entry === "main", name = entry === "page-entry" ? "page" : entry;
  await build({
    configFile: false, publicDir: false,
    build: {
      target: node ? "node24" : "es2022", outDir: "local-dist", emptyOutDir: node, minify: false, sourcemap: false,
      rollupOptions: {
        input: resolve(`local/${entry}.ts`),
        external: node ? [/^node:/, "@playwright/test"] : [],
        output: { format: node ? "es" : "iife", name: "WaScribeLocal", entryFileNames: `${name}.${node ? "mjs" : "js"}`, codeSplitting: false },
      },
    },
  });
}
await copyFile("local/panel.html", "local-dist/panel.html");
