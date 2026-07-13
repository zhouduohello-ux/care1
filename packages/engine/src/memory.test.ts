import { describe, it, expect, vi } from "vitest";
import { saveOutboundMessages, saveSafetyCheckEvent } from "./memory.js";
import type { OutboundMessage } from "@carememory/im-core";
import type { PrismaClient } from "@carememory/db";
import type { SafetyResult } from "./types.js";

function makeMessage(text: string): OutboundMessage {
  return {
    userId: "447123456789",
    conversationContext: { requiresSession: true, priority: "normal" },
    content: { type: "text", text },
  };
}

function makePrismaStub() {
  const created: Array<Record<string, unknown>> = [];
  return {
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `evt_${created.length}`, ...data };
      }),
    },
    $disconnect: vi.fn(),
    created,
  } as unknown as PrismaClient & { created: Array<Record<string, unknown>> };
}

describe("saveOutboundMessages", () => {
  it("persists messages with pending delivery status and idempotency keys", async () => {
    const prisma = makePrismaStub();
    const now = new Date("2026-06-15T10:00:00.000Z");
    const messages: OutboundMessage[] = [makeMessage("Hello"), makeMessage("How are you?")];

    const keys = await saveOutboundMessages(prisma, "user_1", messages, "cycle_1", now);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^out:447123456789:\d+:[^:]+:[a-f0-9]{16}$/);
    expect(keys[0]).not.toBe(keys[1]);
    expect(messages[0].idempotencyKey).toBe(keys[0]);
    expect(messages[1].idempotencyKey).toBe(keys[1]);
    expect(prisma.event.create).toHaveBeenCalledTimes(2);

    const payloads = prisma.created.map((d) => d.payload as Record<string, unknown>);
    expect(payloads[0]._deliveryStatus).toBe("pending");
    expect(payloads[1]._deliveryStatus).toBe("pending");
    expect(payloads[0].idempotencyKey).toBe(keys[0]);
    expect(payloads[1].idempotencyKey).toBe(keys[1]);
  });

  it("preserves an existing idempotency key", async () => {
    const prisma = makePrismaStub();
    const message = makeMessage("Hello");
    message.idempotencyKey = "existing-key-123";

    const keys = await saveOutboundMessages(prisma, "user_1", [message], "cycle_1");

    expect(keys).toEqual(["existing-key-123"]);
    expect(prisma.created[0].idempotencyKey).toBe("existing-key-123");
  });
});


describe("saveSafetyCheckEvent", () => {
  it("persists a safety_check event with summary and checked message texts", async () => {
    const prisma = makePrismaStub();
    const summary: SafetyResult = {
      approved: true,
      riskLevel: "low",
      requiredAddendums: ["This is based on patient-reported information only and is not medical advice."],
    };
    const messages = [makeMessage("How often did you use your inhaler?")];

    await saveSafetyCheckEvent(prisma, "user_1", summary, messages, "trace-123", "cycle_1", "checkin_1");

    expect(prisma.event.create).toHaveBeenCalledTimes(1);
    const data = prisma.created[0];
    expect(data.type).toBe("safety_check");
    expect(data.userId).toBe("user_1");
    expect(data.cycleId).toBe("cycle_1");
    expect(data.checkInId).toBe("checkin_1");
    expect(data.traceId).toBe("trace-123");
    expect((data.payload as Record<string, unknown>).approved).toBe(true);
    expect((data.payload as Record<string, unknown>).riskLevel).toBe("low");
    expect((data.payload as Record<string, unknown>).checkedMessageCount).toBe(1);
    expect((data.payload as Record<string, unknown>).checkedTexts).toEqual([messages[0].content.text]);
  });

  it("skips persistence when dbUserId is missing", async () => {
    const prisma = makePrismaStub();
    const summary: SafetyResult = { approved: true, riskLevel: "none", requiredAddendums: [] };

    await saveSafetyCheckEvent(prisma, "", summary, [makeMessage("Hello")]);

    expect(prisma.event.create).not.toHaveBeenCalled();
  });
});
