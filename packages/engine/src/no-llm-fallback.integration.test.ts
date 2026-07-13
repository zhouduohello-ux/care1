/**
 * 无 LLM 降级路径集成测试
 * 验证：当未配置任何 LLM key 时，患者仍可用自由文本回答 check-in，
 * 感知层规则提取 observation，规划层按问题库顺序推进，最终完成 check-in 并生成 Disease Card。
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
  delete process.env.LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_CHAT_API_KEY;
  delete process.env.LLM_REASON_API_KEY;
  return { prisma, now, llmConfig: loadLLMConfig() };
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

describeTests("无 LLM 降级路径集成测试", () => {
  const phone = `no_llm_${Date.now()}`;
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

  it("未配置 LLM 时自由文本可规则匹配并完成 check-in", async () => {
    const context = makeContext(now);
    const startMessages = await handleCheckInTrigger(context, cycle.id);
    expect(startMessages.length).toBeGreaterThan(0);

    let checkIn = await prisma.checkIn.findFirstOrThrow({ where: { cycleId: cycle.id } });
    expect((checkIn.pendingQuestion as { topic?: string } | null)?.topic).toBe("nighttime_symptoms");

    // 自由文本回答 nighttime_symptoms（规则提取 "nighttime symptom"）
    const { messages: m1 } = await processInbound(
      context,
      textMessage(phone, "I had nighttime symptom", "no_llm_1")
    );
    expect(m1.length).toBeGreaterThan(0);

    checkIn = await prisma.checkIn.findFirstOrThrow({ where: { cycleId: cycle.id } });
    expect((checkIn.pendingQuestion as { topic?: string } | null)?.topic).toBe("reliever_use");

    // 自由文本回答 reliever_use
    const { messages: m2 } = await processInbound(
      context,
      textMessage(phone, "I used my reliever once", "no_llm_2")
    );
    expect(m2.length).toBeGreaterThan(0);

    checkIn = await prisma.checkIn.findFirstOrThrow({ where: { cycleId: cycle.id } });
    expect((checkIn.pendingQuestion as { topic?: string } | null)?.topic).toBe("activity_limitation");

    // 按钮回答 activity_limitation（规则层暂无活动限制关键词）
    const { messages: m3 } = await processInbound(
      context,
      buttonMessage(phone, "activity_no", "No", "no_llm_3")
    );
    expect(m3.length).toBeGreaterThan(0);

    checkIn = await prisma.checkIn.findFirstOrThrow({ where: { cycleId: cycle.id } });
    expect(checkIn.status).toMatch(/COMPLETED|EXCEPTION/);

    const card = await prisma.diseaseCard.findFirst({ where: { cycleId: cycle.id } });
    expect(card).not.toBeNull();

    // 验证 observation 来自规则提取
    const observations = await prisma.observation.findMany({
      where: { cycleId: cycle.id, superseded: false },
    });
    const concepts = observations.map((o) => o.concept);
    expect(concepts).toContain("nighttime_symptoms");
    expect(concepts).toContain("reliever_use");
    expect(concepts).toContain("activity_limitation");
  });
});
