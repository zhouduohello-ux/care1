import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";
import { createRedisQuotaStore } from "./quota-store.js";

function makeRedisStub() {
  const store = new Map<string, string>();
  const pipelineOps: Array<{ command: string; key: string; value?: number }> = [];

  const pipeline: {
    incr: (key: string) => typeof pipeline;
    expire: (key: string, seconds: number) => typeof pipeline;
    exec: () => Promise<unknown>;
  } = {
    incr(key: string) {
      pipelineOps.push({ command: "incr", key });
      store.set(key, String(Number(store.get(key) ?? 0) + 1));
      return pipeline;
    },
    expire(key: string, seconds: number) {
      pipelineOps.push({ command: "expire", key, value: seconds });
      return pipeline;
    },
    async exec() {
      const incrOp = pipelineOps.find((o) => o.command === "incr");
      return [[null, incrOp ? store.get(incrOp.key) : null]];
    },
  };

  const redis = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    pipeline: vi.fn(() => pipeline),
  } as unknown as Redis;

  return { redis, store, pipelineOps, pipeline };
}

describe("createRedisQuotaStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the stored daily count", async () => {
    const { redis } = makeRedisStub();
    const quotaStore = createRedisQuotaStore(redis);

    const count = await quotaStore.getDailyCount("user_1", "2026-06-15");
    expect(count).toBe(0);
    expect(redis.get).toHaveBeenCalledWith("llm:daily:user_1:2026-06-15");
  });

  it("increments the daily counter and sets an expiry", async () => {
    const { redis, pipelineOps } = makeRedisStub();
    const quotaStore = createRedisQuotaStore(redis);

    await quotaStore.incrementDailyCount("user_1", "2026-06-15");

    expect(pipelineOps).toHaveLength(2);
    expect(pipelineOps[0]).toEqual({ command: "incr", key: "llm:daily:user_1:2026-06-15" });
    expect(pipelineOps[1].command).toBe("expire");
    expect(pipelineOps[1].key).toBe("llm:daily:user_1:2026-06-15");
    expect(pipelineOps[1].value).toBeGreaterThan(0);
    expect(pipelineOps[1].value).toBeLessThanOrEqual(24 * 60 * 60 + 1);
  });
});
