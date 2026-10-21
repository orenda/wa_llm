import { createHash } from "node:crypto";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { capturePass, inspectPage, openChat } from "../../local/browser";
import type { AttachmentSlot } from "../../src/model";

const chat = { accountId: "15551234567@c.us", chatId: "12025550123@c.us", name: "Fixture chat" };
const previous = "12025550999@c.us";
const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x80, 0x0a]);
const digest = createHash("sha256").update(pdf).digest("hex");
const id = (index: number) => `false_${chat.chatId}_fixture${index}`;

async function fixture(page: Page, options: { previous?: boolean; mismatch?: boolean; count?: number } = {}): Promise<string[]> {
  const blocked: string[] = [], count = options.count ?? 1;
  const main = (chatId: string) => `<header><span title="Fixture chat">Fixture chat</span></header>${Array.from({ length: count }, (_, index) => `
    <div class="message-in" data-id="false_${chatId}_fixture${index}" data-pre-plain-text="[10:30, 1/2/2026] Alice: ">
      <span class="selectable-text">Document ${index}</span>
      <div data-testid="document-thumb">fixture.pdf</div>
      <button data-testid="download-button" aria-label="Download">Download</button>
    </div>`).join("")}`;
  const html = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>
    <aside id="pane-side"><div role="row"><span id="choose" title="Fixture chat">Fixture chat</span></div></aside>
    <main id="main">${main(options.previous ? previous : chat.chatId)}</main>
    <script>
      localStorage.setItem("last-wid", ${JSON.stringify(chat.accountId)});
      document.querySelector("#choose").addEventListener("mousedown", (event) => {
        if (!event.isTrusted) return;
        document.body.dataset.trustedDown = "yes";
        document.querySelector("#main").innerHTML = ${JSON.stringify(main(chat.chatId))};
      });
      document.querySelector("#main").addEventListener("click", (event) => {
        const button = event.target.closest("[data-testid='download-button']");
        if (!button || !event.isTrusted) return;
        const key = button.closest("[data-id]").dataset.id;
        document.body.dataset.downloads = (document.body.dataset.downloads || "") + key + "|";
        const url = URL.createObjectURL(new Blob([Uint8Array.from(${JSON.stringify([...pdf])})], { type: "application/pdf" }));
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = "fixture.pdf"; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    </script></body></html>`;
  await page.context().route("**/*", async (route) => {
    if (route.request().url() === "https://web.whatsapp.com/") await route.fulfill({ contentType: "text/html", body: html });
    else { blocked.push(route.request().url()); await route.abort("blockedbyclient"); }
  });
  await page.addInitScript({ path: path.resolve("local-dist/page.js") });
  await page.goto("https://web.whatsapp.com/");
  await page.evaluate(async ({ ids, hash, size }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open("model-storage", 2070);
      opening.onupgradeneeded = () => opening.result.createObjectStore("message", { keyPath: "id" });
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => resolve(opening.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("message", "readwrite");
        for (const messageId of ids) transaction.objectStore("message").put({
          id: messageId, filehash: hash, size, mimetype: "application/pdf", filename: "fixture.pdf",
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, { ids: Array.from({ length: count }, (_, index) => id(index)),
    hash: options.mismatch ? createHash("sha256").update("different original").digest("hex") : digest, size: pdf.byteLength });
  return blocked;
}

test("real mousedown navigation verifies the destination's canonical chat ID", async ({ page }) => {
  const blocked = await fixture(page, { previous: true });
  const before = await inspectPage(page);
  expect(before.ok && before.chat.chatId).toBe(previous);

  expect(await openChat(page, chat)).toEqual(chat);

  expect(await page.locator("body").getAttribute("data-trusted-down")).toBe("yes");
  const after = await inspectPage(page);
  expect(after.ok && after.chat.chatId).toBe(chat.chatId);
  expect(blocked).toEqual([]);
});

test("native PDF bytes match the selected original while known and tombstoned media are skipped", async ({ page }) => {
  const blocked = await fixture(page, { count: 3 });
  const known: AttachmentSlot = { slot: 1, attachment: {
    state: "saved", name: "earlier.pdf", mediaType: "application/pdf", relativePath: "media/earlier.pdf",
  } };
  const staged: Uint8Array[] = [];

  const result = await capturePass(page, chat, { limit: 50, scope: "visible", skipMediaIds: new Set([id(2)]),
    knownAttachments: new Map([[id(1), [known]]]) }, async (bytes, name, mediaType) => {
    staged.push(bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
    expect([...bytes]).toEqual([...pdf]);
    expect({ name, mediaType }).toEqual({ name: "fixture.pdf", mediaType: "application/pdf" });
    return { state: "saved", name, mediaType: "application/pdf", relativePath: "media/native.pdf" };
  });

  expect(staged).toHaveLength(1);
  expect(result.messages).toHaveLength(3);
  expect(result.messages[0]?.attachments[0]?.attachment.state).toBe("saved");
  expect(result.messages[1]?.attachments).toEqual([known]);
  expect(result.messages[2]?.attachments[0]?.attachment.state).toBe("unavailable");
  expect(await page.locator("body").getAttribute("data-downloads")).toBe(`${id(0)}|`);
  expect(blocked).toEqual([]);
});

test("a native download with the wrong original hash stays unavailable and never reaches the store", async ({ page }) => {
  const blocked = await fixture(page, { mismatch: true });
  let staged = 0;

  const result = await capturePass(page, chat, { limit: 50, scope: "visible" }, async () => {
    staged += 1;
    return { state: "saved", name: "wrong.pdf", mediaType: "application/pdf", relativePath: "media/wrong.pdf" };
  });

  expect(staged).toBe(0);
  expect(result.messages[0]?.text).toBe("Document 0");
  expect(result.messages[0]?.attachments[0]?.attachment).toEqual({ state: "unavailable",
    limitation: "The downloaded bytes did not match this message's original hash and size." });
  expect(await page.locator("body").getAttribute("data-downloads")).toBe(`${id(0)}|`);
  expect(blocked).toEqual([]);
});
