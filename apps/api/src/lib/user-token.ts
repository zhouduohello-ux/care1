import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";

const USER_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createUserAccessTokenFactory(fastify: FastifyInstance) {
  return async function createUserAccessToken(userId: string): Promise<string> {
    const token = crypto.randomBytes(32).toString("hex");
    await fastify.redis.setex(`user_access:${token}`, USER_TOKEN_TTL_SECONDS, userId);
    return token;
  };
}

export async function resolveUserAccessToken(redis: FastifyInstance["redis"], token: string): Promise<string | null> {
  return redis.get(`user_access:${token}`);
}
