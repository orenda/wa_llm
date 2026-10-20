import { describe, expect, it } from "vitest";
import { projectChatMetadata } from "../src/chat-catalog";

describe("chat metadata projection", () => {
  it("requires an exact supported primary-key identity", () => {
    const chat = { id: "15551234567@c.us", name: "Alice" };
    expect(projectChatMetadata("15551234567@c.us", chat)).toEqual({
      chatId: "15551234567@c.us", name: "Alice", aliases: [],
    });
    expect(projectChatMetadata("15551234567@g.us", chat)).toBeNull();
    expect(projectChatMetadata("status@broadcast", { id: "status@broadcast", name: "Status" })).toBeNull();
    expect(projectChatMetadata("15551234567@c.us", { ...chat, id: "15557654321@c.us" })).toBeNull();
    expect(projectChatMetadata(17, chat)).toBeNull();
  });

  it("uses validated display labels and keeps contact fields as hints", () => {
    expect(projectChatMetadata("12345-67890@g.us", {
      id: "12345-67890@g.us", formattedTitle: "  Team  ", name: "Team",
    }, {
      id: "12345-67890@g.us", name: "Team", shortName: "Ops", pushname: "Operations",
      phone: "15551234567@c.us",
    })).toEqual({
      chatId: "12345-67890@g.us", name: "Team", aliases: ["Ops", "Operations"],
    });
    expect(projectChatMetadata("15551234567@c.us", {
      id: "15551234567@c.us", formattedTitle: " ", name: "x".repeat(257),
    })).toEqual({ chatId: "15551234567@c.us", name: "15551234567@c.us", aliases: [] });
  });

  it("reads only identity and the approved label fields", () => {
    const chat = {
      id: "15551234567@c.us",
      name: "Alice",
      get messages(): never { throw new Error("message records must remain opaque"); },
      get preview(): never { throw new Error("previews must remain opaque"); },
    };
    expect(projectChatMetadata("15551234567@c.us", chat)).toEqual({
      chatId: "15551234567@c.us", name: "Alice", aliases: [],
    });
  });

  it("deduplicates aliases and caps the approved label list", () => {
    expect(projectChatMetadata("15551234567@c.us", {
      id: "15551234567@c.us", formattedTitle: "Primary", name: "Second",
    }, {
      id: "15551234567@c.us", name: "Second", shortName: "Third", pushname: "Fourth",
      // Extra fields are intentionally not part of the label whitelist.
      alias: "Fifth", displayName: "Sixth", title: "Seventh", nickname: "Eighth",
    })).toEqual({
      chatId: "15551234567@c.us", name: "Primary", aliases: ["Second", "Third", "Fourth"],
    });
  });
});
