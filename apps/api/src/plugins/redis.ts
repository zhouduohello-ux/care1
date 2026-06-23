import fp from "fastify-plugin";
import { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";

export interface RedisPluginOptions {
  url: string;
}

export default fp(async function redisPlugin(fastify: FastifyInstance, opts: RedisPluginOptions) {
  const redis = new Redis(opts.url, { maxRetriesPerRequest: null });
  fastify.decorate("redis", redis);

  fastify.addHook("onClose", async () => {
    await redis.quit();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}
