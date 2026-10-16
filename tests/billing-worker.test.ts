import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockCatalogSource } from "../src/catalog/mock-source.js";
import { BillingWorker } from "../src/billing/worker.js";
import { MockErpGateway } from "../src/billing/erp-gateway.js";
import { createDatabase, type SqliteDatabase } from "../src/infrastructure/database.js";
import { SqliteStore } from "../src/infrastructure/sqlite-store.js";

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
  return { app, database, store: new SqliteStore(database) };
}

async function acceptOrder(app: FastifyInstance, key: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/checkout",
    headers: { "idempotency-key": key },
    payload: { items: [{ sku: "SKU-001", quantity: 1 }] },
  });
  assert.equal(response.statusCode, 202);
  return response.json().orderId as string;
}

function workerFor(database: SqliteDatabase, app: FastifyInstance, gateway: MockErpGateway): BillingWorker {
  return new BillingWorker(new SqliteStore(database), gateway, app.metrics, {
    retryDelaysMs: [0, 0, 0],
    reconciliationDelayMs: 0,
    pollIntervalMs: 1_000,
  });
}

function row<T>(database: SqliteDatabase, sql: string, ...params: unknown[]): T {
  return database.prepare(sql).get(...params) as T;
}

test("transient ERP errors retry; only confirmed billing completes and settles stock once", async () => {
  const { app, database } = await makeFixture();
  const orderId = await acceptOrder(app, "transient-retry");
  const gateway = new MockErpGateway();
  gateway.enqueueOutcome({ kind: "transient" });
  const worker = workerFor(database, app, gateway);

  assert.equal(await worker.processNext(), true);
  assert.equal(row<{ status: string }>(database, "SELECT status FROM orders WHERE id = ?", orderId).status, "PROCESSING");
  assert.equal(row<{ state: string }>(database, "SELECT state FROM reservations WHERE order_id = ?", orderId).state, "RESERVED");
  assert.equal(row<{ state: string }>(database, "SELECT state FROM billing_tasks WHERE order_id = ?", orderId).state, "RETRY_WAIT");

  assert.equal(await worker.processNext(), true);
  assert.equal(row<{ status: string }>(database, "SELECT status FROM orders WHERE id = ?", orderId).status, "COMPLETED");
  assert.equal(row<{ state: string }>(database, "SELECT state FROM reservations WHERE order_id = ?", orderId).state, "CONFIRMED");
  assert.equal(row<{ on_hand: number; reserved: number }>(database, "SELECT on_hand, reserved FROM stock_positions WHERE sku = 'SKU-001'").on_hand, 9);
  assert.equal(row<{ reserved: number }>(database, "SELECT reserved FROM stock_positions WHERE sku = 'SKU-001'").reserved, 0);
  assert.equal(gateway.invoiceCount(orderId), 1);
});

test("definitive ERP failure moves the task to the dead letter state and releases stock once", async () => {
  const { app, database } = await makeFixture();
  const orderId = await acceptOrder(app, "definitive-failure");
  const gateway = new MockErpGateway();
  gateway.enqueueOutcome({ kind: "definitive" });
  const worker = workerFor(database, app, gateway);

  await worker.processNext();
  await worker.processNext();
  assert.equal(row<{ status: string }>(database, "SELECT status FROM orders WHERE id = ?", orderId).status, "FAILED");
  assert.equal(row<{ state: string }>(database, "SELECT state FROM billing_tasks WHERE order_id = ?", orderId).state, "DEAD_LETTER");
  assert.equal(row<{ state: string }>(database, "SELECT state FROM reservations WHERE order_id = ?", orderId).state, "RELEASED");
  assert.equal(row<{ on_hand: number; reserved: number }>(database, "SELECT on_hand, reserved FROM stock_positions WHERE sku = 'SKU-001'").reserved, 0);
  assert.equal(await worker.processNext(), false);
  assert.equal(row<{ reserved: number }>(database, "SELECT reserved FROM stock_positions WHERE sku = 'SKU-001'").reserved, 0);
});

test("an unknown ERP result keeps the order and reservation active until reconciliation", async () => {
  const { app, database } = await makeFixture();
  const orderId = await acceptOrder(app, "unknown-result");
  const gateway = new MockErpGateway();
  gateway.enqueueOutcome({ kind: "unknown", invoiceCreated: false });
  const worker = workerFor(database, app, gateway);

  await worker.processNext();
  assert.equal(row<{ status: string }>(database, "SELECT status FROM orders WHERE id = ?", orderId).status, "PROCESSING");
  assert.equal(row<{ state: string }>(database, "SELECT state FROM billing_tasks WHERE order_id = ?", orderId).state, "RECONCILIATION");
  assert.equal(row<{ state: string }>(database, "SELECT state FROM reservations WHERE order_id = ?", orderId).state, "RESERVED");

  gateway.resolveOrder(orderId, "SUCCEEDED");
  await worker.processNext();
  assert.equal(row<{ status: string }>(database, "SELECT status FROM orders WHERE id = ?", orderId).status, "COMPLETED");
  assert.equal(row<{ state: string }>(database, "SELECT state FROM reservations WHERE order_id = ?", orderId).state, "CONFIRMED");
  assert.equal(gateway.invoiceCount(orderId), 1);
});

test("a processing task left by a crashed worker is recovered and reconciled", async () => {
  const { app, database } = await makeFixture();
  const orderId = await acceptOrder(app, "persisted-recovery");
  database.prepare("UPDATE billing_tasks SET state = 'PROCESSING', lease_until = NULL WHERE order_id = ?").run(orderId);
  const gateway = new MockErpGateway();
  gateway.resolveOrder(orderId, "SUCCEEDED");
  const worker = workerFor(database, app, gateway);

  await worker.recover();
  assert.equal(row<{ state: string }>(database, "SELECT state FROM billing_tasks WHERE order_id = ?", orderId).state, "RECONCILIATION");
  await worker.processNext();
  assert.equal(row<{ status: string }>(database, "SELECT status FROM orders WHERE id = ?", orderId).status, "COMPLETED");
  assert.equal(row<{ reserved: number }>(database, "SELECT reserved FROM stock_positions WHERE sku = 'SKU-001'").reserved, 0);
});
