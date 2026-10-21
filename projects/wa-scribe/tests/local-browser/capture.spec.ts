import { createHash } from "node:crypto";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { capturePass, inspectPage, openChat } from "../../local/browser";
import type { AttachmentSlot } from "../../src/model";

const chat = { accountId: "15551234567@c.us", chatId: "12025550123@c.us", name: "Fixture chat" };
const previous = "12025550999@c.us";
const nextChat = { accountId: chat.accountId, chatId: "12025550888@c.us", name: "Next fixture chat" };
const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x80, 0x0a]);
const digest = createHash("sha256").update(pdf).digest("hex");
const id = (index: number) => `false_${chat.chatId}_fixture${index}`;

const pdfViewerUrl = "https://webtp.whatsapp.net/pdf-viewer/?locale=en_US";

async function fixture(page: Page, options: {
  previous?: boolean;
  mismatch?: boolean;
  count?: number;
  pdfViewer?: boolean;
  tileNativeDownload?: boolean;
  preexistingPdf?: boolean;
  pdfUnavailable?: boolean;
  pdfPending?: boolean;
  pdfUnclosable?: boolean;
  unrelatedDialog?: boolean;
  offscreen?: "above" | "below";
  scrollMutation?: "recycle" | "deleted";
} = {}): Promise<string[]> {
  const blocked: string[] = [], count = options.count ?? 1;
  const iframe = `<iframe autofocus data-testid="pdf-viewer-iframe" title="PDF viewer" src="${pdfViewerUrl}"></iframe>`;
  const viewer = (closable: boolean) => `<div data-testid="pdf-overlay" style="position:fixed;inset:0;z-index:1000;background:#fff">
    ${iframe}${closable ? '<button data-testid="close-pdf" aria-label="Close">Close</button>' : ""}
  </div>`;
  const messages = (chatId: string) => Array.from({ length: count }, (_, index) => `
    <div class="message-in" data-id="false_${chatId}_fixture${index}" data-pre-plain-text="[10:30, 1/2/2026] Alice: ">
      <span class="selectable-text">Document ${index}</span>
      <div data-testid="document-thumb">fixture.pdf</div>
      ${options.pdfViewer || options.tileNativeDownload ? "" : '<button data-testid="download-button" aria-label="Download">Download</button>'}
    </div>`).join("");
  const spacer = '<div data-testid="tall-spacer" style="height: 1400px"></div>';
  const main = (chatId: string) => `<header><span title="Fixture chat">Fixture chat</span></header>${
    options.offscreen === "below" ? spacer + messages(chatId) : messages(chatId) + (options.offscreen === "above" ? spacer : "")}`;
  const pdfPage = `<!doctype html><html><body>${options.pdfUnavailable ? "" : '<button autofocus data-testid="download-button" aria-label="Download">Download</button>'}
    <script>document.querySelector("button")?.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      document.body.dataset.downloadRequested = "yes";
      ${options.pdfUnavailable || options.pdfPending ? "" : `const url = URL.createObjectURL(new Blob([Uint8Array.from(${JSON.stringify([...pdf])})], { type: "application/pdf" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "fixture.pdf"; anchor.click();`}
    });</script></body></html>`;
  const html = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>
    <aside id="pane-side"><div role="row"><span id="choose" title="Fixture chat">Fixture chat</span></div>
      <div role="row"><span id="choose-next" title="Next fixture chat">Next fixture chat</span></div></aside>
    <main id="main">${main(options.previous ? previous : chat.chatId)}</main>
    ${options.preexistingPdf ? viewer(!options.pdfUnclosable) : ""}
    ${options.unrelatedDialog ? '<div role="dialog" data-testid="unrelated-dialog">Unrelated dialog</div>' : ""}
    <script>
      localStorage.setItem("last-wid", ${JSON.stringify(chat.accountId)});
      const closeViewer = () => document.querySelector("[data-testid='pdf-overlay']")?.remove();
      document.addEventListener("keydown", (event) => {
        document.body.dataset.escapeCount = String(Number(document.body.dataset.escapeCount || "0") + 1);
        if (event.key === "Escape" && !${Boolean(options.pdfUnclosable)}) closeViewer();
      });
      document.querySelector("[data-testid='close-pdf']")?.addEventListener("click", closeViewer);
      document.querySelector("#pane-side").addEventListener("mousedown", (event) => {
        if (!event.isTrusted) return;
        const title = event.target.closest("[title]")?.getAttribute("title");
        if (!title) return;
        document.body.dataset.trustedDown = "yes";
        document.querySelector("#main").innerHTML = ${JSON.stringify(main(chat.chatId))}.replaceAll("Fixture chat", title);
        if (title === "Next fixture chat") document.querySelector("#main").innerHTML = ${JSON.stringify(main(nextChat.chatId))}.replaceAll("Fixture chat", title);
      });
      document.querySelector("#main").addEventListener("click", (event) => {
        if (!event.isTrusted || !event.target.closest("[data-testid='document-thumb']")) return;
        if (${Boolean(options.tileNativeDownload)}) {
          document.body.dataset.tileDownloads = "yes";
          const url = URL.createObjectURL(new Blob([Uint8Array.from(${JSON.stringify([...pdf])})], { type: "application/pdf" }));
          const anchor = document.createElement("a"); anchor.href = url; anchor.download = "fixture.pdf"; anchor.click();
          return;
        }
        if (!${Boolean(options.pdfViewer)}) return;
        document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(viewer(!options.pdfUnclosable))});
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
      window.addEventListener("scroll", () => {
        document.body.dataset.scrolled = "yes";
        const row = document.querySelector("#main [data-id]");
        if (${JSON.stringify(options.scrollMutation)} === "recycle") row?.setAttribute("data-id", "false_${chat.chatId}_recycled");
        if (${JSON.stringify(options.scrollMutation)} === "deleted") row?.insertAdjacentHTML("beforeend", '<span data-icon="recalled"></span>');
      }, { once: true });
      if (${JSON.stringify(options.offscreen)} === "above") window.scrollTo(0, document.body.scrollHeight);
    </script></body></html>`;
  await page.context().route("**/*", async (route) => {
    if (route.request().url() === "https://web.whatsapp.com/") await route.fulfill({ contentType: "text/html", body: html });
    else if (route.request().url() === pdfViewerUrl) await route.fulfill({ contentType: "text/html", body: pdfPage });
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

for (const position of ["above", "below"] as const) {
  test(`a loaded PDF row ${position} the viewport is scrolled into view before capturing its original`, async ({ page }) => {
    const blocked = await fixture(page, { offscreen: position });
    const row = page.locator(`#main [data-id="${id(0)}"]`);
    const beforeTop = await row.evaluate((element) => element.getBoundingClientRect().top);
    expect(position === "above" ? beforeTop < 0 : beforeTop > 800).toBe(true);
    let staged = 0;

    const result = await capturePass(page, chat, { limit: 50, scope: "loaded" }, async (bytes, name, mediaType) => {
      staged += 1;
      expect([...bytes]).toEqual([...pdf]);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
      expect({ name, mediaType }).toEqual({ name: "fixture.pdf", mediaType: "application/pdf" });
      return { state: "saved", name, mediaType: "application/pdf", relativePath: "media/scrolled.pdf" };
    });

    expect(staged).toBe(1);
    expect(result.messages[0]?.attachments[0]?.attachment.state).toBe("saved");
    expect(await row.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    })).toBe(true);
    expect(await page.locator("body").getAttribute("data-downloads")).toBe(`${id(0)}|`);
    expect(blocked).toEqual([]);
  });
}

for (const mutation of ["recycle", "deleted"] as const) {
  test(`a ${mutation} keyed message after scrolling never stages its original`, async ({ page }) => {
    const blocked = await fixture(page, { offscreen: "below", scrollMutation: mutation });
    let staged = 0;

    const result = await capturePass(page, chat, { limit: 50, scope: "loaded" }, async () => {
      staged += 1;
      return { state: "saved", name: "unexpected.pdf", mediaType: "application/pdf", relativePath: "media/unexpected.pdf" };
    });

    expect(staged).toBe(0);
    expect(await page.locator("body").getAttribute("data-scrolled")).toBe("yes");
    expect(result.messages[0]?.attachments[0]?.attachment.state).toBe("unavailable");
    const attachment = result.messages[0]?.attachments[0]?.attachment;
    expect(attachment?.state).toBe("unavailable");
    expect(attachment?.state === "unavailable" ? attachment.limitation.length : 0).toBeGreaterThan(0);
    expect(await page.locator("body").getAttribute("data-downloads")).toBeNull();
    expect(blocked).toEqual([]);
  });
}

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

test("a document tile can deliver the native original without a separate download button", async ({ page }) => {
  const blocked = await fixture(page, { tileNativeDownload: true });
  let staged = 0;

  const result = await capturePass(page, chat, { limit: 50, scope: "visible" }, async (bytes, name, mediaType) => {
    staged += 1;
    expect([...bytes]).toEqual([...pdf]);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
    expect({ name, mediaType }).toEqual({ name: "fixture.pdf", mediaType: "application/pdf" });
    return { state: "saved", name, mediaType: "application/pdf", relativePath: "media/tile.pdf" };
  });

  expect(staged).toBe(1);
  expect(result.messages[0]?.attachments[0]?.attachment.state).toBe("saved");
  expect(await page.locator("body").getAttribute("data-tile-downloads")).toBe("yes");
  expect(blocked).toEqual([]);
});

test("a preexisting PDF viewer closes before trusted sidebar navigation", async ({ page }) => {
  const blocked = await fixture(page, { previous: true, preexistingPdf: true });

  expect(await openChat(page, chat)).toEqual(chat);

  expect(await page.locator("[data-testid='pdf-overlay']").count()).toBe(0);
  expect(await page.locator("body").getAttribute("data-trusted-down")).toBe("yes");
  expect(blocked).toEqual([]);
});

test("a document tile opens the PDF viewer and captures its native original bytes", async ({ page }) => {
  const blocked = await fixture(page, { pdfViewer: true });
  const staged: Uint8Array[] = [];

  const result = await capturePass(page, chat, { limit: 50, scope: "visible" }, async (bytes, name, mediaType) => {
    staged.push(bytes);
    expect([...bytes]).toEqual([...pdf]);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
    expect({ name, mediaType }).toEqual({ name: "fixture.pdf", mediaType: "application/pdf" });
    return { state: "saved", name, mediaType: "application/pdf", relativePath: "media/pdf-viewer.pdf" };
  });

  expect(staged).toHaveLength(1);
  expect(result.messages[0]?.attachments[0]?.attachment.state).toBe("saved");
  expect(await page.locator("body").getAttribute("data-downloads")).toBeNull();
  expect(await page.locator("[data-testid='pdf-overlay']").count()).toBe(0);
  expect(blocked).toEqual([]);
});

test("an unavailable PDF download stays unavailable, closes the viewer, and permits the next chat", async ({ page }) => {
  const blocked = await fixture(page, { pdfViewer: true, pdfUnavailable: true });
  let staged = 0;

  const result = await capturePass(page, chat, { limit: 50, scope: "visible" }, async () => {
    staged += 1;
    return { state: "saved", name: "unexpected.pdf", mediaType: "application/pdf", relativePath: "media/unexpected.pdf" };
  });

  expect(staged).toBe(0);
  expect(result.messages[0]?.attachments[0]?.attachment.state).toBe("unavailable");
  expect(await page.locator("[data-testid='pdf-overlay']").count()).toBe(0);
  expect(await openChat(page, nextChat)).toEqual(nextChat);
  const after = await inspectPage(page);
  expect(after.ok && after.chat.chatId).toBe(nextChat.chatId);
  expect(blocked).toEqual([]);
});

test("an unclosable PDF viewer gives an actionable error without clicking through it", async ({ page }) => {
  const blocked = await fixture(page, { previous: true, preexistingPdf: true, pdfUnclosable: true });

  await expect(openChat(page, chat)).rejects.toThrow(/PDF viewer|media viewer/i);

  expect(await page.locator("[data-testid='pdf-overlay']").count()).toBe(1);
  expect(await page.locator("body").getAttribute("data-trusted-down")).toBeNull();
  expect(blocked).toEqual([]);
});

test("an unrelated dialog stays open and blocks navigation with a clear error", async ({ page }) => {
  const blocked = await fixture(page, { previous: true, unrelatedDialog: true });

  await expect(openChat(page, chat)).rejects.toThrow(/unrelated.*dialog|dialog.*blocking|close.*dialog/i);

  expect(await page.locator("[data-testid='unrelated-dialog']").count()).toBe(1);
  expect(await page.locator("body").getAttribute("data-trusted-down")).toBeNull();
  expect(await page.locator("body").getAttribute("data-escape-count")).toBeNull();
  expect(blocked).toEqual([]);
});

test("Stop during a pending PDF download closes the owned viewer", async ({ page }) => {
  const blocked = await fixture(page, { pdfViewer: true, pdfPending: true });
  const controller = new AbortController();
  const capture = capturePass(page, chat, { limit: 50, scope: "visible", signal: controller.signal }, async (bytes, name) => ({
    state: "saved", name, mediaType: "application/pdf", relativePath: "media/stopped.pdf",
  }));
  const frame = page.frameLocator("iframe[data-testid='pdf-viewer-iframe']");

  await expect(frame.locator("body")).toHaveAttribute("data-download-requested", "yes");
  controller.abort();
  const result = await capture;

  expect(result.stopReason).toBe("stopped");
  expect(result.messages[0]?.attachments[0]?.attachment.state).toBe("unavailable");
  expect(await page.locator("[data-testid='pdf-overlay']").count()).toBe(0);
  expect(blocked).toEqual([]);
});
