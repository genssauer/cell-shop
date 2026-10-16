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

async function makeApp(source: MockCatalogSource, ttlMs = 30_000): Promise<FastifyInstance> {
  const config = { ...loadConfig({ DATABASE_PATH: ":memory:", OTEL_ENABLED: "false" }), catalogTtlMs: ttlMs };
  const app = await buildApp({ config, database: createDatabase(":memory:"), catalogSource: source, logger: false });
  await app.ready();
  runningApps.push(app);
  return app;
}

test("GET /products returns current prices and stock outside the price cache", async () => {
  const source = new MockCatalogSource();
  const app = await makeApp(source);

  const response = await app.inject({ method: "GET", url: "/products" });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    products: Array<{ productId: string; sku: string; price: { currency: string; amountCents: number }; availableQuantity: number; priceAsOf: string }>;
    asOf: string;
  };
  assert.equal(body.products[0]?.productId, "product-001");
  assert.equal(body.products[0]?.sku, "SKU-001");
  assert.equal(body.products[0]?.price.currency, "BRL");
  assert.equal(body.products[0]?.price.amountCents, 12990);
  assert.equal(body.products[0]?.availableQuantity, 10);
  assert.ok(Number.isFinite(Date.parse(body.products[0]?.priceAsOf ?? "")));
  assert.ok(Number.isFinite(Date.parse(body.asOf)));
  assert.equal(source.calls, 1);
});

test("catalog refreshes after its TTL and shares a concurrent refresh", async () => {
  const source = new MockCatalogSource({ delayMs: 20 });
  const app = await makeApp(source, 10);

  const first = await app.inject({ method: "GET", url: "/products" });
  const hit = await app.inject({ method: "GET", url: "/products" });
  assert.equal(first.statusCode, 200);
  assert.equal(hit.statusCode, 200);
  assert.equal(source.calls, 1);

  await new Promise((resolve) => setTimeout(resolve, 15));
  const concurrent = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: "GET", url: "/products" })));
  assert.ok(concurrent.every((response) => response.statusCode === 200));
  assert.equal(source.calls, 2);
});

test("expired prices are not returned when the catalog source is unavailable", async () => {
  const source = new MockCatalogSource();
  const app = await makeApp(source, 10);

  assert.equal((await app.inject({ method: "GET", url: "/products" })).statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 15));
  source.setUnavailable(true);

  const response = await app.inject({ method: "GET", url: "/products" });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(source.calls, 2);
});
