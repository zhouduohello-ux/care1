import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import type { InboundMessage } from "@carememory/im-core";
import { createWhatsAppAdapter } from "./index.js";

describe("WhatsAppAdapter", () => {
  it("verifies a valid HMAC-SHA256 signature", () => {
    const adapter = createWhatsAppAdapter();
    const secret = "test-secret";
    const payload = '{"object":"whatsapp"}';
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    expect(adapter.verifySignature?.(payload, `sha256=${expected}`, secret)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const adapter = createWhatsAppAdapter();
    const secret = "test-secret";
    const payload = '{"object":"whatsapp"}';
    expect(adapter.verifySignature?.(payload, "sha256=deadbeef", secret)).toBe(false);
  });

  it("rejects a signature without sha256= prefix", () => {
    const adapter = createWhatsAppAdapter();
    const secret = "test-secret";
    const payload = '{"object":"whatsapp"}';
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    expect(adapter.verifySignature?.(payload, expected, secret)).toBe(true);
  });

  it("parses a text webhook payload", () => {
    const adapter = createWhatsAppAdapter();
    const payload = {
      object: "whatsapp",
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "447123456789" }],
                messages: [
                  {
                    from: "447123456789",
                    id: "msg_1",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "hello" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const messages = adapter.parseWebhook(payload);
    expect(Array.isArray(messages)).toBe(true);
    const msg = (messages as InboundMessage[])[0];
    expect(msg.platform).toBe("whatsapp");
    expect(msg.channelId).toBe("447123456789");
    expect(msg.content.type).toBe("text");
    expect(msg.content.text).toBe("hello");
  });
});
