import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Structured logging helper for CareMemory API routes.
 *
 * Usage:
 *   import { logger } from "../lib/logger.js";
 *   logger(req).info({ userId, event }, "message");
 */

export interface LogContext {
  [key: string]: unknown;
}

export function logger(req?: FastifyRequest) {
  return req?.log ?? console;
}

/**
 * Attach common fields to a request log for the duration of a handler.
 */
export function withContext(req: FastifyRequest, ctx: LogContext) {
  req.log = req.log.child(ctx);
}

/**
 * Log an outgoing HTTP response with consistent shape.
 */
export function logResponse(req: FastifyRequest, reply: FastifyReply, extra?: LogContext) {
  req.log.info(
    {
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
      ...extra,
    },
    "request completed"
  );
}
