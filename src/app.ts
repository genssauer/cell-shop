import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { AppConfig } from "./config.js";
import { HttpError, errorResponseSchema } from "./infrastructure/errors.js";
import { createMetrics, type AppMetrics } from "./infrastructure/metrics.js";
import type { SqliteDatabase } from "./infrastructure/database.js";
import { CatalogCache } from "./catalog/cache.js";
import { MockCatalogSource, type CatalogSource } from "./catalog/mock-source.js";
import { registerCatalogRoutes } from "./catalog/routes.js";
import { CatalogService } from "./catalog/service.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { CreateOrder } from "./checkout/create-order.js";
import { registerCheckoutRoutes } from "./checkout/routes.js";
import { GetOrderStatus } from "./orders/get-status.js";
import { registerOrderRoutes } from "./orders/routes.js";
import { BillingWorker } from "./billing/worker.js";

export interface AppOptions {
  config: AppConfig;
  database: SqliteDatabase;
  metrics?: AppMetrics;
  catalogSource?: CatalogSource;
  closeDatabaseOnClose?: boolean;
  logger?: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    metrics: AppMetrics;
  }
}

const healthSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { type: "string", const: "ok" } },
    },
    503: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { type: "string", const: "unavailable" } },
    },
  },
} as const;

export async function buildApp({ config, database, metrics = createMetrics(), catalogSource = new MockCatalogSource(), closeDatabaseOnClose = true, logger = true }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger && {
      level: "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.x-api-key",
          "req.body.password",
          "req.body.token",
          "req.body.secret",
          "req.body.cardNumber",
          "req.body.cvv",
        ],
        remove: true,
      },
    },
    genReqId: () => randomUUID(),
  });
  app.decorate("metrics", metrics);

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "CaseCellShop Backend Challenge API",
        version: "1.0.0",
        description: "API local do desafio backend CellShop.",
      },
      servers: [{ url: `http://localhost:${config.port}` }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    metrics.httpRequestDuration.observe(
      { method: request.method, route, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
    request.log.info({
      operation: route,
      result: reply.statusCode < 400 ? "success" : "error",
      durationMs: reply.elapsedTime,
      requestId: request.id,
      statusCode: reply.statusCode,
    }, "request completed");
  });

  app.get("/health/live", { schema: { operationId: "liveness", summary: "Indica se o processo está respondendo.", ...healthSchema } }, async () => ({ status: "ok" }));
  app.get("/health/ready", { schema: { operationId: "readiness", summary: "Indica se o banco local está acessível.", ...healthSchema } }, async (_request, reply) => {
    try {
      database.prepare("SELECT 1").get();
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.get("/metrics", { config: { otel: false }, schema: { hide: true } }, async (_request, reply) => {
    reply.header("Content-Type", metrics.registry.contentType);
    return reply.send(await metrics.registry.metrics());
  });

  const catalogCache = new CatalogCache(catalogSource, config.catalogTtlMs, metrics);
  registerCatalogRoutes(app, new CatalogService(catalogCache, database));
  const store = new SqliteStore(database);
  registerCheckoutRoutes(app, new CreateOrder(store, catalogCache, metrics));
  registerOrderRoutes(app, new GetOrderStatus(store));

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      code: "NOT_FOUND",
      message: "Rota não encontrada.",
      requestId: request.id,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const validationFailure = Boolean((error as { validation?: unknown }).validation);
    const reportedStatusCode = (error as { statusCode?: unknown }).statusCode;
    const statusCode = error instanceof HttpError
      ? error.statusCode
      : validationFailure
        ? 400
        : typeof reportedStatusCode === "number" && Number.isInteger(reportedStatusCode) && reportedStatusCode >= 400 && reportedStatusCode < 500
          ? reportedStatusCode
          : 500;
    const safeError = error instanceof HttpError
      ? error
      : new HttpError(
          statusCode,
          validationFailure ? "BAD_REQUEST" : statusCode === 404 ? "NOT_FOUND" : "INTERNAL_ERROR",
          validationFailure ? "Requisição inválida." : statusCode === 404 ? "Recurso não encontrado." : "Falha interna.",
        );

    request.log.error({
      operation: request.routeOptions.url ?? "unmatched",
      result: "error",
      requestId: request.id,
      errorCode: safeError.code,
      statusCode,
    }, "request failed");

    return reply.code(statusCode).send({
      code: safeError.code,
      message: safeError.message,
      requestId: request.id,
    });
  });

  if (closeDatabaseOnClose) {
    app.addHook("onClose", async () => {
      if (database.open) database.close();
    });
  }

  return app;
}

export { HttpError, errorResponseSchema };
