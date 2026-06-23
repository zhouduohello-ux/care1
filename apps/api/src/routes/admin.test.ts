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
    checkIn: { count: vi.fn(async () => 20) },
    observation: { count: vi.fn(async () => 100) },
    event: {
      count: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        if (args?.where?.type === "llm_call") return 7;
        return 200;
      }),
      findMany: vi.fn(async (args?: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
        if (args?.where?.type === "llm_call") {
          return [
            { tokenUsage: { prompt: 100, completion: 50, total: 150 } },
            { tokenUsage: { prompt: 200, completion: 100, total: 300 } },
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
