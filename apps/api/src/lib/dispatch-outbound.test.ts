import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchOutboundMessages } from "./dispatch-outbound.js";
import type { OutboundMessage } from "@carememory/im-core";
import type { PrismaClient } from "@carememory/db";

vi.mock("./outbound-sender.js", () => ({
  sendOutboundMessages: vi.fn(async (messages: OutboundMessage[]) => ({
    sent: messages.length,
    failed: 0,
    results: messages.map(() => ({ success: true, messageId: "msg_123" })),
  })),
}));

function makeMessage(text: string): OutboundMessage {
  return {
    userId: "447123456789",
    conversationContext: { requiresSession: true, priority: "normal" },
    content: { type: "text", text },
  };
}

function makePrismaStub(initialEvents: Array<{ id: string; idempotencyKey: string | null; payload: unknown; type: string }> = []) {
  const events = new Map<string, { id: string; idempotencyKey: string | null; payload: unknown; type: string }>(
    initialEvents.map((e) => [e.idempotencyKey ?? `evt_${e.id}`, e])
  );
  return {
    user: {
      findUnique: vi.fn(async ({ where: { phoneNumber } }: { where: { phoneNumber: string } }) => {
        if (phoneNumber === "447123456789") {
          return { id: "user_1", phoneNumber, nickname: "Alex", sessionWindowExpiresAt: null };
        }
        return null;
      }),
    },
    event: {
      findUnique: vi.fn(async ({ where: { idempotencyKey } }: { where: { idempotencyKey: string } }) => {
        for (const e of events.values()) {
          if (e.idempotencyKey === idempotencyKey) return e;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const key = (data.idempotencyKey as string | undefined) ?? `evt_${events.size + 1}`;
        const created = { id: `evt_${events.size + 1}`, ...(data as Record<string, unknown>), idempotencyKey: key } as {
          id: string;
          idempotencyKey: string | null;
          payload: unknown;
          type: string;
        };
        events.set(key, created);
        return created;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { idempotencyKey: string }; data: Record<string, unknown> }) => {
        const e = events.get(where.idempotencyKey);
        if (e) {
          e.payload = (data.payload as unknown) ?? e.payload;
        }
        return { count: e ? 1 : 0 };
      }),
    },
    events,
  } as unknown as PrismaClient & { events: Map<string, { id: string; idempotencyKey: string | null; payload: unknown; type: string }> };
}

describe("dispatchOutboundMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a pending event and marks it sent after successful dispatch", async () => {
    const prisma = makePrismaStub();
    const now = new Date("2026-06-15T10:00:00.000Z");
    const message = makeMessage("Hello");
    message.idempotencyKey = "out:user:123:abc";

    const result = await dispatchOutboundMessages(prisma, [message], now);

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(prisma.events.size).toBe(1);
    const event = Array.from(prisma.events.values())[0];
    expect(event.idempotencyKey).toBe("out:user:123:abc");
    expect((event.payload as Record<string, unknown>)._deliveryStatus).toBe("sent");
  });

  it("skips already sent messages to avoid duplicates", async () => {
    const prisma = makePrismaStub([
      {
        id: "evt_1",
        idempotencyKey: "out:user:123:abc",
        type: "outbound_message",
        payload: { _deliveryStatus: "sent" },
      },
    ]);
    const now = new Date("2026-06-15T10:00:00.000Z");
    const message = makeMessage("Hello");
    message.idempotencyKey = "out:user:123:abc";

    const result = await dispatchOutboundMessages(prisma, [message], now);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("retries failed messages", async () => {
    const prisma = makePrismaStub([
      {
        id: "evt_1",
        idempotencyKey: "out:user:123:abc",
        type: "outbound_message",
        payload: { _deliveryStatus: "failed" },
      },
    ]);
    const now = new Date("2026-06-15T10:00:00.000Z");
    const message = makeMessage("Hello");
    message.idempotencyKey = "out:user:123:abc";

    const result = await dispatchOutboundMessages(prisma, [message], now);

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    const event = Array.from(prisma.events.values())[0];
    expect((event.payload as Record<string, unknown>)._deliveryStatus).toBe("sent");
  });
});
