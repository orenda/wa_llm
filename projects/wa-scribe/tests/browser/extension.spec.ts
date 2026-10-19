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
    expect(manifest.permissions).toEqual(["sidePanel"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(launched.worker.url()).toMatch(/^chrome-extension:\/\/.+\/background\.js$/);

    const fixture = await launched.context.newPage();
    await fixture.goto("http://127.0.0.1:4179/chat.html");
    await fixture.waitForTimeout(400);
    await expect(fixture.locator("#content-ack")).toHaveText("waiting");

    const extensionId = launched.worker.url().split("/")[2];
    const panel = await launched.context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await expect(panel.locator("#status")).toHaveText(
      "Google setup is missing. Set the OAuth client ID and extension public key, then rebuild.",
    );
    await expect(panel.locator("#connect")).toBeDisabled();
    await expect(panel.locator("#probe-run")).toBeDisabled();
    await expect(panel.locator("#edit-pass")).toBeDisabled();
    await expect(panel.locator("#delete-export")).toBeDisabled();
    await expect(panel.locator("#mode-warning")).toContainText("Finish editing");
    expect(launched.blocked.filter((url) => url.includes("googleapis.com"))).toEqual([]);
    expect(await readJson(panel, "#panel-pong")).toEqual({
      protocol: PROTOCOL,
      type: "panel-pong",
      requestId: "panel-ping",
      context: "panel",
    });
    expect(await readJson(panel, "#panel-wrong-context")).toMatchObject({
      type: "rejected",
      reason: "unexpected-sender",
    });
    expect(await readJson(panel, "#panel-invalid")).toMatchObject({
      type: "rejected",
      requestId: "invalid",
      reason: "invalid-request",
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
    expect(manifest.content_scripts?.[0]?.matches).toEqual(["http://127.0.0.1:4179/*"]);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1:4179/*"]);

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
