import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";

const accountId = "15551234567@c.us";
const chatId = "12025550123@c.us";
const messageId = `false_${chatId}_fixturemsg`;
const fixtureBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x80, 0x0a]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function launch(): Promise<{
  context: BrowserContext;
  worker: Worker;
  page: Page;
  blocked: string[];
  cleanup: () => void;
}> {
  const extensionDir = path.resolve("dist-test");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "wa-scribe-media-"));
  const blocked: string[] = [];
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ["--headless=new", `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    ignoreDefaultArgs: ["--disable-extensions"],
  });
  const pageHtml = `<!doctype html><html><body>
    <aside id="pane-side"><div aria-selected="true"></div></aside>
    <main id="main"><header><span title="Fixture chat">Fixture chat</span></header>
      <div class="message-in" data-id="${messageId}" data-pre-plain-text="[10:30, 1/2/2026] Alice: ">
        <span class="selectable-text">Document fixture</span>
        <div data-testid="document-thumb">fixture.pdf</div>
        <button type="button" data-testid="download-button" aria-label="Download">Download</button>
      </div>
    </main>
    <script>
      document.querySelector("[data-testid='download-button']").addEventListener("click", () => {
        const blob = new Blob([Uint8Array.from(${JSON.stringify([...fixtureBytes])})], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "fixture.pdf";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    </script>
  </body></html>`;
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === "https://web.whatsapp.com/") {
      await route.fulfill({ contentType: "text/html", body: pageHtml });
    } else if (url.startsWith("chrome-extension://")) {
      await route.continue();
    } else {
      blocked.push(url);
      await route.abort("blockedbyclient");
    }
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  await page.goto("https://web.whatsapp.com/");
  await page.evaluate(async ({ accountId, messageId, expectedDigest, size, bytes }) => {
    localStorage.setItem("last-wid", accountId);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open("model-storage", 2070);
      opening.onupgradeneeded = () => opening.result.createObjectStore("message", { keyPath: "id" });
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => resolve(opening.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction("message", "readwrite");
        tx.objectStore("message").put({ id: messageId, filehash: expectedDigest, size, mimetype: "application/pdf", filename: "fixture.pdf" });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally { database.close(); }
    if (bytes.length === 0) throw new Error("Fixture bytes are empty.");
  }, {
    accountId,
    messageId,
    expectedDigest: createHash("sha256").update(fixtureBytes).digest("hex"),
    size: fixtureBytes.byteLength,
    bytes: [...fixtureBytes],
  });
  await expect.poll(() => worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
    if (tab?.id === undefined) return false;
    try {
      const response: unknown = await chrome.tabs.sendMessage(tab.id, { protocol: "wa-scribe.app", type: "account" });
      return typeof response === "object" && response !== null && "ok" in response && response.ok === true;
    } catch { return false; }
  })).toBe(true);
  return { context, worker, page, blocked, cleanup: () => rmSync(userDataDir, { recursive: true, force: true }) };
}

async function collect(launched: Awaited<ReturnType<typeof launch>>): Promise<unknown> {
  return launched.worker.evaluate(({ accountId, chatId }) => new Promise<unknown>((resolve, reject) => {
    const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    let settled = false;
    let port: chrome.runtime.Port | undefined;
    let media: unknown = null;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (error: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      port?.disconnect();
      if (error) reject(error);
      else resolve(result);
    };
    timeout = setTimeout(() => finish(new Error("Media collection timed out")), 15_000);
    void chrome.tabs.query({ url: "https://web.whatsapp.com/*" }).then(async (tabs) => {
      const tab = tabs.find((candidate) => candidate.id !== undefined);
      if (tab?.id === undefined) throw new Error("Fixture WhatsApp tab is missing");
      const account = await chrome.tabs.sendMessage(tab.id, { protocol: "wa-scribe.app", type: "account" });
      if (!isRecord(account) || account.ok !== true || account.accountId !== accountId) throw new Error("Fixture account was not ready");
      port = chrome.tabs.connect(tab.id, { name: "wa-scribe.app" });
      port.onMessage.addListener((message: unknown) => {
        if (!isRecord(message)) return;
        if (message.type === "media") {
          media = message;
          if (typeof message.requestId !== "string") { finish(new Error("Missing media request ID")); return; }
          port?.postMessage({
            type: "media-ack", requestId: message.requestId, ok: true,
            attachment: { state: "saved", name: "fixture.pdf", relativePath: "media/fixture.pdf", mediaType: "application/pdf" },
          });
        } else if (message.type === "result") {
          finish(null, { result: message.value, media });
        } else if (message.type === "error") {
          finish(new Error(typeof message.reason === "string" ? message.reason : "Collection failed"));
        }
      });
      port.onDisconnect.addListener(() => finish(new Error("Media collection port disconnected")));
      port.postMessage({ type: "collect", expected: { accountId, chatId, name: "Fixture chat" }, navigationName: "Fixture chat", scope: "visible", limit: 10 });
    }).catch((error: unknown) => finish(error instanceof Error ? error : new Error("Unable to connect to the WhatsApp tab")));
  }), { accountId, chatId });
}

for (const scenario of [
  { name: "stages exact non-UTF8 bytes after digest verification", matches: true },
  { name: "keeps a mismatched native download unavailable without sending bytes", matches: false },
]) {
  test(`native media collection ${scenario.name}`, async () => {
    const launched = await launch();
    try {
      if (!scenario.matches) {
        await launched.page.evaluate(async (messageId) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const opening = indexedDB.open("model-storage", 2070);
            opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => resolve(opening.result);
          });
          try {
            await new Promise<void>((resolve, reject) => {
              const tx = database.transaction("message", "readwrite");
              tx.objectStore("message").put({ id: messageId, filehash: "0".repeat(64), size: 9, mimetype: "application/pdf", filename: "fixture.pdf" });
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
          } finally { database.close(); }
        }, messageId);
      }
      const observed = await collect(launched);
      expect(launched.blocked.filter((url) => url.includes("googleapis.com"))).toEqual([]);
      if (!isRecord(observed) || !isRecord(observed.result)) throw new Error("Collection result was malformed.");
      const messages = observed.result.messages;
      expect(messages).toHaveLength(1);
      expect(messages).toMatchObject([{ id: messageId, attachments: [{ slot: 1 }] }]);
      if (scenario.matches) {
        if (!isRecord(observed.media) || typeof observed.media.base64 !== "string") throw new Error("Media payload was not sent.");
        expect(observed.media.messageId).toBe(messageId);
        expect(Buffer.from(observed.media.base64, "base64")).toEqual(Buffer.from(fixtureBytes));
        expect(messages).toMatchObject([{
          id: messageId,
          attachments: [{ slot: 1, attachment: { state: "saved", name: "fixture.pdf", mediaType: "application/pdf", relativePath: "media/fixture.pdf" } }],
        }]);
      } else {
        expect(observed.media).toBeNull();
        expect(messages).toMatchObject([{ id: messageId, attachments: [{ slot: 1, attachment: { state: "unavailable" } }] }]);
      }
    } finally {
      await launched.context.close();
      launched.cleanup();
    }
  });
}
