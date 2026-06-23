import type { OutboundMessage } from "@carememory/im-core";
import type { WhatsAppAdapter } from "./index.js";

export interface WhatsAppApiConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  baseUrl?: string;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export class WhatsAppSender {
  constructor(private readonly adapter: WhatsAppAdapter) {}

  async sendMessage(config: WhatsAppApiConfig, message: OutboundMessage): Promise<SendResult> {
    const baseUrl = config.baseUrl ?? "https://graph.facebook.com/v18.0";
    const url = `${baseUrl}/${config.phoneNumberId}/messages`;
    const payload = this.adapter.buildPayload(message);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `WhatsApp API ${response.status}: ${text}` };
      }

      const data = (await response.json()) as { messages?: Array<{ id: string }> };
      return { success: true, messageId: data.messages?.[0]?.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendMessages(config: WhatsAppApiConfig, messages: OutboundMessage[]): Promise<SendResult[]> {
    const results: SendResult[] = [];
    for (const message of messages) {
      results.push(await this.sendMessage(config, message));
    }
    return results;
  }
}
