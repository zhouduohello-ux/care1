import type { PrismaClient } from "@carememory/db";

export function getDailyLlmLimit(): number {
  const env = process.env.LLM_DAILY_LIMIT_USER;
  if (!env) return 50;
  const n = Number(env);
  return Number.isNaN(n) || n < 0 ? 50 : n;
}

export function getFallbackModel(): string | undefined {
  return process.env.LLM_FALLBACK_MODEL;
}

export interface QuotaStore {
  /** Return the number of LLM calls already recorded for the given user and day key. */
  getDailyCount(userId: string, dayKey: string): Promise<number>;
  /** Atomically increment the LLM call counter for the given user and day key. */
  incrementDailyCount(userId: string, dayKey: string): Promise<void>;
}

export function getDayKey(now: Date): string {
  // Use UTC date for the day key so Redis counters are deterministic regardless
  // of the runtime timezone.
  return now.toISOString().slice(0, 10);
}

export async function countUserLlmCallsToday(
  prisma: PrismaClient,
  userId: string,
  now: Date
): Promise<number> {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  return prisma.event.count({
    where: {
      userId,
      type: "llm_call",
      timestamp: { gte: startOfDay },
    },
  });
}

export async function hasLlmQuota(
  store: QuotaStore | undefined,
  userId: string,
  now: Date
): Promise<boolean> {
  const limit = getDailyLlmLimit();
  if (limit === 0) return false;
  if (!store) return true;
  const used = await store.getDailyCount(userId, getDayKey(now));
  return used < limit;
}

export async function incrementLlmQuota(
  store: QuotaStore | undefined,
  userId: string,
  now: Date
): Promise<void> {
  if (!store) return;
  await store.incrementDailyCount(userId, getDayKey(now));
}

export function isRetryableLlmError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("timeout") ||
    message.includes("500") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("fetch failed")
  );
}
