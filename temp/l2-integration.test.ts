/**
 * L2 Memory 层集成测试
 * 测试范围：Event / Observation / NarrativeSummary / DiseaseCard / Brief 表的读写
 * 依赖：本地 PostgreSQL (docker-compose up)
 * 运行：pnpm vitest run temp/l2-integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@carememory/db";
import {
  saveInboundMessage,
  saveOutboundMessages,
  saveObservations,
  savePerceptionEvent,
  savePlannerEvent,
  saveLlmCallEvent,
  getRecentObservations,
  supersedePreviousObservations,
  deleteUserData,
  exportUserData,
} from "../packages/engine/src/memory.js";
import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import type { PerceptionResult, PlannerOutput, Observation } from "../packages/engine/src/types.js";

const prisma = new PrismaClient();

// ── helpers ──

function inboundMsg(text: string, msgId?: string): InboundMessage {
  return {
    messageId: msgId ?? `wa_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    userId: "447000000001",
    channelId: "447000000001",
    timestamp: new Date(),
    content: { type: "text", text },
  };
}

function outboundMsg(text: string): OutboundMessage {
  return {
    userId: "447000000001",
    conversationContext: { requiresSession: true, priority: "normal" },
    content: { type: "text" as const, text },
  };
}

function fakePerception(obs: Array<Partial<Observation>> = []): PerceptionResult {
  return {
    traceId: `trace_${Date.now()}`,
    intent: { primary: "answer", confidence: 0.9 },
    extractedObservations: obs.map((o, i) => ({
      category: (o.category ?? "symptom") as Observation["category"],
      concept: o.concept ?? `test_concept_${i}`,
      value: o.value ?? `test_value_${i}`,
      attributes: o.attributes ?? {},
      confidence: o.confidence ?? 1,
      extractedBy: o.extractedBy ?? "rule",
      id: o.id,
    })),
    anomalies: [],
    safetyFlags: [],
    rawText: "test input",
    messageId: `wa_test_${Date.now()}`,
    timestamp: new Date(),
  };
}

const TEST_USER_ID = "l2_test_user_" + Date.now();
let testCycleId = "";

// ── Suite ──

describe("L2 Memory 层集成测试", () => {
  beforeAll(async () => {
    // Create test user + cycle
    await prisma.user.create({
      data: { phoneNumber: TEST_USER_ID, timezone: "Europe/London", locale: "en-GB" },
    });
    const cycle = await prisma.cycle.create({
      data: { userId: TEST_USER_ID, disease: "asthma", status: "ACTIVE", startedAt: new Date() },
    });
    testCycleId = cycle.id;
  });

  afterAll(async () => {
    // Cleanup
    await deleteUserData(prisma, TEST_USER_ID);
    await prisma.$disconnect();
  });

  // ── TC1: saveInboundMessage ──
  it("TC1: 入站消息持久化 + platformMessageId 去重", async () => {
    const msg = inboundMsg("I've been wheezing today");
    const id1 = await saveInboundMessage(prisma, TEST_USER_ID, msg, testCycleId);
    expect(id1).toBeTruthy();

    // Verify in DB
    const evt = await prisma.event.findUnique({ where: { id: id1 } });
    expect(evt).not.toBeNull();
    expect(evt!.type).toBe("inbound_message");
    expect(evt!.userId).toBe(TEST_USER_ID);
    expect(evt!.cycleId).toBe(testCycleId);

    // Send same message again → should return same ID (去重)
    const id2 = await saveInboundMessage(prisma, TEST_USER_ID, msg, testCycleId);
    expect(id2).toBe(id1);
  });

  // ── TC2: saveObservations ──
  it("TC2: Observation 持久化 — 字段正确存储", async () => {
    const inboundId = await saveInboundMessage(
      prisma, TEST_USER_ID, inboundMsg("used inhaler twice"), testCycleId
    );

    const obs: Observation[] = [
      { category: "medication", concept: "reliever_use", value: "2 puffs", attributes: { dosage: "200mcg" }, confidence: 1, extractedBy: "rule" },
      { category: "symptom", concept: "wheezing", value: "moderate", attributes: {}, confidence: 0.9, extractedBy: "llm" },
    ];

    const ids = await saveObservations(prisma, TEST_USER_ID, testCycleId, inboundId, obs);
    expect(ids).toHaveLength(2);

    for (const id of ids) {
      const record = await prisma.observation.findUnique({ where: { id } });
      expect(record).not.toBeNull();
      expect(record!.userId).toBe(TEST_USER_ID);
      expect(record!.cycleId).toBe(testCycleId);
      expect(record!.inboundEventId).toBe(inboundId);
    }

    // Verify specific fields
    const med = await prisma.observation.findUnique({ where: { id: ids[0] } });
    expect(med!.category).toBe("medication");
    expect(med!.concept).toBe("reliever_use");
    expect(med!.value).toBe("2 puffs");
    expect(med!.superseded).toBe(false);
  });

  // ── TC3: supersedePreviousObservations ──
  it("TC3: 用户修正 — 旧 observation 标记 superseded=true", async () => {
    const inboundId = await saveInboundMessage(
      prisma, TEST_USER_ID, inboundMsg("I was wrong, actually used 1 puff"), testCycleId
    );

    // Save "original" observation
    const obs1: Observation[] = [
      { category: "medication", concept: "reliever_use", value: "3 puffs", attributes: {}, confidence: 1, extractedBy: "llm" },
    ];
    const [origId] = await saveObservations(prisma, TEST_USER_ID, testCycleId, inboundId, obs1);

    // Now "correct" — save new observation + supersede old
    const obs2: Observation[] = [
      { category: "medication", concept: "reliever_use", value: "1 puff", attributes: {}, confidence: 1, extractedBy: "llm" },
    ];
    const [newId] = await saveObservations(prisma, TEST_USER_ID, testCycleId, inboundId, obs2);
    await supersedePreviousObservations(prisma, testCycleId, "reliever_use", newId);

    // Verify old is superseded, new is not
    const orig = await prisma.observation.findUnique({ where: { id: origId } });
    expect(orig!.superseded).toBe(true);
    expect(orig!.supersededBy).toBe(newId);

    const neu = await prisma.observation.findUnique({ where: { id: newId } });
    expect(neu!.superseded).toBe(false);
  });

  // ── TC4: saveOutboundMessages ──
  it("TC4: 出站消息持久化 — idempotencyKey 生成 + delivery status", async () => {
    const inboundId = await saveInboundMessage(
      prisma, TEST_USER_ID, inboundMsg("ok"), testCycleId
    );

    const messages: OutboundMessage[] = [
      outboundMsg("Thanks for the update"),
      outboundMsg("How are you feeling today?"),
    ];

    await saveOutboundMessages(prisma, TEST_USER_ID, messages, testCycleId, new Date(), inboundId);

    // Verify both have idempotencyKeys
    expect(messages[0].idempotencyKey).toBeTruthy();
    expect(messages[1].idempotencyKey).toBeTruthy();
    expect(messages[0].idempotencyKey).not.toBe(messages[1].idempotencyKey);

    // Verify in DB
    const events = await prisma.event.findMany({
      where: { userId: TEST_USER_ID, type: "outbound_message" },
      orderBy: { timestamp: "asc" },
    });
    const matchingEvents = events.filter(e => {
      const p = e.payload as Record<string, unknown> | null;
      return p && (p.idempotencyKey === messages[0].idempotencyKey || p.idempotencyKey === messages[1].idempotencyKey);
    });
    expect(matchingEvents.length).toBeGreaterThanOrEqual(2);

    // Check timestamps differ
    const timestamps = matchingEvents.map(e => e.timestamp.getTime());
    expect(new Set(timestamps).size).toBe(timestamps.length); // all unique
  });

  // ── TC5: getRecentObservations ──
  it("TC5: 查询近期 observations — 过滤 superseded + 按时间排序", async () => {
    const recent = await getRecentObservations(prisma, TEST_USER_ID, testCycleId);
    expect(Array.isArray(recent)).toBe(true);

    // Should not contain any superseded=true records
    const superseded = recent.filter(o => o.superseded);
    expect(superseded.length).toBe(0);

    // Should be ordered by timestamp ascending
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i].timestamp.getTime()).toBeGreaterThanOrEqual(recent[i - 1].timestamp.getTime());
    }
  });

  // ── TC6: saveLlmCallEvent ──
  it("TC6: LLM 调用审计 — model + token usage 正确存储", async () => {
    await saveLlmCallEvent(
      prisma,
      TEST_USER_ID,
      testCycleId,
      "gpt-4o-mini",
      { messages: [{ role: "user", content: "test" }] },
      '{"intent":"answer"}',
      { promptTokens: 120, completionTokens: 30, totalTokens: 150 }
    );

    const evt = await prisma.event.findFirst({
      where: { userId: TEST_USER_ID, type: "llm_call", model: "gpt-4o-mini" },
      orderBy: { timestamp: "desc" },
    });
    expect(evt).not.toBeNull();
    expect(evt!.model).toBe("gpt-4o-mini");

    const payload = evt!.payload as Record<string, unknown> | null;
    expect(payload).not.toBeNull();
    expect(payload!.promptTokens).toBe(120);
    expect(payload!.totalTokens).toBe(150);
  });

  // ── TC7: savePerceptionEvent ──
  it("TC7: 感知结果事件持久化", async () => {
    const perception = fakePerception([
      { category: "symptom", concept: "cough", value: "mild" },
    ]);
    await savePerceptionEvent(prisma, TEST_USER_ID, testCycleId, perception, perception.traceId);

    const evt = await prisma.event.findFirst({
      where: { userId: TEST_USER_ID, type: "observation_extracted", traceId: perception.traceId },
    });
    expect(evt).not.toBeNull();
  });

  // ── TC8: savePlannerEvent ──
  it("TC8: 规划结果事件持久化", async () => {
    const plannerOutput: PlannerOutput = {
      reasoning: "Patient reports mild symptoms, continue standard check-in",
      sessionObjective: "Assess asthma control level",
      nextAction: { type: "ask", topic: "symptoms", purpose: "check severity", budgetCost: 1 },
      safetyFlag: "none",
      updatePatientState: {},
    };

    await savePlannerEvent(prisma, TEST_USER_ID, testCycleId, plannerOutput, `trace_p_${Date.now()}`);

    const evt = await prisma.event.findFirst({
      where: { userId: TEST_USER_ID, type: "llm_call" },
      orderBy: { timestamp: "desc" },
    });
    expect(evt).not.toBeNull();
  });

  // ── TC9: exportUserData ──
  it("TC9: GDPR 导出 — 包含 observations 和 events", async () => {
    const data = await exportUserData(prisma, TEST_USER_ID);
    expect(data).toHaveProperty("version", "carememory-gdpr-export-v1");
    expect(data).toHaveProperty("user");
    expect(data).toHaveProperty("cycles");
    expect(data).toHaveProperty("observations");
    expect(Array.isArray(data.observations)).toBe(true);

    // Default: no llm_call audit log
    const events = (data as Record<string, unknown>).events as Array<Record<string, unknown>> | undefined;
    if (events) {
      const llmCalls = events.filter(e => e.type === "llm_call");
      expect(llmCalls.length).toBe(0);
    }
  });

  // ── TC10: exportUserData with audit log ──
  it("TC10: GDPR 导出 — includeAuditLog=true 时包含 LLM 审计", async () => {
    const data = await exportUserData(prisma, TEST_USER_ID, true);
    const events = (data as Record<string, unknown>).events as Array<Record<string, unknown>> | undefined;
    expect(events).toBeDefined();
    const llmCalls = events!.filter(e => e.type === "llm_call");
    expect(llmCalls.length).toBeGreaterThan(0);
  });
});
