import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fastify from "fastify";
import adminRoutes from "./admin.js";
import type { PrismaClient } from "@carememory/db";

const TEST_ADMIN_KEY = "test-admin-key-123";

vi.mock("@carememory/engine", () => ({
  exportUserData: vi.fn(async (prisma: unknown, userId: string, options: { includeAudit?: boolean }) => {
    if (userId === "missing") return null;
    return {
      formatVersion: "carememory-gdpr-export-v1",
      exportedAt: new Date().toISOString(),
      userId,
      includeAudit: options.includeAudit,
    };
  }),
  deleteUserData: vi.fn(async () => {}),
  getBucket: vi.fn((_userId: string, experiment: string) => ({ variant: experiment === "checkin_frequency" ? "48h" : "v1" })),
}));

function makePrismaStub() {
  return {
    user: {
      count: vi.fn(async () => 10),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        if (id === "missing") return null;
        return { id, phoneNumber: `+44${id}` };
      }),
      findMany: vi.fn(async () => [{ id: "user_1" }, { id: "user_2" }]),
    },
    cycle: { count: vi.fn(async () => 5) },
    checkIn: {
      count: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        if (args?.where?.status === "SENT" && args?.where?.pendingQuestion) return 3;
        if (args?.where?.nudgeSentAt) return 1;
        return 20;
      }),
      aggregate: vi.fn(async () => ({ _avg: { repromptCount: 0.5 } })),
    },
    observation: {
      count: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        if (
          args?.where?.category === "subjective" &&
          (args?.where?.value as Record<string, unknown>)?.equals === "no_answer"
        ) {
          return 4;
        }
        return 100;
      }),
    },
    event: {
      count: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        if (args?.where?.type === "llm_call") return 7;
        if (args?.where?.type === "turn_reprompt") {
          const payload = args.where.payload as { path?: string[]; equals?: string } | undefined;
          if (payload?.path?.[0] === "action") {
            if (payload.equals === "clarification") return 3;
            if (payload.equals === "partial_answer_follow_up") return 2;
            if (payload.equals === "llm_rejected_low_confidence") return 1;
          }
          return 5;
        }
        if (args?.where?.type === "state_updated") return 2;
        if (args?.where?.type === "user_action") {
          const payload = args.where.payload as { path?: string[]; equals?: string } | undefined;
          if (payload?.path?.[0] === "action") {
            if (payload.equals === "skip_question") return 4;
            if (payload.equals === "go_back") return 2;
            if (payload.equals === "topic_shift") return 1;
            if (payload.equals === "topic_shift") return 3;
            if (payload.equals === "deferred_question_reraised") return 1;
          }
          return 6;
        }
        return 200;
      }),
      findMany: vi.fn(async (args?: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
        if (args?.where?.type === "llm_call") {
          return [
            { tokenUsage: { prompt: 100, completion: 50, total: 150 } },
            { tokenUsage: { prompt: 200, completion: 100, total: 300 } },
          ];
        }
        if (args?.where?.type === "inbound_message") {
          return [
            { payload: { turnManager: { matchConfidence: 0.95, matchMethod: "exact_option" } } },
            { payload: { turnManager: { matchConfidence: 0.6, matchMethod: "text" } } },
            { payload: { turnManager: { matchConfidence: 0.85, matchMethod: "synonym" } } },
            { payload: {} },
          ];
        }
        return [
          { payload: { _deliveryStatus: "failed", timestamp: new Date().toISOString() } },
          { payload: { _deliveryStatus: "sent" } },
        ];
      }),
    },
    diseaseCard: { count: vi.fn(async () => 3) },
    brief: { count: vi.fn(async () => 2) },
  } as unknown as PrismaClient;
}

function makeClock(now: Date) {
  return {
    now: () => new Date(now.getTime()),
    advance: vi.fn(),
    setTime: vi.fn(),
    resetUser: vi.fn(),
  };
}

async function buildApp(opts: { adminKey?: string; now?: Date } = {}) {
  process.env.ADMIN_API_KEY = opts.adminKey ?? TEST_ADMIN_KEY;
  const app = fastify({ logger: false });
  const prisma = makePrismaStub();
  const clock = makeClock(opts.now ?? new Date("2026-06-16T12:00:00.000Z"));
  app.decorate("prisma", prisma);
  app.decorate("clock", clock);
  await app.register(adminRoutes);
  return { app, prisma, clock };
}

describe("admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ADMIN_API_KEY;
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it("returns 503 when ADMIN_API_KEY is not configured", async () => {
    const { app } = await buildApp({ adminKey: "" });
    const response = await app.inject({ method: "GET", url: "/admin/metrics" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("Admin API is not configured");
  });

  it("returns 401 with wrong admin key", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/admin/metrics",
      headers: { "x-admin-api-key": "wrong-key" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns metrics with correct admin key", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/admin/metrics",
      headers: { "x-admin-api-key": TEST_ADMIN_KEY },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.counts).toMatchObject({
      users: 10,
      cycles: 5,
      checkIns: 20,
      observations: 100,
      events: 200,
      diseaseCards: 3,
      briefs: 2,
      llmCalls: 7,
    });
    expect(body.llmTokens).toMatchObject({ prompt: 300, completion: 150, total: 450 });
    expect(body.experimentAssignments).toHaveProperty("checkin_frequency");
    expect(body.experimentAssignments).toHaveProperty("conversation_style");
    expect(body.turnManager).toMatchObject({
      pendingQuestions: 3,
      reprompts24h: 5,
      avgReprompts: 0.5,
      noAnswers24h: 4,
      timeouts24h: 2,
      nudges24h: 1,
      clarifications24h: 3,
      partialAnswers24h: 2,
      llmRejectedLowConfidence24h: 1,
      skips24h: 4,
      goBacks24h: 2,
      topicShifts24h: 1,
      topicShifts24h: 3,
      deferredQuestionsReRaised24h: 1,
      answerConfidence: {
        avg24h: 0.8,
        buckets24h: { low: 0, medium: 1, high: 2, unknown: 1 },
        matchMethodCounts24h: { exact_option: 1, text: 1, synonym: 1 },
      },
    });
  });

  it("exports user data as JSON attachment", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/admin/users/user_123/export",
      headers: { "x-admin-api-key": TEST_ADMIN_KEY },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-disposition"]).toContain("carememory-admin-export.json");
    const body = response.json();
    expect(body.userId).toBe("user_123");
    expect(body.includeAudit).toBe(true);
  });

  it("returns 404 when exporting missing user", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/admin/users/missing/export",
      headers: { "x-admin-api-key": TEST_ADMIN_KEY },
    });
    expect(response.statusCode).toBe(404);
  });

  it("deletes user data and returns deleted flag", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/admin/users/user_123",
      headers: { "x-admin-api-key": TEST_ADMIN_KEY },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: true });
  });

  it("returns 404 when deleting missing user", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/admin/users/missing",
      headers: { "x-admin-api-key": TEST_ADMIN_KEY },
    });
    expect(response.statusCode).toBe(404);
  });
});
