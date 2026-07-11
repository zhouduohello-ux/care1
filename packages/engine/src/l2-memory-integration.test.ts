/**
 * L2 Memory 层集成测试
 * 测试范围：Event / Observation / NarrativeSummary / DiseaseCard / Brief 表的读写
 * 依赖：本地 PostgreSQL (docker-compose up)
 * 运行：DATABASE_URL=... vitest run src/l2-memory-integration.test.ts --reporter=verbose
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
} from "./memory.js";
import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import type { PerceptionResult, PlannerOutput, Observation } from "./types.js";

const prisma = new PrismaClient();

// ── helpers ──

function inboundMsg(text: string, msgId?: string): InboundMessage {
  return {
    platform: "test",
    messageId: msgId ?? `wa_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    userId: "447000000001",
    channelId: "447000000001",
    timestamp: new Date(),
    content: { type: "text", text, rawPayload: {} },
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

const TEST_PHONE = "l2_test_" + Date.now();
let testUserId = "";
let testCycleId = "";

// ── Suite ──

const describeTests = !process.env.DATABASE_URL ? describe.skip : describe;

describeTests("L2 Memory 层集成测试", () => {
  beforeAll(async () => {
    // Create test user + cycle
    const user = await prisma.user.create({
      data: { phoneNumber: TEST_PHONE, timezone: "Europe/London", locale: "en-GB" },
    });
    testUserId = user.id;
    const cycle = await prisma.cycle.create({
      data: { userId: testUserId, disease: "asthma", status: "ACTIVE", startedAt: new Date() },
    });
    testCycleId = cycle.id;
  });

  afterAll(async () => {
    // Cleanup
    await deleteUserData(prisma, testUserId);
    await prisma.$disconnect();
  });

  // ── TC1: saveInboundMessage ──
  it("TC1: 入站消息持久化", async () => {
    const msgId = `wa_tc1_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const msg = inboundMsg("I've been wheezing today", msgId);
    const id1 = await saveInboundMessage(prisma, testUserId, msg, testCycleId);
    expect(id1).toBeTruthy();

    // Verify in DB
    const evt = await prisma.event.findUnique({ where: { id: id1 } });
    expect(evt).not.toBeNull();
    expect(evt!.type).toBe("inbound_message");
    expect(evt!.userId).toBe(testUserId);
    expect(evt!.cycleId).toBe(testCycleId);

    // platformMessageId is unique — sending same messageId again throws DB constraint error
    await expect(
      saveInboundMessage(prisma, testUserId, msg, testCycleId)
    ).rejects.toThrow();
  });

  // ── TC2: saveObservations ──
  it("TC2: Observation 持久化 — 字段正确存储", async () => {
    const inboundId = await saveInboundMessage(
      prisma, testUserId, inboundMsg("used inhaler twice"), testCycleId
    );

    const obs: Observation[] = [
      { category: "medication", concept: "reliever_use", value: "2 puffs", attributes: { dosage: "200mcg" }, confidence: 1, extractedBy: "rule" },
      { category: "symptom", concept: "wheezing", value: "moderate", attributes: {}, confidence: 0.9, extractedBy: "llm" },
    ];

    const ids = await saveObservations(prisma, testUserId, testCycleId, inboundId, obs);
    expect(ids).toHaveLength(2);

    for (const id of ids) {
      const record = await prisma.observation.findUnique({ where: { id } });
      expect(record).not.toBeNull();
      expect(record!.userId).toBe(testUserId);
      expect(record!.cycleId).toBe(testCycleId);
      expect(record!.eventId).toBe(inboundId);
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
      prisma, testUserId, inboundMsg("I was wrong, actually used 1 puff"), testCycleId
    );

    // Save "original" observation
    const obs1: Observation[] = [
      { category: "medication", concept: "reliever_use", value: "3 puffs", attributes: {}, confidence: 1, extractedBy: "llm" },
    ];
    const [origId] = await saveObservations(prisma, testUserId, testCycleId, inboundId, obs1);

    // supersedePreviousObservations finds the most recent non-superseded observation
    // with the same concept whose id != supersededById, and marks it superseded.
    // We use a placeholder "newId" to represent the upcoming correction.
    const newIdPlaceholder = `new_${origId}`;
    await supersedePreviousObservations(prisma, testCycleId, "reliever_use", newIdPlaceholder);

    // Now save the "corrected" observation (concept is the same, so the old one
    // already superseded)
    const obs2: Observation[] = [
      { category: "medication", concept: "reliever_use", value: "1 puff", attributes: {}, confidence: 1, extractedBy: "llm" },
    ];
    await saveObservations(prisma, testUserId, testCycleId, inboundId, obs2);

    // Verify old is superseded
    const orig = await prisma.observation.findUnique({ where: { id: origId } });
    expect(orig!.superseded).toBe(true);
    expect(orig!.supersededById).toBe(newIdPlaceholder);
  });

  // ── TC4: saveOutboundMessages ──
  it("TC4: 出站消息持久化 — idempotencyKey 生成 + timestamp 不重复", async () => {
    const inboundId = await saveInboundMessage(
      prisma, testUserId, inboundMsg("ok"), testCycleId
    );

    const messages: OutboundMessage[] = [
      outboundMsg("Thanks for the update"),
      outboundMsg("How are you feeling today?"),
    ];

    await saveOutboundMessages(prisma, testUserId, messages, testCycleId, new Date(), inboundId);

    // Verify both have idempotencyKeys
    expect(messages[0].idempotencyKey).toBeTruthy();
    expect(messages[1].idempotencyKey).toBeTruthy();
    expect(messages[0].idempotencyKey).not.toBe(messages[1].idempotencyKey);

    // Verify in DB
    const events = await prisma.event.findMany({
      where: { userId: testUserId, type: "outbound_message" },
      orderBy: { timestamp: "asc" },
    });
    const matchingEvents = events.filter(e => {
      const p = e.payload as Record<string, unknown> | null;
      return p && (p.idempotencyKey === messages[0].idempotencyKey || p.idempotencyKey === messages[1].idempotencyKey);
    });
    expect(matchingEvents.length).toBeGreaterThanOrEqual(2);

    // Check timestamps differ (saveOutboundMessages adds +i ms to each)
    const timestamps = matchingEvents.map(e => e.timestamp.getTime());
    expect(new Set(timestamps).size).toBe(timestamps.length);
  });

  // ── TC5: getRecentObservations ──
  it("TC5: 查询近期 observations — 过滤 superseded + 按时间倒序", async () => {
    const recent = await getRecentObservations(prisma, testUserId, testCycleId);
    expect(Array.isArray(recent)).toBe(true);

    // getRecentObservations returns the Observation interface type (no timestamp/superseded).
    // Verify filtering via raw Prisma: all returned concept+cycle combinations
    // should map to non-superseded rows.
    const dbAll = await prisma.observation.findMany({
      where: { userId: testUserId, cycleId: testCycleId },
      orderBy: { timestamp: "desc" },
      take: 20,
    });
    const nonSuperseded = dbAll.filter(o => !o.superseded);
    // The count of non-superseded records should match or exceed the recent count
    // (getRecentObservations filters out superseded=true)
    expect(nonSuperseded.length).toBeGreaterThanOrEqual(recent.length);

    // All returned observations should correspond to non-superseded DB rows
    const supersededConcepts = new Set(
      dbAll.filter(o => o.superseded).map(o => `${o.concept}::${o.value}`)
    );
    for (const r of recent) {
      // No observation with superseded=true should have the same concept+value
      expect(supersededConcepts.has(`${r.concept}::${r.value}`)).toBe(false);
    }
  });

  // ── TC6: saveLlmCallEvent ──
  it("TC6: LLM 调用审计 — llmModel + tokenUsage 正确存储", async () => {
    await saveLlmCallEvent(
      prisma,
      testUserId,
      testCycleId,
      "gpt-4o-mini",
      { messages: [{ role: "user", content: "test" }] },
      '{"intent":"answer"}',
      { promptTokens: 120, completionTokens: 30, totalTokens: 150 }
    );

    const evt = await prisma.event.findFirst({
      where: { userId: testUserId, type: "llm_call", llmModel: "gpt-4o-mini" },
      orderBy: { timestamp: "desc" },
    });
    expect(evt).not.toBeNull();
    expect(evt!.llmModel).toBe("gpt-4o-mini");

    const usage = evt!.tokenUsage as Record<string, number> | null;
    expect(usage).not.toBeNull();
    expect(usage!.promptTokens).toBe(120);
    expect(usage!.totalTokens).toBe(150);
  });

  // ── TC7: savePerceptionEvent ──
  it("TC7: 感知结果事件持久化", async () => {
    const perception = fakePerception([
      { category: "symptom", concept: "cough", value: "mild" },
    ]);
    await savePerceptionEvent(prisma, testUserId, testCycleId, perception, perception.traceId);

    const evt = await prisma.event.findFirst({
      where: { userId: testUserId, type: "observation_extracted", traceId: perception.traceId },
    });
    expect(evt).not.toBeNull();
  });

  // ── TC8: savePlannerEvent ──
  it("TC8: 规划结果事件持久化", async () => {
    const traceId = `trace_p_${Date.now()}`;
    const plannerOutput: PlannerOutput = {
      reasoning: "Patient reports mild symptoms, continue standard check-in",
      sessionObjective: "Assess asthma control level",
      nextAction: { type: "ask", topic: "symptoms", purpose: "check severity", budgetCost: 1 },
      safetyFlag: "none",
      updatePatientState: {},
    };

    await savePlannerEvent(prisma, testUserId, testCycleId, plannerOutput, traceId);

    const evt = await prisma.event.findFirst({
      where: { userId: testUserId, type: "state_updated", traceId },
    });
    expect(evt).not.toBeNull();
  });

  // ── TC9: exportUserData ──
  it("TC9: GDPR 导出 — 包含 observations 和 events，默认排除 LLM 审计", async () => {
    const data = await exportUserData(prisma, testUserId);
    expect(data).not.toBeNull();
    expect(data!.formatVersion).toBe("carememory-gdpr-export-v1");
    expect(data!.profile).toBeDefined();
    expect(data!.profile.id).toBe(testUserId);
    expect(Array.isArray(data!.cycles)).toBe(true);
    expect(Array.isArray(data!.observations)).toBe(true);

    // Default: llm_call events are excluded
    const topLevelEvents = data!.events ?? [];
    const llmCalls = topLevelEvents.filter(e => e.type === "llm_call");
    expect(llmCalls.length).toBe(0);

    // Events inside cycles should also exclude llm_call
    for (const cycle of data!.cycles) {
      const cycleEvents = cycle.events ?? [];
      expect(cycleEvents.filter(e => e.type === "llm_call").length).toBe(0);
    }
  });

  // ── TC10: exportUserData with audit log ──
  it("TC10: GDPR 导出 — includeAudit=true 时包含 LLM 审计", async () => {
    const data = await exportUserData(prisma, testUserId, { includeAudit: true });
    expect(data).not.toBeNull();

    const topLevelEvents = data!.events ?? [];
    const llmCalls = topLevelEvents.filter(e => e.type === "llm_call");
    expect(llmCalls.length).toBeGreaterThan(0);
  });
});
