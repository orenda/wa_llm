import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, type LocalStore } from "../local/store";
import type { ObservedMessage } from "../src/download";
import type { AttachmentSlot } from "../src/model";
import type { CollectedChat, OpenChat } from "../src/whatsapp";

const expected: OpenChat = { accountId: "15551234567@c.us", chatId: "120363000000000000@g.us", name: "Class 3A" };
const chatKey = createHash("sha256").update(JSON.stringify([expected.accountId, expected.chatId])).digest("hex").slice(0, 16);
const cleanup: { output: string; store: LocalStore }[] = [];

function observed(id: string, attachments: AttachmentSlot[] = []): ObservedMessage {
  return {
    id, sender: { key: "dana", name: "Dana" },
    timestamp: { display: "09:41", precision: "minute", timeZone: null, instant: null },
    sequence: "verified", text: `text ${id}`, attachments, sourceBaseline: `baseline ${id}`,
  };
}

function collected(messages = [observed("m40"), observed("m42")]): CollectedChat {
  return { chat: expected, messages, order: "verified", contiguous: true, stopReason: "rendered-window", deletedIds: [] };
}

async function setup(hooks?: Parameters<typeof createStore>[1]) {
  const output = await mkdtemp(join(tmpdir(), "wa-scribe-store-"));
  const store = await createStore(output, hooks);
  cleanup.push({ output, store });
  return { output, root: join(output, chatKey), store };
}

afterEach(async () => {
  const entries = cleanup.splice(0);
  await Promise.all(entries.map(async ({ output, store }) => {
    await store.close();
    await rm(output, { recursive: true, force: true });
  }));
});

describe("local filesystem store", () => {
  it("publishes a coherent partial export and creates no generation for an identical repeat", async () => {
    const { root, store } = await setup();
    await store.preflight(expected);
    const first = await store.commit(expected, collected());
    expect(first.status.toLowerCase()).toContain("partial");
    const folder = await store.folder(expected);
    const markdown = await readFile(join(folder, "transcript.md"), "utf8");
    expect(markdown).toContain("text m40");
    expect(markdown).toContain("text m42");
    const before = await readdir(join(root, "generations"));
    await store.preflight(expected);
    const repeat = await store.commit(expected, collected());
    expect(repeat.status.toLowerCase()).toContain("unchanged");
    expect(await store.folder(expected)).toBe(folder);
    expect(await readdir(join(root, "generations"))).toEqual(before);
    expect((await store.preflight(expected)).chat?.messages.map(({ id }) => id)).toEqual(["m40", "m42"]);
  });

  it("preserves Notes and detects tombstones before collection so deleted media is skipped", async () => {
    const { store } = await setup();
    const bytes = new Uint8Array([1, 2, 3]);
    const attachment = await store.stash(bytes, "../original.bin", null);
    const slots = [{ slot: 1, attachment }];
    await store.preflight(expected);
    await store.commit(expected, collected([observed("m40"), observed("m42", slots)]));
    const folder = await store.folder(expected);
    const markdown = await readFile(join(folder, "transcript.md"), "utf8");
    const notes = "## Notes\r\n\r\nKeep these exact bytes.\r\n\n";
    const last = markdown.lastIndexOf("### message");
    expect(last).toBeGreaterThan(0);
    await writeFile(join(folder, "transcript.md"), notes + markdown.slice(0, last));
    const preflight = await store.preflight(expected);
    expect(preflight.skipIds.has("m42")).toBe(true);
    expect(preflight.knownAttachments.has("m42")).toBe(false);
    expect(preflight.chat?.tombstones).toContainEqual({ messageId: "m42", reason: "local-deletion" });
    await store.commit(expected, collected([observed("m40"), observed("m42", slots)]));
    const saved = await readFile(join(await store.folder(expected), "transcript.md"), "utf8");
    expect(saved.startsWith(notes)).toBe(true);
    expect(saved).not.toContain("text m42");
    expect((await store.preflight(expected)).skipIds.has("m42")).toBe(true);
  });

  it("preserves a partially edited message instead of rewriting it", async () => {
    const { root, store } = await setup();
    await store.preflight(expected);
    await store.commit(expected, collected());
    const folder = await store.folder(expected);
    const path = join(folder, "transcript.md");
    const edited = (await readFile(path, "utf8")).replace("text m40", "my local wording");
    await writeFile(path, edited);
    const pointer = await readFile(join(root, "CURRENT"), "utf8");
    await expect(store.preflight(expected)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(edited);
    expect(await readFile(join(root, "CURRENT"), "utf8")).toBe(pointer);
  });

  it.each(["journal", "generation", "published"] as const)("recovers the same captured IDs after an interruption at %s", async (phase) => {
    let interrupted = false;
    const { output, root, store } = await setup({ checkpoint: async (current) => {
      if (current === phase && !interrupted) { interrupted = true; throw new Error(`interrupted ${phase}`); }
    } });
    await store.preflight(expected);
    await expect(store.commit(expected, collected())).rejects.toThrow(`interrupted ${phase}`);
    await expect(store.preflight(expected)).rejects.toThrow(/recover/i);
    const pending = await readFile(join(root, "pending.json"), "utf8");
    expect(pending).toContain("m40");
    await store.close();
    const reopened = await createStore(output);
    cleanup[cleanup.length - 1] = { output, store: reopened };
    const recovered = await reopened.recover(expected);
    expect(recovered.status.toLowerCase()).toContain("partial");
    const folder = await reopened.folder(expected);
    expect((await reopened.preflight(expected)).chat?.messages.map(({ id }) => id)).toEqual(["m40", "m42"]);
    expect(await readdir(join(root, "generations"))).toHaveLength(1);
    await reopened.recover(expected);
    expect(await reopened.folder(expected)).toBe(folder);
    expect(await readdir(join(root, "generations"))).toHaveLength(1);
    await expect(readFile(join(root, "pending.json"))).rejects.toThrow();
  });

  it("refuses recovery when the previous transcript changes after journaling", async () => {
    let stop = false;
    const { root, store } = await setup({ checkpoint: async (phase) => {
      if (stop && phase === "journal") throw new Error("stop after journal");
    } });
    await store.preflight(expected);
    await store.commit(expected, collected());
    const folder = await store.folder(expected);
    const pointer = await readFile(join(root, "CURRENT"), "utf8");
    await store.preflight(expected);
    stop = true;
    await expect(store.commit(expected, collected([observed("m40"), observed("m42"), observed("m43")]))).rejects.toThrow("stop after journal");
    const path = join(folder, "transcript.md");
    const edited = "## Notes\n\nNew local note.\n\n" + await readFile(path, "utf8");
    await writeFile(path, edited);
    await expect(store.recover(expected)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(edited);
    expect(await readFile(join(root, "CURRENT"), "utf8")).toBe(pointer);
    expect(await readFile(join(root, "pending.json"), "utf8")).toContain("m43");
  });

  it("refuses publication when Notes change after collection preflight", async () => {
    const { root, store } = await setup();
    await store.preflight(expected);
    await store.commit(expected, collected());
    const folder = await store.folder(expected);
    const pointer = await readFile(join(root, "CURRENT"), "utf8");
    await store.preflight(expected);
    const path = join(folder, "transcript.md");
    const edited = "## Notes\n\nWritten during collection.\n\n" + await readFile(path, "utf8");
    await writeFile(path, edited);
    await expect(store.commit(expected, collected([observed("m40"), observed("m42"), observed("m43")]))).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(edited);
    expect(await readFile(join(root, "CURRENT"), "utf8")).toBe(pointer);
  });

  it("verifies saved bytes rather than accepting a transcript link to a missing file", async () => {
    const { store } = await setup();
    const attachment = await store.stash(new Uint8Array([10, 20, 30]), "report.pdf", "application/pdf");
    await store.preflight(expected);
    await store.commit(expected, collected([observed("m40", [{ slot: 1, attachment }])]));
    if (attachment.state !== "saved" && attachment.state !== "opaque") throw new Error("stash did not provide a file");
    const path = join(await store.folder(expected), attachment.relativePath);
    expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([10, 20, 30]));
    await rm(path);
    await expect(store.preflight(expected)).rejects.toThrow();
  });

  it("does not mask current attachment corruption with retained staged bytes during commit", async () => {
    const { output, root, store } = await setup();
    const bytes = new Uint8Array([10, 20, 30]);
    const attachment = await store.stash(bytes, "report.pdf", "application/pdf");
    if (attachment.state !== "saved" && attachment.state !== "opaque") throw new Error("stash did not provide a file");
    const messages = [observed("m40", [{ slot: 1, attachment }])];
    await store.preflight(expected);
    await store.commit(expected, collected(messages));
    const folder = await store.folder(expected);
    const pointer = await readFile(join(root, "CURRENT"), "utf8");
    await store.preflight(expected);
    await writeFile(join(folder, attachment.relativePath), new Uint8Array([99]));
    const key = createHash("sha256").update(bytes).digest("hex");
    expect(new Uint8Array(await readFile(join(output, ".staging", key)))).toEqual(bytes);
    await expect(store.commit(expected, collected([...messages, observed("m42")]))).rejects.toThrow(/corrupt/i);
    expect(await readFile(join(root, "CURRENT"), "utf8")).toBe(pointer);
    await expect(readFile(join(root, "pending.json"))).rejects.toThrow();
  });

  it("preserves a pending save if its previous generation's media becomes corrupt", async () => {
    let stop = false;
    const { root, store } = await setup({ checkpoint: async (phase) => {
      if (stop && phase === "journal") throw new Error("stop before media publication");
    } });
    const attachment = await store.stash(new Uint8Array([10, 20, 30]), "report.pdf", "application/pdf");
    if (attachment.state !== "saved" && attachment.state !== "opaque") throw new Error("stash did not provide a file");
    const messages = [observed("m40", [{ slot: 1, attachment }])];
    await store.preflight(expected);
    await store.commit(expected, collected(messages));
    const folder = await store.folder(expected);
    const pointer = await readFile(join(root, "CURRENT"), "utf8");
    await store.preflight(expected);
    stop = true;
    await expect(store.commit(expected, collected([...messages, observed("m42")]))).rejects.toThrow("stop before media publication");
    const pending = await readFile(join(root, "pending.json"), "utf8");
    await writeFile(join(folder, attachment.relativePath), new Uint8Array([99]));
    await expect(store.recover(expected)).rejects.toThrow(/corrupt/i);
    expect(await readFile(join(root, "CURRENT"), "utf8")).toBe(pointer);
    expect(await readFile(join(root, "pending.json"), "utf8")).toBe(pending);
  });

  it("rejects an escaped journal over its durable budget before installing pending state", async () => {
    const { root, store } = await setup();
    await store.preflight(expected);
    const large = { ...observed("m40"), text: "\\".repeat(80_000) };
    await expect(store.commit(expected, collected([large]))).rejects.toThrow(/256.*journal|journal.*256/i);
    await expect(readFile(join(root, "pending.json"))).rejects.toThrow();
    await expect(readFile(join(root, "CURRENT"))).rejects.toThrow();
    expect(await readdir(join(root, "generations"))).toHaveLength(0);
    await store.preflight(expected);
    expect((await store.commit(expected, collected())).status.toLowerCase()).toContain("partial");
  });

  it("rejects traversal in CURRENT without adopting or touching another folder", async () => {
    const { root, store } = await setup();
    await store.preflight(expected);
    await writeFile(join(root, "CURRENT"), "../foreign\n");
    await expect(store.preflight(expected)).rejects.toThrow();
    expect(await readFile(join(root, "CURRENT"), "utf8")).toBe("../foreign\n");
  });

  it("rejects a symlink substituted for CURRENT", async () => {
    const { output, root, store } = await setup();
    await store.preflight(expected);
    await store.commit(expected, collected());
    const pointer = await readFile(join(root, "CURRENT"), "utf8");
    const foreign = join(output, "foreign-pointer");
    await writeFile(foreign, pointer);
    await rm(join(root, "CURRENT"));
    await symlink(foreign, join(root, "CURRENT"));
    await expect(store.preflight(expected)).rejects.toThrow();
    expect(await readFile(foreign, "utf8")).toBe(pointer);
  });

  it("does not invent a binding for preexisting files", async () => {
    const { root, store } = await setup();
    await mkdir(root);
    await writeFile(join(root, "transcript.md"), "Existing export; preserve me.");
    await expect(store.preflight(expected)).rejects.toThrow();
    expect(await readFile(join(root, "transcript.md"), "utf8")).toBe("Existing export; preserve me.");
    await expect(readFile(join(root, "binding.json"))).rejects.toThrow();
  });

  it("rejects a symlink substituted for an immutable generation", async () => {
    const { output, store } = await setup();
    await store.preflight(expected);
    await store.commit(expected, collected());
    const folder = await store.folder(expected);
    const foreign = join(output, "foreign");
    await rename(folder, foreign);
    await symlink(foreign, folder, "dir");
    await expect(store.preflight(expected)).rejects.toThrow();
    expect(await readFile(join(foreign, "transcript.md"), "utf8")).toContain("text m40");
  });

  it("excludes another writer until its owning store closes", async () => {
    const { output, store } = await setup();
    await expect(createStore(output)).rejects.toThrow(/lock|writer|running/i);
    await store.close();
    const reopened = await createStore(output);
    cleanup[cleanup.length - 1] = { output, store: reopened };
    await reopened.preflight(expected);
  });

  it("releases only its own startup lock when a staging symlink rejects initialization", async () => {
    const output = await mkdtemp(join(tmpdir(), "wa-scribe-store-startup-"));
    let store: LocalStore | undefined;
    try {
      const foreign = join(output, "foreign");
      await mkdir(foreign);
      await writeFile(join(foreign, "sentinel"), "Preserve this foreign file.");
      await symlink(foreign, join(output, ".staging"), "dir");
      await expect(createStore(output)).rejects.toThrow();
      await expect(readdir(join(output, ".wa-scribe.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("Preserve this foreign file.");
      await rm(join(output, ".staging"));
      store = await createStore(output);
      await store.preflight(expected);
      expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("Preserve this foreign file.");
    } finally {
      await store?.close();
      await rm(output, { recursive: true, force: true });
    }
  });
});
