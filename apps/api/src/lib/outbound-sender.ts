import { createWhatsAppAdapter, createWhatsAppSender } from "@carememory/im-whatsapp";
import type { OutboundMessage } from "@carememory/im-core";

const adapter = createWhatsAppAdapter();
const sender = createWhatsAppSender(adapter);

const whatsAppApiConfig =
  process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID
    ? {
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
      }
    : null;

export async function sendOutboundMessages(messages: OutboundMessage[]): Promise<{
  sent: number;
  failed: number;
  results: unknown[];
}> {
  if (!whatsAppApiConfig || messages.length === 0) {
    return { sent: 0, failed: 0, results: [] };
  }

  const results = await sender.sendMessages(whatsAppApiConfig, messages);
  const sent = results.filter((r) => "messageId" in (r as unknown as Record<string, unknown>)).length;
  return { sent, failed: results.length - sent, results };
}
