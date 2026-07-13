import fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import * as Sentry from "@sentry/node";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import prismaPlugin from "./plugins/prisma.js";
import redisPlugin from "./plugins/redis.js";
import clockPlugin from "./plugins/clock.js";
import rawBodyPlugin from "./plugins/raw-body.js";
import healthRoutes from "./routes/health.js";
import webhookRoutes from "./routes/webhooks.js";
import testToolRoutes from "./routes/test-tool.js";
import briefRoutes from "./routes/briefs.js";
import exportRoutes from "./routes/export.js";
import diseaseCardRoutes from "./routes/disease-cards.js";
import recordsRoutes from "./routes/records.js";
import adminRoutes from "./routes/admin.js";
import { startScheduler, processDueCheckIns, processDueReminders } from "./services/scheduler.js";
import { createRedisQuotaStore } from "./lib/quota-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.env.NODE_ENV === "production";
const logLevel = (process.env.LOG_LEVEL as "fatal" | "error" | "warn" | "info" | "debug" | "trace" | undefined)
  ?? (isProduction ? "info" : "debug");

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.RELEASE ?? undefined,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? "0.0"),
  });
}

const app = fastify({
  logger: {
    level: logLevel,
    // Native JSON in production; development defaults to JSON as well for consistency.
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "password", "token", "*.token", "*.password"],
      censor: "[REDACTED]",
    },
  },
  genReqId: () => crypto.randomUUID(),
  disableRequestLogging: false,
});

async function main() {
  await app.register(helmet);
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    allowList: (request) => {
      // The local test-tool is only available in development/staging and is hit
      // heavily by E2E scenario runners; exclude it from rate limiting.
      return request.url.startsWith("/dev/test-tool") || request.url.startsWith("/health");
    },
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (process.env.ENABLE_TEST_TOOL === "true" && request.url.startsWith("/dev/test-tool")) {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
      );
    }
    return payload;
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (isProduction) {
      Sentry.captureException(error);
    }
    app.log.error(error);
    reply.status(error.statusCode ?? 500).send({
      statusCode: error.statusCode ?? 500,
      error: "Internal Server Error",
      message: isProduction ? "An unexpected error occurred" : error.message,
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Route not found" });
  });

  await app.register(prismaPlugin);
  await app.register(redisPlugin, { url: process.env.REDIS_URL ?? "redis://localhost:6381" });
  app.decorate("quotaStore", createRedisQuotaStore(app.redis));
  await app.register(clockPlugin, { virtual: process.env.ENABLE_TEST_TOOL === "true" });
  await app.register(rawBodyPlugin);

  if (process.env.ENABLE_TEST_TOOL === "true") {
    await app.register(staticPlugin, {
      root: path.join(__dirname, "..", "public", "test-tool"),
      prefix: "/dev/test-tool/",
    });
  }

  await app.register(healthRoutes);
  await app.register(webhookRoutes);
  await app.register(testToolRoutes);
  await app.register(briefRoutes);
  await app.register(exportRoutes);
  await app.register(diseaseCardRoutes);
  await app.register(recordsRoutes);
  await app.register(adminRoutes);

  // Configuration warnings
  if (!process.env.ADMIN_API_KEY) {
    app.log.warn("ADMIN_API_KEY is not set; admin/metrics endpoints are disabled.");
  }
  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    app.log.warn("WhatsApp credentials are not configured; outbound messages will not be sent to Meta.");
  }
  if (!process.env.LLM_API_KEY && !process.env.OPENAI_API_KEY) {
    app.log.warn("No LLM API key configured (LLM_API_KEY or OPENAI_API_KEY); perception and planner will use rule-based fallbacks.");
  }

  // Start BullMQ-based background scheduler for check-ins and reminders
  const scheduler = await startScheduler(app.prisma, app.clock, app.redis, app.quotaStore);
  app.addHook("onClose", async () => {
    await scheduler.stop();
  });

  // Run one immediate tick to catch any work that became due while the server was down
  await processDueCheckIns(app.prisma, app.clock, app.quotaStore).catch((err) => app.log.error(err));
  await processDueReminders(app.prisma, app.clock).catch((err) => app.log.error(err));

  const port = Number(process.env.PORT ?? 3055);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`CareMemory API listening on http://0.0.0.0:${port}`);
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
