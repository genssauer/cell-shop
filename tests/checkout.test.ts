import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockCatalogSource } from "../src/catalog/mock-source.js";
import { createDatabase, type SqliteDatabase } from "../src/infrastructure/database.js";

const runningApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.close()));
});

async function makeFixture(): Promise<{ app: FastifyInstance; database: SqliteDatabase }> {
  const config = loadConfig({ DATABASE_PATH: ":memory:", OTEL_ENABLED: "false" });
  const database = createDatabase(":memory:");
  const app = await buildApp({ config, database, catalogSource: new MockCatalogSource(), logger: false });
  await app.ready();
  runningApps.push(app);
  return { app, database };
}

function queryRow<T>(database: SqliteDatabase, sql: string): T {
  return database.prepare(sql).get() as T;
}

function checkout(app: FastifyInstance, key: string | undefined, items: Array<{ sku: string; quantity: number }>) {
  return app.inject({
    method: "POST",
    url: "/checkout",
    ...(key === undefined ? {} : { headers: { "idempotency-key": key } }),
    payload: { items },
  });
}

test("checkout requires a valid idempotency key and positive item quantities", async () => {
  const { app } = await makeFixture();
  assert.equal((await checkout(app, undefined, [{ sku: "SKU-001", quantity: 1 }])).statusCode, 400);
  assert.equal((await checkout(app, "invalid-quantity", [{ sku: "SKU-001", quantity: 0 }])).statusCode, 400);
});

test("same key and normalized payload reuse one accepted order", async () => {
  const { app, database } = await makeFixture();
  const first = await checkout(app, "same-order", [
    { sku: "SKU-002", quantity: 1 },
    { sku: "SKU-001", quantity: 1 },
  ]);
  const replay = await checkout(app, "same-order", [
    { sku: "SKU-001", quantity: 1 },
    { sku: "SKU-002", quantity: 1 },
  ]);

  assert.equal(first.statusCode, 202);
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.json().orderId, first.json().orderId);
  assert.equal(queryRow<{ count: number }>(database, "SELECT COUNT(*) AS count FROM orders").count, 1);
  assert.equal(queryRow<{ count: number }>(database, "SELECT COUNT(*) AS count FROM billing_tasks").count, 1);
  assert.equal(queryRow<{ count: number }>(database, "SELECT COUNT(*) AS count FROM reservations").count, 2);
});

test("reusing a key with different content and insufficient stock are rejected", async () => {
  const { app } = await makeFixture();
  assert.equal((await checkout(app, "conflicting-order", [{ sku: "SKU-001", quantity: 1 }])).statusCode, 202);

  const conflict = await checkout(app, "conflicting-order", [{ sku: "SKU-001", quantity: 2 }]);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "IDEMPOTENCY_CONFLICT");

  const outOfStock = await checkout(app, "too-many", [{ sku: "SKU-003", quantity: 3 }]);
  assert.equal(outOfStock.statusCode, 409);
  assert.equal(outOfStock.json().code, "OUT_OF_STOCK");
  const unknown = await checkout(app, "unknown-sku", [{ sku: "SKU-999", quantity: 1 }]);
  assert.equal(unknown.statusCode, 422);
});

test("failed multi-item checkout rolls back every reservation and order row", async () => {
  const { app, database } = await makeFixture();
  const response = await checkout(app, "rollback-order", [
    { sku: "SKU-001", quantity: 1 },
    { sku: "SKU-003", quantity: 99 },
  ]);
  assert.equal(response.statusCode, 409);
  assert.equal(queryRow<{ count: number }>(database, "SELECT COUNT(*) AS count FROM orders").count, 0);
  assert.equal(queryRow<{ count: number }>(database, "SELECT COUNT(*) AS count FROM reservations").count, 0);
  assert.equal(queryRow<{ reserved: number }>(database, "SELECT reserved FROM stock_positions WHERE sku = 'SKU-001'").reserved, 0);
});

test("100 concurrent checkouts cannot reserve more than the ten available units", async () => {
  const { app, database } = await makeFixture();
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    checkout(app, `last-unit-${index}`, [{ sku: "SKU-001", quantity: 1 }]),
  ));

  assert.equal(results.filter((result) => result.statusCode === 202).length, 10);
  assert.equal(queryRow<{ count: number }>(database, "SELECT COUNT(*) AS count FROM orders").count, 10);
  assert.equal(queryRow<{ count: number }>(database, "SELECT SUM(reserved) AS count FROM stock_positions").count, 10);
  assert.equal(queryRow<{ quantity: number }>(database, "SELECT MIN(on_hand - reserved) AS quantity FROM stock_positions").quantity >= 0, true);
});
