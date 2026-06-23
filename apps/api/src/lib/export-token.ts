import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";

const EXPORT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createExportTokenFactory(fastify: FastifyInstance) {
  return async function createExportToken(userId: string): Promise<string> {
    const token = crypto.randomBytes(32).toString("hex");
    await fastify.redis.setex(`export:${token}`, EXPORT_TTL_SECONDS, userId);
    return token;
  };
}

export async function resolveExportToken(redis: FastifyInstance["redis"], token: string): Promise<string | null> {
  return redis.get(`export:${token}`);
}
