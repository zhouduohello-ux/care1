import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@carememory/db";
import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import { createProcessor, startScheduler, SCHEDULER_QUEUE_NAME, getNudgeAfterMs, getPendingTimeoutMs, getScanLookbackMs, getSchedulerIntervalMs } from "./scheduler.js";
import { createProcessor, startScheduler, SCHEDULER_QUEUE_NAME, getNudgeAfterMs, getPendingTimeoutMs } from "./scheduler.js";
import { deferPendingQuestion } from "@carememory/engine";

vi.mock("@carememory/engine", () => ({
  handleCheckInTrigger: vi.fn(async () => []),
  scheduleNextCheckInOffset: vi.fn((_userId: string, now: Date) => new Date(now.getTime() + 24 * 60 * 60 * 1000)),
  loadLLMConfig: vi.fn(() => ({ enabled: false, chat: { apiKey: "", baseUrl: "", model: "" }, reason: { apiKey: "", baseUrl: "", model: "" }, layers: {}, timeoutMs: 30000, maxRetries: 2, retryBaseDelayMs: 500 })),
  shouldDeferOnTimeout: vi.fn(() => true),
  deferPendingQuestion: vi.fn(async (_prisma, _checkInId, pending) => [pending]),
}));

vi.mock("../lib/dispatch-outbound.js", () => ({
  dispatchOutboundMessages: vi.fn(async () => ({ sent: 0, failed: 0, results: [] })),
}));

const mockQueueInstances: Array<{
  name: string;
  schedulers: Array<{ id: string; repeat?: { every?: number } }>;
  closed: boolean;
  upsertJobScheduler: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}> = [];

const mockWorkerInstances: Array<{
  name: string;
  processor: unknown;
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("bullmq", () => ({
  Queue: vi.fn(function (this: typeof mockQueueInstances[number], name: string, _opts: unknown) {
    const instance = {
      name,
      schedulers: [] as Array<{ id: string; repeat?: { every?: number } }>,
      closed: false,
      upsertJobScheduler: vi.fn(async (id: string, repeat: { every?: number }) => {
        instance.schedulers.push({ id, repeat });
      }),
      close: vi.fn(async () => {
        instance.closed = true;
      }),
    };
    mockQueueInstances.push(instance);
    return instance;
  }),
  Worker: vi.fn(function (this: typeof mockWorkerInstances[number], name: string, processor: unknown, _opts: unknown) {
    const instance = {
      name,
      processor,
      closed: false,
      close: vi.fn(async () => {
        instance.closed = true;
      }),
      on: vi.fn(),
    };
    mockWorkerInstances.push(instance);
    return instance;
  }),
  Job: class MockJob {
    constructor(public id: string, public name: string, public data: unknown) {}
  },
}));

function makeClock(now: Date) {
  return { now: () => new Date(now.getTime()), advance: vi.fn(), setTime: vi.fn(), resetUser: vi.fn() };
}

function makePrismaStub() {
  const cycles: Array<Record<string, unknown>> = [];
  const checkIns: Array<Record<string, unknown>> = [];
  const observations: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];

  return {
    cycle: {
      findMany: vi.fn(async () => cycles),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...cycles[0], ...data })),
    },
    checkIn: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => checkIns.find((c) => c.id === where.id) ?? null),
      findMany: vi.fn(async () => checkIns),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...checkIns[0], ...data })),
    },
    observation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        observations.push(data);
        return data;
      }),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      }),
    },
    _cycles: cycles,
    _checkIns: checkIns,
    _observations: observations,
    _events: events,
  } as unknown as PrismaClient & { _cycles: typeof cycles; _checkIns: typeof checkIns; _observations: typeof observations; _events: typeof events };
}

describe("scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueInstances.length = 0;
    mockWorkerInstances.length = 0;
  });

  describe("startScheduler", () => {
    it("creates a BullMQ queue and worker with the correct name and redis connection", async () => {
      const prisma = makePrismaStub();
      const clock = makeClock(new Date("2026-06-15T10:00:00.000Z"));
      const redis = { options: { host: "localhost", port: 6381 }, quit: vi.fn() } as unknown as Redis;

      await startScheduler(prisma, clock, redis);

      expect(mockQueueInstances).toHaveLength(1);
      expect(mockQueueInstances[0].name).toBe(SCHEDULER_QUEUE_NAME);
      expect(mockWorkerInstances).toHaveLength(1);
      expect(mockWorkerInstances[0].name).toBe(SCHEDULER_QUEUE_NAME);
    });

    it("registers repeatable scanners for due check-ins, reminders, expired pending questions, and pending nudges", async () => {
      const prisma = makePrismaStub();
      const clock = makeClock(new Date("2026-06-15T10:00:00.000Z"));
      const redis = { options: { host: "localhost", port: 6381 }, quit: vi.fn() } as unknown as Redis;

      await startScheduler(prisma, clock, redis, undefined, { intervalMs: 30_000 });

      const queue = mockQueueInstances[0];
      expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(4);
      expect(queue.schedulers).toHaveLength(4);
      expect(queue.schedulers.map((s) => s.id).sort()).toEqual(["scan-checkins", "scan-expired-pending", "scan-pending-nudge", "scan-reminders"]);
      expect(queue.schedulers.every((s) => s.repeat?.every === 30_000)).toBe(true);
    });

    it("stops the worker and queue cleanly", async () => {
      const prisma = makePrismaStub();
      const clock = makeClock(new Date("2026-06-15T10:00:00.000Z"));
      const redis = { options: { host: "localhost", port: 6381 }, quit: vi.fn() } as unknown as Redis;

      const scheduler = await startScheduler(prisma, clock, redis);
      await scheduler.stop();

      expect(mockWorkerInstances[0].close).toHaveBeenCalled();
      expect(mockQueueInstances[0].close).toHaveBeenCalled();
      expect(mockWorkerInstances[0].closed).toBe(true);
      expect(mockQueueInstances[0].closed).toBe(true);
    });
  });

  describe("createProcessor", () => {
    it("processes scan-checkins by querying due cycles within the lookback window", async () => {
      const prisma = makePrismaStub();
      prisma._cycles.push({ id: "cycle_1", user: { phoneNumber: "447123456789" }, nextCheckinAt: new Date("2026-06-15T09:00:00.000Z") });
      const clock = makeClock(new Date("2026-06-15T10:00:00.000Z"));
      const processor = createProcessor({ prisma, clock });

      await processor({ name: "scan-checkins", data: {}, id: "job-1" } as unknown as Job);

      expect(prisma.cycle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: "ACTIVE",
            nextCheckinAt: {
              lte: clock.now(),
              gte: expect.any(Date),
            },
          },
          include: { user: true },
        })
      );
    });

    it("processes scan-reminders by querying pending check-ins older than 24h within the lookback window", async () => {
      const prisma = makePrismaStub();
      prisma._checkIns.push({
        id: "ci_1",
        status: "SENT",
        sentAt: new Date("2026-06-14T08:00:00.000Z"),
        reminderSentAt: null,
        cycle: { user: { phoneNumber: "447123456789" } },
      });
      const clock = makeClock(new Date("2026-06-15T10:00:00.000Z"));
      const processor = createProcessor({ prisma, clock });

      await processor({ name: "scan-reminders", data: {}, id: "job-2" } as unknown as Job);

      expect(prisma.checkIn.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: "SENT",
            sentAt: { lte: new Date(clock.now().getTime() - 24 * 60 * 60 * 1000), gte: expect.any(Date) },
            reminderSentAt: null,
          },
          include: { cycle: { include: { user: true } } },
        })
      );
    });

    it("processes scan-expired-pending by deferring stale pending questions to the next check-in", async () => {
      const prisma = makePrismaStub();
      prisma._checkIns.push({
        id: "ci_1",
        status: "SENT",
        sentAt: new Date("2026-06-14T08:00:00.000Z"),
        pendingQuestion: { topic: "nighttime_symptoms", purpose: "Nighttime symptoms?", expectedResponseType: "single_choice", options: ["night_none"], askedAt: "2026-06-14T08:00:00.000Z" },
        deferredQuestions: [],
        cycleId: "cycle_1",
        cycle: { id: "cycle_1", userId: "user_1", user: { phoneNumber: "447123456789" } },
      });
      const clock = makeClock(new Date("2026-06-15T10:00:00.000Z"));
      const processor = createProcessor({ prisma, clock });

      await processor({ name: "scan-expired-pending", data: {}, id: "job-3" } as unknown as Job);

      expect(prisma.checkIn.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: "SENT",
            sentAt: { lte: new Date(clock.now().getTime() - 24 * 60 * 60 * 1000), gte: expect.any(Date) },
            pendingQuestion: { not: expect.anything() },
          },
          include: { cycle: { include: { user: true } } },
        })
      );
      expect(prisma.observation.create).not.toHaveBeenCalled();
      expect(deferPendingQuestion).toHaveBeenCalledWith(
        prisma,
        "ci_1",
        expect.objectContaining({ topic: "nighttime_symptoms" })
      );
      expect(prisma.checkIn.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ci_1" },
          data: expect.objectContaining({ status: "MISSED" }),
        })
      );
      expect(prisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "state_updated",
            payload: expect.objectContaining({ reason: "pending_question_deferred_on_timeout" }),
          }),
        })
      );
    });

    it("processes scan-pending-nudge by sending a gentle nudge for check-ins older than 12h", async () => {
      const prisma = makePrismaStub();
      prisma._checkIns.push({
        id: "ci_1",
        status: "SENT",
        sentAt: new Date("2026-06-14T20:00:00.000Z"),
        nudgeSentAt: null,
        pendingQuestion: { topic: "reliever_use" },
        cycle: { user: { phoneNumber: "447123456789" } },
      });
      const clock = makeClock(new Date("2026-06-15T10:00:00.000Z"));
      const processor = createProcessor({ prisma, clock });

      await processor({ name: "scan-pending-nudge", data: {}, id: "job-4" } as unknown as Job);

      expect(prisma.checkIn.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: "SENT",
            sentAt: { lte: new Date(clock.now().getTime() - 12 * 60 * 60 * 1000), gte: expect.any(Date) },
            nudgeSentAt: null,
            pendingQuestion: { not: expect.anything() },
          },
          include: { cycle: { include: { user: true } } },
        })
      );
      expect(prisma.checkIn.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ nudgeSentAt: clock.now() }),
        })
      );
      expect(prisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: "nudge_sent" }),
        })
      );
    });

    it("throws on unknown job names", async () => {
      const prisma = makePrismaStub();
      const clock = makeClock(new Date("2026-06-15T10:00:00.000Z"));
      const processor = createProcessor({ prisma, clock });

      await expect(processor({ name: "unknown", data: {}, id: "job-3" } as unknown as Job)).rejects.toThrow(
        "Unknown scheduler job name: unknown"
      );
    });
  });

  describe("turn management config", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      delete process.env.PENDING_QUESTION_NUDGE_AFTER_MS;
      delete process.env.PENDING_QUESTION_TIMEOUT_MS;
      delete process.env.SCHEDULER_SCAN_LOOKBACK_MS;
      delete process.env.SCHEDULER_INTERVAL_MS;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("returns default nudge, timeout, scan lookback and scheduler interval values", () => {
      expect(getNudgeAfterMs()).toBe(12 * 60 * 60 * 1000);
      expect(getPendingTimeoutMs()).toBe(24 * 60 * 60 * 1000);
      expect(getScanLookbackMs()).toBe(7 * 24 * 60 * 60 * 1000);
      expect(getSchedulerIntervalMs()).toBe(60_000);
    });

    it("reads custom values from environment variables", () => {
      process.env.PENDING_QUESTION_NUDGE_AFTER_MS = "3600000";
      process.env.PENDING_QUESTION_TIMEOUT_MS = "7200000";
      process.env.SCHEDULER_SCAN_LOOKBACK_MS = "86400000";
      process.env.SCHEDULER_INTERVAL_MS = "120000";
      expect(getNudgeAfterMs()).toBe(3600000);
      expect(getPendingTimeoutMs()).toBe(7200000);
      expect(getScanLookbackMs()).toBe(86400000);
      expect(getSchedulerIntervalMs()).toBe(120000);
    });

    it("falls back to defaults for invalid environment values", () => {
      process.env.PENDING_QUESTION_NUDGE_AFTER_MS = "not-a-number";
      process.env.PENDING_QUESTION_TIMEOUT_MS = "-1";
      process.env.SCHEDULER_SCAN_LOOKBACK_MS = "0";
      process.env.SCHEDULER_INTERVAL_MS = "abc";
      expect(getNudgeAfterMs()).toBe(12 * 60 * 60 * 1000);
      expect(getPendingTimeoutMs()).toBe(24 * 60 * 60 * 1000);
      expect(getScanLookbackMs()).toBe(7 * 24 * 60 * 60 * 1000);
      expect(getSchedulerIntervalMs()).toBe(60_000);
    });
  });
});
