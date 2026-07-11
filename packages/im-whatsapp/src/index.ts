import crypto from "node:crypto";
import {
  type IMAdapter,
  type InboundMessage,
  type OutboundMessage,
  type Platform,
  type PlatformCapability,
  DEFAULT_PLATFORM_CAPABILITIES,
} from "@carememory/im-core";
import { WHATSAPP_TEMPLATES } from "./templates.js";
import { WhatsAppSender } from "./sender.js";

export { WhatsAppSender };
export type { WhatsAppApiConfig, SendResult } from "./sender.js";
export * from "./templates.js";

export class WhatsAppAdapter implements IMAdapter {
  readonly platform: Platform = "whatsapp";
  readonly capability: PlatformCapability = DEFAULT_PLATFORM_CAPABILITIES.whatsapp;

  parseWebhook(payload: unknown): InboundMessage | InboundMessage[] {
    const body = payload as Record<string, unknown>;
    const entries = (body.entry ?? []) as Array<Record<string, unknown>>;
    const messages: InboundMessage[] = [];

    for (const entry of entries) {
      const changes = (entry.changes ?? []) as Array<Record<string, unknown>>;
      for (const change of changes) {
        const value = (change.value ?? {}) as Record<string, unknown>;
        const contacts = (value.contacts ?? []) as Array<Record<string, unknown>>;
        const waMessages = (value.messages ?? []) as Array<Record<string, unknown>>;

        for (const msg of waMessages) {
          const from = String(msg.from ?? "");
          const messageId = String(msg.id ?? "");
          const timestamp = new Date(Number(msg.timestamp ?? Date.now()) * 1000);
          const contact = contacts.find((c) => c.wa_id === from) ?? {};

          const inbound: InboundMessage = {
            platform: "whatsapp",
            channelId: from,
            messageId,
            timestamp,
            content: {
              type: "text",
              text: "",
              rawPayload: msg,
            },
          };

          if (msg.type === "text" && msg.text) {
            inbound.content.type = "text";
            inbound.content.text = String((msg.text as Record<string, unknown>).body ?? "");
          } else if (msg.type === "interactive" && msg.interactive) {
            const interactive = msg.interactive as Record<string, unknown>;
            if (interactive.type === "button_reply" && interactive.button_reply) {
              inbound.content.type = "button_reply";
              inbound.content.buttonId = String((interactive.button_reply as Record<string, unknown>).id ?? "");
              inbound.content.text = String((interactive.button_reply as Record<string, unknown>).title ?? "");
            } else if (interactive.type === "list_reply" && interactive.list_reply) {
              inbound.content.type = "list_reply";
              inbound.content.listId = String((interactive.list_reply as Record<string, unknown>).id ?? "");
              inbound.content.text = String((interactive.list_reply as Record<string, unknown>).title ?? "");
            }
          }

          messages.push(inbound);
        }
      }
    }

    return messages;
  }

  buildPayload(message: OutboundMessage): unknown {
    if (message.content.type === "template") {
      const templateKey = message.content.templateKey ?? "plain_text";
      const template = WHATSAPP_TEMPLATES[templateKey] ?? WHATSAPP_TEMPLATES["plain_text"];
      return {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: message.userId,
        type: "template",
        template: {
          name: template.name,
          language: { code: "en_GB" },
          components: this.buildTemplateComponents(message.content.templateVariables),
        },
      };
    }

    if (message.content.type === "buttons") {
      return {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: message.userId,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: message.content.text },
          action: {
            buttons: (message.content.buttons ?? []).map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      };
    }

    if (message.content.type === "list") {
      return {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: message.userId,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: message.content.text },
          action: {
            button: "Choose",
            sections: [
              {
                title: "Options",
                rows: (message.content.list ?? []).map((item) => ({
                  id: item.id,
                  title: item.title,
                  description: item.description,
                })),
              },
            ],
          },
        },
      };
    }

    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: message.userId,
      type: "text",
      text: { body: message.content.text },
    };
  }

  private buildTemplateComponents(variables?: Record<string, string>): unknown[] {
    if (!variables) return [];
    return [
      {
        type: "body",
        parameters: Object.entries(variables).map(([_, value]) => ({
          type: "text",
          text: value,
        })),
      },
    ];
  }

  verifySignature(payload: string | Buffer, signature: string, secret: string): boolean {
    // Meta webhook signature format: sha256=<hex>
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  }

  getVerifyChallenge(query: Record<string, string>): string | null {
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];
    if (mode === "subscribe" && token && challenge) {
      return challenge;
    }
    return null;
  }
}

export function createWhatsAppAdapter(): WhatsAppAdapter {
  return new WhatsAppAdapter();
}

export function createWhatsAppSender(adapter?: WhatsAppAdapter): WhatsAppSender {
  return new WhatsAppSender(adapter ?? createWhatsAppAdapter());
}
