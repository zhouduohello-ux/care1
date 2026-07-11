import type { FastifyInstance, FastifyRequest } from "fastify";
import type { InboundMessage, OutboundMessage, Platform } from "@carememory/im-core";
import { DefaultPlatformRegistry } from "@carememory/im-core";


import { createWhatsAppAdapter } from "@carememory/im-whatsapp";
import { handleInbound } from "@carememory/engine";
import { createExportTokenFactory } from "../lib/export-token.js";
import { loadLLMConfig } from "@carememory/engine";
import { dispatchOutboundMessages } from "../lib/dispatch-outbound.js";
import { whatsappTemplateResolver } from "../lib/template-resolver.js";

export default async function webhookRoutes(fastify: FastifyInstance) {
  const adapter = createWhatsAppAdapter();
  const registry = new DefaultPlatformRegistry();
  registry.register(adapter);

  const whatsAppApiConfig =
    process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID
      ? {
          accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
          phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
          businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
        }
      : null;

  // Meta webhook verification challenge
  fastify.get("/webhooks/:platform", async (request: FastifyRequest<{ Params: { platform: string }; Querystring: Record<string, string> }>, reply) => {
    const platform = request.params.platform as Platform;
    const adapter = registry.getAdapter(platform);
    if (!adapter || !adapter.getVerifyChallenge) {
      return reply.code(404).send({ error: "Platform not supported" });
    }
    const challenge = adapter.getVerifyChallenge(request.query);
    if (!challenge) {
      return reply.code(403).send({ error: "Verification failed" });
    }
    return reply.send(challenge);
  });

  // Inbound messages
  fastify.post("/webhooks/:platform", async (request: FastifyRequest<{ Params: { platform: string } }>, reply) => {
    const platform = request.params.platform as Platform;
    const adapter = registry.getAdapter(platform);
    if (!adapter) {
      return reply.code(404).send({ error: "Platform not supported" });
    }

    // Verify WhatsApp webhook signature when secret is configured
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (adapter.verifySignature && secret) {
      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      if (!signature || !adapter.verifySignature(request.rawBody ?? "", signature, secret)) {
        return reply.code(403).send({ error: "Invalid webhook signature" });
      }
    }

    const parsed = adapter.parseWebhook(request.body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];

    const responses: OutboundMessage[] = [];
    for (const message of messages) {
      if (!message.userId) {
        message.userId = message.channelId;
      }

      // Idempotency: ignore duplicate platform deliveries (e.g. webhook retries after a crash).
      const existing = await fastify.prisma.event.findFirst({
        where: { platformMessageId: message.messageId },
      });
      if (existing) {
        continue;
      }

      const outbound = await handleInbound(
        {
          prisma: fastify.prisma,
          now: fastify.clock.now(),
          quotaStore: fastify.quotaStore,
          createExportToken: createExportTokenFactory(fastify),
          webBaseUrl: process.env.API_BASE_URL ?? "http://localhost:3055",
          llmConfig: loadLLMConfig(),
          templateResolver: whatsappTemplateResolver,
        },
        message
      );
      responses.push(...outbound);
    }

    // Extend the user's WhatsApp session window for outbound template decisions
    for (const message of messages) {
      const userId = message.userId ?? message.channelId;
      const user = await fastify.prisma.user.findUnique({ where: { phoneNumber: userId } });
      if (user) {
        const windowExpires = new Date(fastify.clock.now().getTime() + 24 * 60 * 60 * 1000);
        await fastify.prisma.user.update({
          where: { id: user.id },
          data: { lastInboundAt: fastify.clock.now(), sessionWindowExpiresAt: windowExpires },
        });
      }
    }

    // In a real deployment, send outbound via adapter to platform API.
    // For local testing we return them in the response.
    if (platform === "whatsapp" && whatsAppApiConfig && responses.length > 0) {
      const { results } = await dispatchOutboundMessages(fastify.prisma, responses, fastify.clock.now());
      return reply.send({ received: messages.length, outbound: responses, sent: results });
    }

    return reply.send({ received: messages.length, outbound: responses });
  });
}
