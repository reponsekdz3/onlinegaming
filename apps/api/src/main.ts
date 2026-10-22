import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Pool } from "pg";
import { evaluateRealMoneyGate } from "@onlinegaming/domain";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = (process.env.WEB_ORIGINS ?? (isProduction ? "" : "http://localhost:3000"))
  .split(",").map((origin) => origin.trim()).filter(Boolean);

if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}
if (isProduction && allowedOrigins.length === 0) {
  throw new Error("WEB_ORIGINS must contain an explicit production origin allowlist.");
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.token", "*.secret"],
      censor: "[REDACTED]"
    }
  },
  trustProxy: false,
  bodyLimit: 1_048_576
});

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  connectionTimeoutMillis: 3_000,
  idleTimeoutMillis: 30_000,
  ...(process.env.PGSSL === "true" ? { ssl: { rejectUnauthorized: true } } : {})
}) : null;

await app.register(helmet, {
  contentSecurityPolicy: true,
  crossOriginResourcePolicy: { policy: "same-site" }
});
await app.register(cors, {
  origin: allowedOrigins.length > 0 ? allowedOrigins : false,
  credentials: true
});
await app.register(rateLimit, {
  max: Number(process.env.HTTP_RATE_LIMIT_MAX ?? 120),
  timeWindow: "1 minute"
});

app.get("/health/live", async () => ({
  status: "ok",
  service: "onlinegaming-api"
}));

app.get("/health/ready", async (_request, reply) => {
  if (!pool) {
    return reply.code(503).send({
      status: "not_ready",
      checks: { database: "missing_configuration" }
    });
  }

  try {
    await pool.query("SELECT 1");
    return { status: "ready", checks: { database: "ok" } };
  } catch (error) {
    app.log.error({ err: error }, "Database readiness check failed");
    return reply.code(503).send({
      status: "not_ready",
      checks: { database: "unavailable" }
    });
  }
});

app.get("/api/v1/platform/status", async () => {
  const gate = evaluateRealMoneyGate(process.env);
  return {
    service: "onlinegaming-api",
    environment: process.env.NODE_ENV ?? "development",
    moneyMovement: {
      enabled: false,
      status: "disabled",
      reason: "PAYMENT_AND_WAGERING_HANDLERS_NOT_RELEASED"
    },
    wagering: { enabled: gate.enabled, reason: gate.reason },
    supportedGameEngines: ["tic-tac-toe-v1"]
  };
});

app.addHook("onClose", async () => {
  if (pool) await pool.end();
});

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, "Unhandled request error");
  if (reply.sent) return;
  const statusValue = typeof error === "object" && error !== null && "statusCode" in error
    ? (error as { statusCode?: unknown }).statusCode
    : undefined;
  const status = typeof statusValue === "number" && statusValue >= 400 && statusValue < 500
    ? statusValue
    : 500;
  const errorMessage = error instanceof Error ? error.message : "Unknown request error";
  return reply.code(status).send({
    error: status === 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_ERROR",
    message: status === 500 ? "The request could not be completed." : errorMessage
  });
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error({ err: error }, "Failed to start API");
  await app.close();
  process.exitCode = 1;
}
