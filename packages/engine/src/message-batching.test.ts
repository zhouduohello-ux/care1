import { describe, it, expect } from "vitest";
import type { OutboundMessage } from "@carememory/im-core";
import { combineAdjacentTextMessages } from "./message-batching.js";

function textMessage(text: string, overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    userId: "user-1",
    platform: "whatsapp",
    conversationContext: { requiresSession: true, priority: "normal" },
    content: { type: "text", text },
    ...overrides,
  } as OutboundMessage;
}

function buttonMessage(text: string): OutboundMessage {
  return {
    userId: "user-1",
    platform: "whatsapp",
    conversationContext: { requiresSession: true, priority: "normal" },
    content: {
      type: "buttons",
      text,
      buttons: [{ id: "yes", title: "Yes" }],
    },
  };
}

describe("combineAdjacentTextMessages", () => {
  it("returns an empty array when given no messages", () => {
    expect(combineAdjacentTextMessages([])).toEqual([]);
  });

  it("leaves a single text message unchanged", () => {
    const messages = [textMessage("Hello")];
    expect(combineAdjacentTextMessages(messages)).toEqual(messages);
  });

  it("combines adjacent text messages", () => {
    const messages = [textMessage("Hello"), textMessage("World")];
    const result = combineAdjacentTextMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content.text).toBe("Hello\n\nWorld");
    expect(result[0].content.type).toBe("text");
  });

  it("does not combine text with buttons", () => {
    const messages = [textMessage("Hello"), buttonMessage("Choose")];
    const result = combineAdjacentTextMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content.type).toBe("text");
    expect(result[1].content.type).toBe("buttons");
  });

  it("combines text across different priorities and keeps urgent", () => {
    const messages = [
      textMessage("Normal"),
      textMessage("Urgent", { conversationContext: { requiresSession: true, priority: "urgent" } }),
    ];
    const result = combineAdjacentTextMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content.text).toBe("Normal\n\nUrgent");
    expect(result[0].conversationContext.priority).toBe("urgent");
  });

  it("does not combine text across different users", () => {
    const messages = [textMessage("A"), textMessage("B", { userId: "user-2" })];
    const result = combineAdjacentTextMessages(messages);
    expect(result).toHaveLength(2);
  });

  it("respects maxBodyLength by splitting into multiple text messages", () => {
    const messages = [textMessage("Hello"), textMessage("World")];
    const result = combineAdjacentTextMessages(messages, { maxBodyLength: 8, separator: " " });
    // "Hello World" is 11 chars, so they cannot be merged.
    expect(result).toHaveLength(2);
    expect(result[0].content.text).toBe("Hello");
    expect(result[1].content.text).toBe("World");
  });

  it("combines multiple short texts that fit within maxBodyLength", () => {
    const messages = [textMessage("A"), textMessage("B"), textMessage("C")];
    const result = combineAdjacentTextMessages(messages, { maxBodyLength: 10 });
    expect(result).toHaveLength(1);
    expect(result[0].content.text).toBe("A\n\nB\n\nC");
  });

  it("preserves idempotency key of the first message in a batch", () => {
    const messages = [
      textMessage("First", { idempotencyKey: "key-1" }),
      textMessage("Second", { idempotencyKey: "key-2" }),
    ];
    const result = combineAdjacentTextMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].idempotencyKey).toBe("key-1");
  });

  it("uses custom separator", () => {
    const messages = [textMessage("A"), textMessage("B")];
    const result = combineAdjacentTextMessages(messages, { separator: " | " });
    expect(result[0].content.text).toBe("A | B");
  });

  it("keeps non-adjacent text messages separated by interactive content", () => {
    const messages = [textMessage("A"), buttonMessage("Pick"), textMessage("B")];
    const result = combineAdjacentTextMessages(messages);
    expect(result).toHaveLength(3);
    expect(result[0].content.text).toBe("A");
    expect(result[2].content.text).toBe("B");
  });
});
