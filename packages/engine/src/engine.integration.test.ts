/**
 * Engine 主流程集成测试
 * 测试范围：processInbound 对 topic-shift → defer → re-raise 的完整编排
 * 依赖：本地 PostgreSQL (docker-compose up)
 * 运行：DATABASE_URL=... vitest run src/engine.integration.test.ts --reporter=verbose
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@carememory/db";
import type { Cycle, User } from "@carememory/db";
import type { InboundMessage } from "@carememory/im-core";
import { processInbound, handleCheckInTrigger } from "./engine.js";
import { loadLLMConfig } from "./llm.js";
import { deleteUserData } from "./memory.js";

const prisma = new PrismaClient();

function makeContext(now: Date) {
  // Ensure no LLM keys leak in; rule-based path must be deterministic.
  delete process.env.LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_CHAT_API_KEY;
  delete process.env.LLM_REASON_API_KEY;
  return {
    prisma,
    now,
    llmConfig: loadLLMConfig(),
  };
}

function textMessage(phone: string, text: string, messageId: string): InboundMessage {
  return {
    platform: "test",
    messageId,
    userId: phone,
    channelId: phone,
    timestamp: new Date(),
    content: { type: "text", text, rawPayload: {} },
  };
}

function buttonMessage(phone: string, buttonId: string, text: string, messageId: string): InboundMessage {
  return {
    platform: "test",
    messageId,
    userId: phone,
    channelId: phone,
    timestamp: new Date(),
    content: { type: "button_reply", buttonId, text, rawPayload: {} },
  };
}

const describeTests = !process.env.DATABASE_URL ? describe.skip : describe;

describeTests("Engine 主流程集成测试", () => {
  const phone = `int_test_${Date.now()}`;
  let user: User;
  let cycle: Cycle;
  const now = new Date();

  beforeAll(async () => {
    user = await prisma.user.create({
      data: {
        phoneNumber: phone,
        timezone: "Europe/London",
        locale: "en-GB",
        sessionWindowExpiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    cycle = await prisma.cycle.create({
      data: {
        userId: user.id,
        disease: "asthma",
        status: "ACTIVE",
        startedAt: now,
        nextCheckinAt: now,
      },
    });
  });

  afterAll(async () => {
    await deleteUserData(prisma, user.id);
    await prisma.$disconnect();
  });

  it("topic-shift 答案被延迟并在会话结束前重新提出", async () => {
    const context = makeContext(now);

    // 1. 触发 check-in，系统应提出第一个问题（nighttime_symptoms）
    const startMessages = await handleCheckInTrigger(context, cycle.id);
    expect(startMessages.length).toBeGreaterThan(0);

    let checkIn = await prisma.checkIn.findFirstOrThrow({
      where: { cycleId: cycle.id },
    });
    expect(checkIn.status).toBe("SENT");
    const pending = checkIn.pendingQuestion as { topic?: string } | null;
    expect(pending?.topic).toBe("nighttime_symptoms");

    // 2. 用户没有回答 nighttime，而是提供了 reliever 使用信息 → topic shift
    const { messages: shiftMessages } = await processInbound(
      context,
      textMessage(phone, "I used my reliever twice today", "int_shift_1")
    );
    expect(shiftMessages.length).toBeGreaterThan(0);

    checkIn = await prisma.checkIn.findFirstOrThrow({
      where: { cycleId: cycle.id },
    });
    const deferred = (checkIn.deferredQuestions ?? []) as Array<{ topic?: string }>;
    expect(deferred.some((d) => d.topic === "nighttime_symptoms")).toBe(true);

    // 3. 回答 activity 问题，耗尽非延迟问题，触发 deferred re-raise
    const { messages: activityMessages } = await processInbound(
      context,
      buttonMessage(phone, "activity_no", "No", "int_activity_1")
    );
    const combinedText = activityMessages.map((m) => m.content.text).join("\n");
    expect(combinedText).toMatch(/Before we move on|nighttime/i);

    checkIn = await prisma.checkIn.findFirstOrThrow({
      where: { cycleId: cycle.id },
    });
    const reRaisedPending = checkIn.pendingQuestion as { topic?: string } | null;
    expect(reRaisedPending?.topic).toBe("nighttime_symptoms");

    // 4. 回答被重新提出的 nighttime 问题，结束会话
    const { messages: finalMessages } = await processInbound(
      context,
      buttonMessage(phone, "night_none", "None", "int_night_1")
    );
    expect(finalMessages.length).toBeGreaterThan(0);

    checkIn = await prisma.checkIn.findFirstOrThrow({
      where: { cycleId: cycle.id },
    });
    expect(["COMPLETED", "EXCEPTION"]).toContain(checkIn.status);

    // 应生成 Disease Card
    const diseaseCard = await prisma.diseaseCard.findFirst({
      where: { cycleId: cycle.id },
    });
    expect(diseaseCard).not.toBeNull();
  });
});
