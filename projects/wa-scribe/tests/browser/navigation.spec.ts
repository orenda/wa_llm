import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test, type BrowserContext, type Worker } from "@playwright/test";

const accountId = "15551234567@c.us";
const chatA = "12025550101@c.us", chatB = "12025550102@c.us", chatC = "12025550103@c.us";

async function launch(): Promise<{ context: BrowserContext; worker: Worker; blocked: string[]; cleanup: () => void }> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "wa-scribe-navigation-")), blocked: string[] = [];
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, args: ["--headless=new", `--disable-extensions-except=${path.resolve("dist")}`,
      `--load-extension=${path.resolve("dist")}`], ignoreDefaultArgs: ["--disable-extensions"],
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("chrome-extension://")) return route.continue();
    blocked.push(url);
    return route.abort("blockedbyclient");
  });
  return { context, worker: context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker"), blocked,
    cleanup: () => rmSync(userDataDir, { recursive: true, force: true }) };
}

function pageHtml(wrongDestination: boolean): string {
  const conversation = (chatId: string, label: string, body: string) => `<div id="main"><header><span title="${label}"></span></header>
    <div data-id="false_${chatId}_m1"><div data-pre-plain-text="[12:34, 10/20/2026] Alice: "><span class="selectable-text">${body}</span></div></div></div>`;
  return `<!doctype html><html><body><div id="side"><div id="pane-side">
    ${[[chatB, "Target chat"], [chatC, "Other chat"]].map(([id, title]) => `<div role="row"><span title="${title}" data-destination="${id}">${title}</span></div>`).join("")}
    </div></div>${conversation(chatA, "Current chat", "CHAT_A_ONLY")}
    <script>
      localStorage.setItem("last-wid", "${accountId}");
      for (const label of document.querySelectorAll("#pane-side [title]")) label.addEventListener("mousedown", () => {
        const destination = ${wrongDestination ? `label.title === "Target chat" ? "${chatC}" : label.dataset.destination` : "label.dataset.destination"};
        const title = destination === "${chatB}" ? "Target chat" : "Other chat";
        document.querySelector("#main").outerHTML = '<div id="main"><header><span title="' + title + '"></span></header>' +
          '<div data-id="false_' + destination + '_m1"><div data-pre-plain-text="[12:34, 10/20/2026] Alice: "><span class="selectable-text">' + destination + '_ONLY</span></div></div></div>';
        label.closest("[role=row]").setAttribute("aria-selected", "true");
      });
    </script></body></html>`;
}

async function collect(worker: Worker, tabId: number): Promise<unknown> {
  return worker.evaluate(({ tabId, accountId, chatId }) => new Promise<unknown>((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: "wa-scribe.app" });
    const timeout = setTimeout(() => { port.disconnect(); reject(new Error("Fixture collection timed out")); }, 15_000);
    port.onMessage.addListener((message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message) ||
          (message.type !== "result" && message.type !== "error")) return;
      clearTimeout(timeout); resolve(message); port.disconnect();
    });
    port.postMessage({ type: "collect", expected: { accountId, chatId, name: "Target chat" }, scope: "visible", limit: 20 });
  }), { tabId, accountId, chatId: chatB });
}

for (const wrongDestination of [false, true]) {
  test(wrongDestination ? "worker rejects a sidebar label that opens another conversation" : "worker switches chats through the sidebar and collects only the selected identity",
    async () => {
      const launched = await launch();
      try {
        await launched.context.route("https://web.whatsapp.com/**", (route) => route.fulfill({
          contentType: "text/html", body: pageHtml(wrongDestination),
        }));
        const page = await launched.context.newPage();
        await page.goto("https://web.whatsapp.com/");
        const tabId = await launched.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
          if (tab?.id === undefined) throw new Error("Fixture tab is missing");
          return tab.id;
        });
        await expect.poll(() => launched.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, {
          protocol: "wa-scribe.app", type: "inspect",
        }), tabId)).toMatchObject({ ok: true, chat: { accountId, chatId: chatA } });
        const result = await collect(launched.worker, tabId);
        if (wrongDestination) {
          expect(result).toMatchObject({ type: "error", reason: expect.stringMatching(/different conversation/i) });
          expect(JSON.stringify(result)).not.toContain('"type":"result"');
        } else {
          expect(result).toMatchObject({ type: "result", value: { chat: { accountId, chatId: chatB },
            messages: [{ id: `false_${chatB}_m1`, text: `${chatB}_ONLY` }] } });
          expect(JSON.stringify(result)).not.toContain("CHAT_A_ONLY");
          expect(JSON.stringify(result)).not.toContain(`${chatC}_ONLY`);
        }
        expect(launched.blocked.some((url) => /googleapis\.com|drive\.google\.com/.test(url))).toBe(false);
      } finally { await launched.context.close(); launched.cleanup(); }
    });
}
