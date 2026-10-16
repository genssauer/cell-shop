import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockCatalogSource } from "../src/catalog/mock-source.js";
import { createDatabase } from "../src/infrastructure/database.js";

const runningApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.close()));
});

async function makeFixture() {
  const database = createDatabase(":memory:");
  const app = await buildApp({
    config: loadConfig({ DATABASE_PATH: ":memory:", OTEL_ENABLED: "false" }),
    database,
    catalogSource: new MockCatalogSource(),
    logger: false,
  });
  await app.ready();
  runningApps.push(app);
  return { app, database };
}

test("order status exposes only the three public states and returns 404 for an unknown id", async () => {
  const { app, database } = await makeFixture();
  const accepted = await app.inject({
    method: "POST",
    url: "/checkout",
    headers: { "idempotency-key": "status-processing" },
    payload: { items: [{ sku: "SKU-001", quantity: 1 }] },
  });
  const orderId = accepted.json().orderId as string;

  const processing = await app.inject({ method: "GET", url: `/orders/${orderId}/status` });
  assert.equal(processing.statusCode, 200);
  assert.equal(processing.json().status, "PROCESSING");

  database.prepare("UPDATE orders SET status = 'COMPLETED' WHERE id = ?").run(orderId);
  const completed = await app.inject({ method: "GET", url: `/orders/${orderId}/status` });
  assert.equal(completed.json().status, "COMPLETED");

  database.prepare("UPDATE orders SET status = 'FAILED' WHERE id = ?").run(orderId);
  const failed = await app.inject({ method: "GET", url: `/orders/${orderId}/status` });
  assert.equal(failed.json().status, "FAILED");

  const unknown = await app.inject({ method: "GET", url: "/orders/not-a-real-order/status" });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().code, "ORDER_NOT_FOUND");
});
