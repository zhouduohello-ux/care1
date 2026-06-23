import type { PrismaClient } from "@carememory/db";
import { handleCheckInTrigger, scheduleNextCheckInOffset, type QuotaStore } from "@carememory/engine";
import type { Redis } from "ioredis";
import * as Sentry from "@sentry/node";
import { Job, Queue, Worker } from "bullmq";
import type { Clock } from "../plugins/clock.js";
import { dispatchOutboundMessages } from "../lib/dispatch-outbound.js";

export const SCHEDULER_QUEUE_NAME = "carememory-scheduler";

export type SchedulerJobName = "scan-checkins" | "scan-reminders";

export interface Scheduler {
  queue: Queue;
  worker: Worker;
  stop: () => Promise<void>;
}

export function scheduleNextCheckIn(userId: string, now: Date): Date {
  return scheduleNextCheckInOffset(userId, now);
}

export async function processDueCheckIns(
  prisma: PrismaClient,
  clock: Clock,
  quotaStore?: QuotaStore
) {
  const now = clock.now();
  const dueCycles = await prisma.cycle.findMany({
    where: {
      status: "ACTIVE",
      nextCheckinAt: { lte: now },
    },
    include: { user: true },
  });

  for (const cycle of dueCycles) {
    // Skip if there is already an active check-in waiting for a reply
    const existing = await prisma.checkIn.findFirst({
      where: { cycleId: cycle.id, status: { in: ["SENT", "SCHEDULED"] } },
    });
    if (existing) continue;

    const outbound = await handleCheckInTrigger({ prisma, now, quotaStore }, cycle.id);
    if (outbound.length > 0) {
      await dispatchOutboundMessages(prisma, outbound, now);
    }

    await prisma.cycle.update({
      where: { id: cycle.id },
      data: { nextCheckinAt: scheduleNextCheckIn(cycle.user.phoneNumber, now) },
    });
  }
}

export async function processDueReminders(prisma: PrismaClient, clock: Clock) {
  const now = clock.now();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const pendingCheckIns = await prisma.checkIn.findMany({
    where: {
      status: "SENT",
      sentAt: { lte: oneDayAgo },
      reminderSentAt: null,
    },
    include: { cycle: { include: { user: true } } },
  });

  for (const checkIn of pendingCheckIns) {
    if (!checkIn.cycle?.user) continue;

    const reminder = {
      userId: checkIn.cycle.user.phoneNumber,
      conversationContext: { requiresSession: true, priority: "normal" as const },
      content: {
        type: "text" as const,
        text: "Hi, you have a pending CareMemory check-in. It only takes a minute. If you're having severe breathing problems, call 999 or follow your asthma action plan.",
      },
    };

    await dispatchOutboundMessages(prisma, [reminder], now);
    await prisma.checkIn.update({
      where: { id: checkIn.id },
      data: { reminderSentAt: now },
    });
  }
}

export function createProcessor(deps: { prisma: PrismaClient; clock: Clock; quotaStore?: QuotaStore }) {
  return async function schedulerProcessor(job: Job<unknown>): Promise<void> {
    switch (job.name as SchedulerJobName) {
      case "scan-checkins":
        await processDueCheckIns(deps.prisma, deps.clock, deps.quotaStore);
        break;
      case "scan-reminders":
        await processDueReminders(deps.prisma, deps.clock);
        break;
      default:
        throw new Error(`Unknown scheduler job name: ${job.name}`);
    }
  };
}

function getBullmqConnection(redis: Redis) {
  // Derive host/port from the existing Redis connection so BullMQ can open its
  // own dedicated connection without coupling to the ioredis version used by
  // the redis plugin.
  return {
    host: redis.options.host ?? "localhost",
    port: redis.options.port ?? 6381,
  };
}

export async function startScheduler(
  prisma: PrismaClient,
  clock: Clock,
  redis: Redis,
  quotaStore?: QuotaStore,
  opts: { intervalMs?: number } = {}
): Promise<Scheduler> {
  const intervalMs = opts.intervalMs ?? 60_000;
  const connection = getBullmqConnection(redis);
  const queue = new Queue(SCHEDULER_QUEUE_NAME, { connection });
  const processor = createProcessor({ prisma, clock, quotaStore });
  const worker = new Worker(SCHEDULER_QUEUE_NAME, processor, {
    connection,
    concurrency: 1,
  });

  worker.on("error", (err) => {
    console.error("[scheduler] worker error", err);
    Sentry.captureException(err);
  });

  // Use repeatable job schedulers to scan for due work. Each scan is idempotent:
  // it queries the DB and only acts on records that are actually due.
  await queue.upsertJobScheduler(
    "scan-checkins",
    { every: intervalMs },
    { name: "scan-checkins", data: {}, opts: { attempts: 3, backoff: { type: "exponential", delay: 1000 } } }
  );
  await queue.upsertJobScheduler(
    "scan-reminders",
    { every: intervalMs },
    { name: "scan-reminders", data: {}, opts: { attempts: 3, backoff: { type: "exponential", delay: 1000 } } }
  );

  return {
    queue,
    worker,
    stop: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
