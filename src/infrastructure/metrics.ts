import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "@prometheus-io/client";

export interface AppMetrics {
  registry: Registry;
  catalogCacheRequests: Counter<"result">;
  catalogRefreshDuration: Histogram<string>;
  catalogPriceAge: Gauge<string>;
  checkoutRequests: Counter<"result">;
  stockReservations: Counter<"result">;
  billingQueueDepth: Gauge<string>;
  billingOldestTaskAge: Gauge<string>;
  billingAttempts: Counter<"outcome">;
  erpRequests: Counter<"outcome">;
  erpRequestDuration: Histogram<string>;
  httpRequestDuration: Histogram<"method" | "route" | "status_code">;
}

export function createMetrics(): AppMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: "cellshop-api" });
  collectDefaultMetrics({ register: registry });

  return {
    registry,
    catalogCacheRequests: new Counter({
      name: "catalog_cache_requests_total",
      help: "Catalog cache lookups by result.",
      labelNames: ["result"],
      registers: [registry],
    }),
    catalogRefreshDuration: new Histogram({
      name: "catalog_refresh_duration_seconds",
      help: "Time spent refreshing catalog data from its simulated source.",
      registers: [registry],
    }),
    catalogPriceAge: new Gauge({
      name: "catalog_price_snapshot_age_seconds",
      help: "Age of the latest confirmed catalog price snapshot when the cache is accessed.",
      registers: [registry],
    }),
    checkoutRequests: new Counter({
      name: "checkout_requests_total",
      help: "Checkout requests by outcome.",
      labelNames: ["result"],
      registers: [registry],
    }),
    stockReservations: new Counter({
      name: "stock_reservations_total",
      help: "Stock reservation attempts and transitions by result.",
      labelNames: ["result"],
      registers: [registry],
    }),
    billingQueueDepth: new Gauge({
      name: "billing_queue_depth",
      help: "Number of billing tasks waiting to be processed.",
      registers: [registry],
    }),
    billingOldestTaskAge: new Gauge({
      name: "billing_oldest_task_age_seconds",
      help: "Age of the oldest eligible billing task.",
      registers: [registry],
    }),
    billingAttempts: new Counter({
      name: "billing_attempts_total",
      help: "Billing worker attempts by outcome.",
      labelNames: ["outcome"],
      registers: [registry],
    }),
    erpRequests: new Counter({
      name: "erp_requests_total",
      help: "Simulated ERP calls by outcome.",
      labelNames: ["outcome"],
      registers: [registry],
    }),
    erpRequestDuration: new Histogram({
      name: "erp_request_duration_seconds",
      help: "Duration of calls to the simulated ERP.",
      registers: [registry],
    }),
    httpRequestDuration: new Histogram({
      name: "http_server_request_duration_seconds",
      help: "HTTP request duration in seconds.",
      labelNames: ["method", "route", "status_code"],
      registers: [registry],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    }),
  };
}
