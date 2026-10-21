import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const accountId = "15551234567@c.us";
const chatId = "12025550123@c.us";
const opaqueId = "0123456789abcdef0123456789abcdef";
const messageId = `false_${chatId}_${opaqueId}`;
const digest = "0123456789abcdef".repeat(4);

async function openFixture(page: Page): Promise<string[]> {
  const blocked: string[] = [];
  const html = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>
    <header><span title="Fixture chat">Fixture chat</span></header>
    <main id="main"><div class="message-in" data-id="${opaqueId}" data-pre-plain-text="[10:30, 1/2/2026] Alice: ">
      <span class="selectable-text">Fixture message</span>
    </div></main>
    <script>localStorage.setItem("last-wid", ${JSON.stringify(accountId)});</script>
  </body></html>`;
  await page.context().route("**/*", async (route) => {
    if (route.request().url() === "https://web.whatsapp.com/") {
      await route.fulfill({ contentType: "text/html", body: html });
    } else {
      blocked.push(route.request().url());
      await route.abort("blockedbyclient");
    }
  });
  await page.addInitScript({ path: path.resolve("local-dist/page.js") });
  await page.goto("https://web.whatsapp.com/");
  return blocked;
}

async function installDatabase(page: Page, version: number, chatKeyPath = "id"): Promise<void> {
  await page.evaluate(async ({ version, chatKeyPath, accountId, chatId, messageId, digest }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open("model-storage", version);
      opening.onupgradeneeded = () => {
        const db = opening.result;
        db.createObjectStore("chat", { keyPath: chatKeyPath });
        db.createObjectStore("contact", { keyPath: "id" });
        db.createObjectStore("message", { keyPath: "id" });
      };
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => resolve(opening.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(["chat", "contact", "message"], "readwrite");
        transaction.objectStore("chat").put({ id: chatId, chatId, name: "Fixture chat", accountId });
        transaction.objectStore("contact").put({ id: chatId, name: "Contact label" });
        transaction.objectStore("message").put({ id: messageId, filehash: digest, size: 123,
          mimetype: "application/pdf; charset=binary", filename: "fixture.pdf", body: "private content" });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, { version, chatKeyPath, accountId, chatId, messageId, digest });
}

for (const version of [2069, 2099]) {
  test(`local readers accept the installed model-storage version ${version}`, async ({ page }) => {
    const blocked = await openFixture(page);
    await installDatabase(page, version);

    const result = await page.evaluate(async (messageId) => {
      const api = window.waScribeLocal;
      const chats = await api.catalog();
      const row = await api.row(messageId);
      const original = await api.original(messageId);
      const version = (await indexedDB.databases()).find((database) => database.name === "model-storage")?.version;
      return { chats, row, original, version };
    }, messageId);

    expect(result.chats).toEqual({ ok: true, scope: "local-cache", chats: [
      { chatId, name: "Fixture chat", aliases: ["Contact label"] },
    ] });
    expect(result.row).toEqual({ ok: true, rawId: opaqueId, text: "Fixture message" });
    expect(result.original).toEqual({ ok: true, value: {
      digest, size: 123, mediaType: "application/pdf", name: "fixture.pdf",
    } });
    expect(result.version).toBe(version);
    expect(blocked).toEqual([]);
  });
}

test("a recognized database with an invalid store key path is rejected", async ({ page }) => {
  const blocked = await openFixture(page);
  await installDatabase(page, 2099, "chatId");

  const result = await page.evaluate(() => window.waScribeLocal.catalog());

  expect(result.ok).toBe(false);
  expect(blocked).toEqual([]);
  const version = await page.evaluate(async () =>
    (await indexedDB.databases()).find((database) => database.name === "model-storage")?.version);
  expect(version).toBe(2099);
});

test("a missing model-storage database is reported without creating it", async ({ page }) => {
  const blocked = await openFixture(page);

  const result = await page.evaluate(async (messageId) => {
    const catalog = await window.waScribeLocal.catalog();
    const row = await window.waScribeLocal.row(messageId);
    const original = await window.waScribeLocal.original(messageId);
    const databases = await indexedDB.databases();
    return { catalog, row, original, exists: databases.some((database) => database.name === "model-storage") };
  }, messageId);

  expect(result.catalog.ok).toBe(false);
  expect(result.row.ok).toBe(false);
  expect(result.original.ok).toBe(false);
  expect(result.exists).toBe(false);
  expect(blocked).toEqual([]);
});
