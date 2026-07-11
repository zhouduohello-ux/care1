import crypto from "node:crypto";
import { Prisma, type PrismaClient } from "@carememory/db";
import type { OutboundMessage } from "@carememory/im-core";
import { selectTemplate, buildTemplateVariables } from "@carememory/im-whatsapp";
import { sendOutboundMessages } from "./outbound-sender.js";

function makeIdempotencyKey(message: OutboundMessage, now: Date): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${message.userId}:${now.toISOString()}:${message.content.text}`)
    .digest("hex")
    .slice(0, 16);
  return `out:${message.userId}:${now.getTime()}:${hash}`;
}

function getDeliveryStatus(payload: Prisma.JsonValue | null): "pending" | "sent" | "failed" | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const status = (payload as Record<string, unknown>)._deliveryStatus;
  if (status === "pending" || status === "sent" || status === "failed") return status;
  return undefined;
}

export async function dispatchOutboundMessages(
  prisma: PrismaClient,
  messages: OutboundMessage[],
  now: Date
): Promise<{ sent: number; failed: number; results: unknown[] }> {
  const toSend: OutboundMessage[] = [];
  const keys: string[] = [];
  const userCache = new Map<string, Awaited<ReturnType<typeof prisma.user.findUnique>>>();

  for (const message of messages) {
    let user = userCache.get(message.userId);
    if (!user) {
      user = await prisma.user.findUnique({ where: { phoneNumber: message.userId } });
      userCache.set(message.userId, user);
    }

    const windowOpen =
      user && (user.sessionWindowExpiresAt ? user.sessionWindowExpiresAt.getTime() > now.getTime() : false);

    let outbound: OutboundMessage = message;

    if (!windowOpen && message.content.type !== "template") {
      const templateKey = selectTemplate(message);
      const templateVariables = buildTemplateVariables(templateKey, message, {
        nickname: user?.nickname,
        firstName: user?.nickname,
      });
      outbound = {
        ...message,
        content: {
          type: "template",
          text: message.content.text,
          templateKey,
          templateVariables,
        },
      };
    }

    const idempotencyKey = message.idempotencyKey ?? makeIdempotencyKey(outbound, now);

    // The engine should already have persisted a pending outbound_message event.
    // If it hasn't (e.g. welcome messages before onboarding), create one here when possible.
    const existing = await prisma.event.findUnique({ where: { idempotencyKey } });
    if (existing?.type === "outbound_message") {
      const status = getDeliveryStatus(existing.payload);
      if (status === "sent") {
        // Already sent successfully; skip duplicate dispatch.
        continue;
      }
      // pending or failed: we will (re)try sending below.
    } else if (user) {
      await prisma.event.create({
        data: {
          userId: user.id,
          type: "outbound_message" as const,
          payload: { ...outbound, _deliveryStatus: "pending" } as unknown as Prisma.InputJsonValue,
          idempotencyKey,
          timestamp: now,
        },
      });
    }

    toSend.push(outbound);
    keys.push(idempotencyKey);
  }

  const result = await sendOutboundMessages(toSend);

  // Mark delivery status per message so failed sends can be retried and successful ones are deduplicated.
  for (let i = 0; i < keys.length; i++) {
    const deliveryStatus = result.results[i] && (result.results[i] as { success?: boolean }).success ? "sent" : "failed";
    const message = toSend[i];
    await prisma.event.updateMany({
      where: { idempotencyKey: keys[i] },
      data: {
        payload: { ...(message as unknown as object), _deliveryStatus: deliveryStatus },
      },
    });
  }

  return result;
}
