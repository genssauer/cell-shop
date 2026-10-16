import assert from "node:assert/strict";
import { test } from "node:test";
import { context, trace, type SpanContext } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BillingWorker } from "../src/billing/worker.js";
import type { ErpGateway, ErpOutcome, InvoiceStatus } from "../src/billing/erp-gateway.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database.js";
import { SqliteStore } from "../src/infrastructure/sqlite-store.js";

class TraceCapturingGateway implements ErpGateway {
  activeSpanContext: SpanContext | undefined;

  async createInvoice(_orderId: string): Promise<ErpOutcome> {
    this.activeSpanContext = trace.getSpan(context.active())?.spanContext();
    return { kind: "success" };
  }

  async lookupInvoice(_orderId: string): Promise<InvoiceStatus> {
    return "NOT_FOUND";
  }
}

test("checkout trace context continues through the persisted billing task to the worker", async () => {
  const sdk = new NodeSDK({
    serviceName: "cellshop-trace-test",
    traceExporter: {
      export(_spans, resultCallback) {
        resultCallback({ code: 0 });
      },
      shutdown: async () => undefined,
      forceFlush: async () => undefined,
    },
  });
  await sdk.start();
  const database = createDatabase(":memory:");
  const app = await buildApp({
    config: loadConfig({ DATABASE_PATH: ":memory:", OTEL_ENABLED: "false" }),
    database,
    logger: false,
  });

  try {
    await app.ready();
    const requestSpan = trace.getTracer("cellshop-test").startSpan("checkout.request");
    const requestTraceId = requestSpan.spanContext().traceId;
    let orderId = "";

    await context.with(trace.setSpan(context.active(), requestSpan), async () => {
      const response = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { "idempotency-key": "trace-propagation" },
        payload: { items: [{ sku: "SKU-001", quantity: 1 }] },
      });
      assert.equal(response.statusCode, 202);
      orderId = response.json().orderId as string;
    });
    requestSpan.end();

    const task = database.prepare(`
      SELECT traceparent FROM billing_tasks WHERE order_id = ?
    `).get(orderId) as { traceparent: string | null };
    assert.ok(task.traceparent);
    assert.equal(task.traceparent.split("-")[1], requestTraceId);

    const gateway = new TraceCapturingGateway();
    const worker = new BillingWorker(new SqliteStore(database), gateway, app.metrics, {
      retryDelaysMs: [0],
      reconciliationDelayMs: 0,
    });
    assert.equal(await worker.processNext(), true);
    assert.equal(gateway.activeSpanContext?.traceId, requestTraceId);
  } finally {
    await app.close();
    await sdk.shutdown();
  }
});
