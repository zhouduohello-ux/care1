import type { Redis } from "ioredis";
import type { QuotaStore } from "@carememory/engine";

export function createRedisQuotaStore(redis: Redis): QuotaStore {
  return {
    async getDailyCount(userId: string, dayKey: string): Promise<number> {
      const value = await redis.get(buildKey(userId, dayKey));
      return value ? Number(value) : 0;
    },

    async incrementDailyCount(userId: string, dayKey: string): Promise<void> {
      const key = buildKey(userId, dayKey);
      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const secondsUntilMidnight = Math.max(
        1,
        Math.ceil((startOfDay.getTime() + 24 * 60 * 60 * 1000 - now.getTime()) / 1000)
      );

      const pipeline = redis.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, secondsUntilMidnight);
      await pipeline.exec();
    },
  };
}

function buildKey(userId: string, dayKey: string): string {
  return `llm:daily:${userId}:${dayKey}`;
}

declare module "fastify" {
  interface FastifyInstance {
    quotaStore: QuotaStore;
  }
}
