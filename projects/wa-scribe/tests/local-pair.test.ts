import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, type LocalStore } from "../local/store";
import { decodeMetadata, encodeExport, parseTranscript } from "../src/format";
import type { ObservedMessage } from "../src/download";
import type { AttachmentSlot } from "../src/model";
import type { CollectedChat, OpenChat } from "../src/whatsapp";

const expected: OpenChat = { accountId: "15551234567@c.us", chatId: "120363000000000000@g.us", name: "Class 3A" };
const stores: { output: string; store: LocalStore }[] = [];
type TestPending = Record<string, unknown> & { markdown: string; metadata: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTestPending(value: unknown): value is TestPending {
  return isRecord(value) && typeof value.markdown === "string" && typeof value.metadata === "string";
}

function observed(attachments: AttachmentSlot[] = []): ObservedMessage {
  return {
    id: "true_15551234567@c.us_3EB0A1",
    sender: { key: "dana", name: "דנה" },
    timestamp: { display: "09:41", precision: "minute", timeZone: null, instant: null },
    sequence: "verified",
    text: "שלום,\nשורה שנייה\n\nסוף\n",
    attachments,
    sourceBaseline: "שלום,\nשורה שנייה\n\nסוף\n",
  };
}

function collected(message: ObservedMessage): CollectedChat {
  return { chat: expected, messages: [message], order: "verified", contiguous: true, stopReason: "rendered-window", deletedIds: [] };
}

async function setup(hooks?: Parameters<typeof createStore>[1]) {
  const output = await mkdtemp(join(tmpdir(), "wa-scribe-pair-"));
  const store = await createStore(output, hooks);
  stores.push({ output, store });
  return { output, store };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
}

async function pendingAt(directory: string): Promise<TestPending> {
  const value: unknown = JSON.parse(await readFile(join(directory, "pending.json"), "utf8"));
  if (!isTestPending(value)) {
    throw new Error("Fixture pending journal has invalid transcript or metadata.");
  }
  return value;
}

async function restart(output: string, prior: LocalStore): Promise<LocalStore> {
  await prior.close();
  const store = await createStore(output);
  stores[stores.length - 1] = { output, store };
  return store;
}

afterEach(async () => {
  const entries = stores.splice(0);
  await Promise.all(entries.map(async ({ output, store }) => {
    await store.close();
    await rm(output, { recursive: true, force: true });
  }));
});

describe("local pending transcript and metadata pair", () => {
  it("commits Hebrew multiline text with a trailing newline and a saved PDF attachment", async () => {
    const { store } = await setup();
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    const attachment = await store.stash(bytes, "סיכום.pdf", "application/pdf");
    if (attachment.state !== "saved" && attachment.state !== "opaque") throw new Error("PDF bytes were not saved");
    await store.preflight(expected);

    const result = await store.commit(expected, collected(observed([{ slot: 1, attachment }])));
    expect(result.status.toLowerCase()).toContain("partial");
    const folder = await store.folder(expected);
    const transcript = await readFile(join(folder, "transcript.md"), "utf8");
    expect(transcript).toContain("דנה");
    expect(transcript).toContain("שלום,\nשורה שנייה\n\nסוף\n");
    expect(transcript).toContain("attachment-link-1:");
    expect(new Uint8Array(await readFile(join(folder, attachment.relativePath)))).toEqual(bytes);
  });

  it("recovers a journal when metadata JSON formatting and key order change", async () => {
    let stopAfterJournal = true;
    const { output, store } = await setup({ checkpoint: async (phase) => {
      if (phase === "journal" && stopAfterJournal) throw new Error("stop after journal");
    } });
    await store.preflight(expected);
    const chatDirectory = await store.folder(expected);
    await expect(store.commit(expected, collected(observed()))).rejects.toThrow("stop after journal");

    const journal = await pendingAt(chatDirectory);
    const metadata: unknown = JSON.parse(journal.metadata);
    journal.metadata = `${JSON.stringify(reverseObjectKeys(metadata), null, 4)}\n`;
    await writeFile(join(chatDirectory, "pending.json"), `${JSON.stringify(journal)}\n`);

    stopAfterJournal = false;
    const reopened = await restart(output, store);
    const recovered = await reopened.recover(expected);
    expect(recovered.status.toLowerCase()).toContain("partial");
    const folder = await reopened.folder(expected);
    expect(await readFile(join(folder, "transcript.md"), "utf8")).toContain("שורה שנייה");
    expect(await readFile(join(folder, "sync.json"), "utf8")).toBe(journal.metadata);
  });

  it.each(["markdown", "metadata"] as const)("preserves the pending journal when %s conflicts with its pair", async (changed) => {
    let stopAfterJournal = true;
    const { output, store } = await setup({ checkpoint: async (phase) => {
      if (phase === "journal" && stopAfterJournal) throw new Error("stop after journal");
    } });
    await store.preflight(expected);
    const chatDirectory = await store.folder(expected);
    await expect(store.commit(expected, collected(observed()))).rejects.toThrow("stop after journal");

    const journal = await pendingAt(chatDirectory);
    if (changed === "markdown") {
      journal.markdown = journal.markdown.replace("שורה שנייה", "שורה שונתה");
    } else {
      const parsed = parseTranscript(journal.markdown);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("fixture transcript did not parse");
      const raw: unknown = JSON.parse(journal.metadata);
      if (!isRecord(raw) || typeof raw.accountId !== "string" || typeof raw.chatId !== "string" ||
          typeof raw.destinationId !== "string" || typeof raw.generation !== "string") {
        throw new Error("fixture metadata has invalid binding fields");
      }
      const decoded = decodeMetadata(journal.metadata, {
        accountId: raw.accountId, chatId: raw.chatId,
        destinationId: raw.destinationId, generation: raw.generation,
      });
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error("fixture metadata did not decode");
      const messages = decoded.value.messages.map((message, index) => index === 0 ? { ...message, text: "metadata text changed" } : message);
      const replacement = encodeExport(parsed.value.prefix, { ...decoded.value, messages });
      expect(replacement.ok).toBe(true);
      if (!replacement.ok) throw new Error("fixture metadata could not be re-encoded");
      journal.metadata = replacement.value.metadata;
    }
    await writeFile(join(chatDirectory, "pending.json"), `${JSON.stringify(journal)}\n`);
    const preserved = await readFile(join(chatDirectory, "pending.json"), "utf8");

    stopAfterJournal = false;
    const reopened = await restart(output, store);
    await expect(reopened.recover(expected)).rejects.toThrow();
    expect(await readFile(join(chatDirectory, "pending.json"), "utf8")).toBe(preserved);
  });
});
