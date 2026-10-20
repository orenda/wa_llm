import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { PROTOCOL } from "../../src/protocol";
import { isAllowedTestRequest } from "../network-policy";

const DRIVE_FILE = "https://drive.google.com/file/example";

async function launch(
  extensionDir: string,
): Promise<{ context: BrowserContext; worker: Worker; blocked: string[]; cleanup: () => void }> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "wa-scribe-"));
  const blocked: string[] = [];
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      "--headless=new",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
    ignoreDefaultArgs: ["--disable-extensions"],
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (isAllowedTestRequest(url)) {
      await route.continue();
      return;
    }
    blocked.push(url);
    await route.abort("blockedbyclient");
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  return {
    context,
    worker,
    blocked,
    cleanup: () => {
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

async function readJson(page: Page, selector: string): Promise<unknown> {
  const locator = page.locator(selector);
  let reply: unknown;
  await expect
    .poll(
      async () => {
        try {
          reply = JSON.parse((await locator.innerText()).trim());
          return "ready";
        } catch {
          return "pending";
        }
      },
      { timeout: 10_000 },
    )
    .toBe("ready");
  return reply;
}

test("production extension loads without fixture access", async () => {
  const extensionDir = path.resolve("dist");
  const launched = await launch(extensionDir);
  try {
    const manifest = await launched.worker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.permissions).toEqual(["sidePanel", "identity", "storage", "tabs"]);
    expect(manifest.host_permissions).toEqual(["https://web.whatsapp.com/*", "https://www.googleapis.com/*"]);
    expect(manifest.content_scripts).toEqual([
      { matches: ["https://web.whatsapp.com/*"], js: ["media-bridge.js"], run_at: "document_start", world: "MAIN" },
      { matches: ["https://web.whatsapp.com/*"], js: ["content.js"], run_at: "document_idle" },
    ]);
    expect(launched.worker.url()).toMatch(/^chrome-extension:\/\/.+\/background\.js$/);

    const fixture = await launched.context.newPage();
    await fixture.goto("http://127.0.0.1:4179/chat.html");
    await fixture.waitForTimeout(400);
    await expect(fixture.locator("#content-ack")).toHaveText("waiting");
    await expect(fixture.locator("#content-wrong-context")).toHaveText("waiting");

    const extensionId = launched.worker.url().split("/")[2];
    const panel = await launched.context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    expect(manifest.oauth2?.client_id).toBe("261687786907-34o4h04n6l78dvd9dsqov3pfvp8puh15.apps.googleusercontent.com");
    await expect(panel.locator("#status")).toHaveText("Google Drive has not been connected.");
    await expect(panel.locator("#connect")).toBeEnabled();
    await expect(panel.locator("#probe-run")).toBeDisabled();
    await expect(panel.locator("#refresh")).toBeEnabled();
    await panel.locator("#sync-settings > summary").click();
    await expect(panel.locator("#add-current")).toBeEnabled();
    await expect(panel.locator("#mode-warning")).toContainText("8 MiB per file");
    await panel.locator("#mode").selectOption("edit");
    await expect(panel.locator("#mode-warning")).toContainText("Edit mode can remove saved content");
    await panel.locator("#mode").selectOption("download");
    expect(launched.blocked.filter((url) => url.includes("googleapis.com"))).toEqual([]);
    const panelReply = await panel.evaluate((protocol) => new Promise<unknown>((resolve) => {
      chrome.runtime.sendMessage({ protocol, type: "panel-ping", requestId: "browser-panel" }, resolve);
    }), PROTOCOL);
    expect(panelReply).toEqual({
      protocol: PROTOCOL,
      type: "panel-pong",
      requestId: "browser-panel",
      context: "panel",
    });
    const invalidReply = await panel.evaluate((protocol) => new Promise<unknown>((resolve) => {
      chrome.runtime.sendMessage({ protocol, type: "nope", requestId: "browser-invalid" }, resolve);
    }), PROTOCOL);
    expect(invalidReply).toMatchObject({
      type: "rejected",
      reason: "invalid-request",
      requestId: "browser-invalid",
    });
    await expect(panel.locator("body")).not.toContainText(/exported/i);
  } finally {
    await launched.context.close();
    launched.cleanup();
  }
});

test("test build exchanges panel and content messages on the fixture", async () => {
  const extensionDir = path.resolve("dist-test");
  const launched = await launch(extensionDir);
  try {
    const manifest = await launched.worker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.content_scripts?.[0]).toEqual({
      matches: ["https://web.whatsapp.com/*"], js: ["media-bridge.js"], run_at: "document_start", world: "MAIN",
    });
    expect(manifest.content_scripts?.[1]?.matches).toEqual(["https://web.whatsapp.com/*", "http://127.0.0.1:4179/*"]);
    expect(manifest.host_permissions).toEqual(["https://web.whatsapp.com/*", "https://www.googleapis.com/*", "http://127.0.0.1:4179/*"]);

    const fixture = await launched.context.newPage();
    await fixture.goto("http://127.0.0.1:4179/chat.html");
    expect(await readJson(fixture, "#content-ack")).toEqual({
      protocol: PROTOCOL,
      type: "content-ack",
      requestId: "content-hello",
      context: "content",
    });
    expect(await readJson(fixture, "#content-wrong-context")).toMatchObject({
      type: "rejected",
      requestId: "content-as-panel",
      reason: "unexpected-sender",
    });
    const diagnostic = await readJson(fixture, "#source-diagnostic");
    expect(diagnostic).toMatchObject({ mode: "diagnostic", rowCount: 3, placeholderCount: 1, rowsMissingId: 0 });
    expect(JSON.stringify(diagnostic)).not.toContain("Same minute");
    await expect(fixture.locator("#source-probe")).toHaveText("waiting");

    const probed = await launched.context.newPage();
    await probed.goto("http://127.0.0.1:4179/chat.html?probe=1");
    const snapshot = await readJson(probed, "#source-probe");
    expect(snapshot).toMatchObject({ ok: true, snapshot: { accountId: "acct-1", chatId: "chat-1" } });

    const downloaded = await launched.context.newPage();
    await downloaded.goto("http://127.0.0.1:4179/chat.html?download=1");
    const alpha = await readJson(downloaded, "#alpha-result");
    expect(alpha).toMatchObject({ phase: "updated", ids: ["m40", "m41"] });
    expect(JSON.stringify(alpha)).not.toContain("googleapis");

    const delayed = await launched.context.newPage();
    await delayed.goto("http://127.0.0.1:4179/chat.html?replyDelay=800");
    await delayed.waitForTimeout(200);
    await expect(delayed.locator("#content-ack")).toHaveText("waiting");
    expect(await readJson(delayed, "#content-ack")).toEqual({
      protocol: PROTOCOL,
      type: "content-ack",
      requestId: "content-hello",
      context: "content",
    });

    const driveFetch = await fixture.evaluate(async (url) => {
      try {
        await fetch(url);
        return "allowed";
      } catch {
        return "blocked";
      }
    }, DRIVE_FILE);
    expect(driveFetch).toBe("blocked");
    expect(launched.blocked.some((url) => url.startsWith("https://drive.google.com/file/"))).toBe(true);

    const liveNavigation = await fixture.goto("https://web.whatsapp.com/").then(
      () => "allowed",
      () => "blocked",
    );
    expect(liveNavigation).toBe("blocked");
  } finally {
    await launched.context.close();
    launched.cleanup();
  }
});

test("native bridge captures an armed normal document download and leaves unarmed anchors alone", async () => {
  const launched = await launch(path.resolve("dist-test"));
  const fixturePdf = "%PDF-1.7\nsynthetic bridge fixture\n";
  const fixtureLiteral = JSON.stringify(fixturePdf);
  try {
    await launched.context.route("https://web.whatsapp.com/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><button id="normal-download">Download document</button>
        <script>
          document.querySelector("#normal-download").addEventListener("click", () => {
            const blob = new Blob([${fixtureLiteral}], { type: "application/pdf" });
            const url = URL.createObjectURL(blob);
            document.body.dataset.blobUrl = url;
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "fixture.pdf";
            anchor.click();
          });
        </script>`,
    }));
    const page = await launched.context.newPage();
    await page.goto("https://web.whatsapp.com/");
    let downloadCount = 0;
    page.on("download", () => { downloadCount += 1; });
    const restoredDownloadPromise = page.waitForEvent("download", { timeout: 5_000 });
    const outcomePromise = page.evaluate(async (fixtureText) => {
      const channel = "wa-scribe.media";
      const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fixtureText));
      const expectedDigest = [...new Uint8Array(digestBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const attempt = (digest: string) => new Promise<
        { type: "captured"; name: string; mediaType: string; bytes: number[] } | { type: "failed" }
      >((resolve, reject) => {
        const nonce = crypto.randomUUID();
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", receive);
          reject(new Error("Native media bridge timed out"));
        }, 5_000);
        const receive = (event: MessageEvent<unknown>) => {
          const value = event.data;
          if (event.source !== window || event.origin !== location.origin || typeof value !== "object" || value === null ||
              !("channel" in value) || value.channel !== channel || !("nonce" in value) || value.nonce !== nonce || !("type" in value)) return;
          if (value.type === "armed") {
            document.querySelector<HTMLButtonElement>("#normal-download")?.click();
            return;
          }
          if (value.type === "failed") {
            window.clearTimeout(timeout);
            window.removeEventListener("message", receive);
            resolve({ type: "failed" });
            return;
          }
          if (value.type !== "captured" || !("name" in value) || typeof value.name !== "string" ||
              !("blob" in value) || !(value.blob instanceof Blob)) return;
          const name = value.name;
          const blob = value.blob;
          window.clearTimeout(timeout);
          window.removeEventListener("message", receive);
          void blob.arrayBuffer().then((bytes) => resolve({
            type: "captured", name, mediaType: blob.type, bytes: [...new Uint8Array(bytes)],
          }), reject);
        };
        window.addEventListener("message", receive);
        window.postMessage({ channel, nonce, type: "arm", expectedDigest: digest }, location.origin);
      });
      const captured = await attempt(expectedDigest);
      if (captured.type !== "captured") return { captured, mismatch: null };
      const firstUrl = document.body.dataset.blobUrl;
      if (firstUrl) URL.revokeObjectURL(firstUrl);
      delete document.body.dataset.blobUrl;
      const mismatch = await attempt("0".repeat(64));
      return { captured, mismatch };
    }, fixturePdf);
    const [outcome, restoredDownload] = await Promise.all([outcomePromise, restoredDownloadPromise]);
    expect(outcome.captured).toEqual({
      type: "captured", name: "fixture.pdf", mediaType: "application/pdf",
      bytes: [...new TextEncoder().encode(fixturePdf)],
    });
    expect(outcome.mismatch).toEqual({ type: "failed" });
    expect(restoredDownload.suggestedFilename()).toBe("fixture.pdf");
    expect(downloadCount).toBe(1);
    const unarmedAnchorDispatched = await page.evaluate(() => {
      const anchor = document.createElement("a");
      anchor.href = "#native-anchor-check";
      anchor.download = "native.txt";
      let dispatched = false;
      anchor.addEventListener("click", (event) => { dispatched = true; event.preventDefault(); });
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      const url = document.body.dataset.blobUrl;
      if (url) URL.revokeObjectURL(url);
      return dispatched;
    });
    expect(unarmedAnchorDispatched).toBe(true);
    expect(launched.blocked.filter((url) => url.includes("googleapis.com"))).toEqual([]);
  } finally {
    await launched.context.close();
    launched.cleanup();
  }
});

test("production adapter resolves opaque DOM IDs using native IndexedDB keys only", async () => {
  const launched = await launch(path.resolve("dist"));
  const rawIds = ["0123456789abcdefabcd", "0123456789abcdef0123456789abcdef"];
  const expected = { accountId: "15551234567@c.us", chatId: "12025550123@c.us", name: "Fixture chat" };
  const keys = rawIds.map((id, index) => `${index === 1}_${expected.chatId}_${id}`);
  try {
    await launched.context.route("https://web.whatsapp.com/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><div id="pane-side"><div aria-selected="true"></div></div>
        <div id="main"><header><span title="Fixture chat"></span></header>
        ${rawIds.map((id, index) => `<div data-id="${id}"><div data-pre-plain-text="[12:3${index}, 10/20/2026] Alice: ">
          <span class="selectable-text">DOM message ${index + 1}</span></div></div>`).join("")}</div>`,
    }));
    const page = await launched.context.newPage();
    await page.goto("https://web.whatsapp.com/");
    await page.evaluate(async ({ accountId, keys }) => {
      localStorage.setItem("last-wid", accountId);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open("model-storage", 2070);
        opening.onupgradeneeded = () => opening.result.createObjectStore("message", { keyPath: "id" });
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => resolve(opening.result);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("message", "readwrite"), store = tx.objectStore("message");
          for (const id of [...keys, "notification-template", "false_99999999999@c.us_deadbeefdeadbeefdead"]) {
            store.put({ id, body: "DATABASE BODY MUST NOT BE COLLECTED" });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally { db.close(); }
    }, { accountId: expected.accountId, keys });
    const tabId = await launched.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
      if (tab?.id === undefined) throw new Error("Fixture tab is missing");
      return tab.id;
    });
    const inspect = () => launched.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, {
      protocol: "wa-scribe.app", type: "inspect",
    }), tabId);
    await expect.poll(() => inspect().catch(() => null)).toMatchObject({ ok: true, chat: expected, rendered: 2 });
    const collected = await launched.worker.evaluate(({ tabId, expected }) => new Promise<unknown>((resolve, reject) => {
      const port = chrome.tabs.connect(tabId, { name: "wa-scribe.app" });
      const timeout = setTimeout(() => { port.disconnect(); reject(new Error("Fixture collection timed out")); }, 10_000);
      port.onMessage.addListener((message: unknown) => {
        if (typeof message !== "object" || message === null || !("type" in message) || message.type === "progress") return;
        clearTimeout(timeout);
        resolve(message);
        port.disconnect();
      });
      port.postMessage({ type: "collect", expected, scope: "visible", limit: 20 });
    }), { tabId, expected });
    expect(collected).toMatchObject({ type: "result", value: {
      chat: expected, order: "verified", contiguous: true, stopReason: "visible-window",
      messages: [{ id: keys[0], text: "DOM message 1" }, { id: keys[1], text: "DOM message 2" }],
    } });
    expect(JSON.stringify(collected)).not.toContain("DATABASE BODY MUST NOT BE COLLECTED");
    await page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open("model-storage", 2070);
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => resolve(opening.result);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("message", "readwrite");
          tx.objectStore("message").put({ id: `false_99999999999@c.us_${id}` });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally { db.close(); }
    }, rawIds[0]);
    expect(await inspect()).toMatchObject({ ok: false, reason: "A rendered message ID matches multiple local message keys." });
    expect(launched.blocked.filter((url) => url.includes("googleapis.com"))).toEqual([]);
  } finally {
    await launched.context.close();
    launched.cleanup();
  }
});
