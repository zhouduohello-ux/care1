import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWhatsAppSender } from "./index.js";
import type { OutboundMessage } from "@carememory/im-core";

describe("WhatsAppSender", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [{ id: "sent_msg_1" }] }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const message: OutboundMessage = {
    userId: "447123456789",
    conversationContext: { requiresSession: true, priority: "normal" },
    content: { type: "text", text: "Hello" },
  };

  it("sends a text message via the WhatsApp API", async () => {
    const sender = createWhatsAppSender();
    const result = await sender.sendMessage(
      { accessToken: "token", phoneNumberId: "123456" },
      message
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("sent_msg_1");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v18.0/123456/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });
  });

  it("returns error on API failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        text: async () => "Invalid token",
      })
    );

    const sender = createWhatsAppSender();
    const result = await sender.sendMessage(
      { accessToken: "bad", phoneNumberId: "123456" },
      message
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid token");
  });

  it("batches multiple messages", async () => {
    const sender = createWhatsAppSender();
    const results = await sender.sendMessages(
      { accessToken: "token", phoneNumberId: "123456" },
      [message, { ...message, content: { type: "text", text: "Second" } }]
    );
    expect(results).toHaveLength(2);
    expect(results.every((r: { success: boolean }) => r.success)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
