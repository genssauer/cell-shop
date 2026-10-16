import { createHash } from "node:crypto";
import type { AppMetrics } from "../infrastructure/metrics.js";
import { HttpError } from "../infrastructure/errors.js";
import { captureTraceCarrier, inSpan } from "../infrastructure/tracing.js";
import type { CatalogCache } from "../catalog/cache.js";
import type { SqliteStore } from "../infrastructure/sqlite-store.js";

export interface CheckoutRequestItem {
  sku: string;
  quantity: number;
}

export interface CheckoutResult {
  orderId: string;
  status: "PROCESSING" | "COMPLETED" | "FAILED";
  statusUrl: string;
  replayed: boolean;
}

function normalizeItems(items: CheckoutRequestItem[]): CheckoutRequestItem[] {
  const quantities = new Map<string, number>();
  for (const item of items) {
    const quantity = (quantities.get(item.sku) ?? 0) + item.quantity;
    if (!Number.isSafeInteger(quantity)) {
      throw new HttpError(400, "INVALID_QUANTITY", "A quantidade total excede o limite permitido.");
    }
    quantities.set(item.sku, quantity);
  }
  return [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sku, quantity]) => ({ sku, quantity }));
}

function payloadHash(items: CheckoutRequestItem[]): string {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

export class CreateOrder {
  constructor(
    private readonly store: SqliteStore,
    private readonly catalog: CatalogCache,
    private readonly metrics: AppMetrics,
  ) {}

  async execute(idempotencyKey: string, requestedItems: CheckoutRequestItem[]): Promise<CheckoutResult> {
    const items = normalizeItems(requestedItems);
    const requestHash = payloadHash(items);
    const existing = this.store.findOrderByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        this.metrics.checkoutRequests.inc({ result: "rejected" });
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "A chave de idempotência já foi usada com outro conteúdo.");
      }
      this.metrics.checkoutRequests.inc({ result: "replay" });
      return {
        orderId: existing.id,
        status: existing.status,
        statusUrl: `/orders/${existing.id}/status`,
        replayed: true,
      };
    }

    try {
      return await inSpan("checkout.create_order", async (span) => {
        span.setAttribute("checkout.item_count", items.length);
        const snapshot = await this.catalog.get();
        const products = new Map(snapshot.products.map((product) => [product.sku, product]));
        const pricedItems = items.map((item) => {
          const product = products.get(item.sku);
          if (!product) throw new HttpError(422, "PRODUCT_UNAVAILABLE", `SKU ${item.sku} não está disponível no catálogo.`);
          return { ...item, unitPriceCents: product.priceAmountCents };
        });

        const created = this.store.createCheckout({
          idempotencyKey,
          requestHash,
          items: pricedItems,
          trace: captureTraceCarrier(),
        });
        const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
        if (!created.replayed) this.metrics.stockReservations.inc({ result: "reserved" }, totalQuantity);
        this.metrics.checkoutRequests.inc({ result: created.replayed ? "replay" : "accepted" });
        span.setAttribute("order.id", created.orderId);
        return {
          orderId: created.orderId,
          status: created.status,
          statusUrl: `/orders/${created.orderId}/status`,
          replayed: created.replayed,
        };
      }, { "checkout.item_count": items.length });
    } catch (error) {
      if (error instanceof HttpError && error.code === "OUT_OF_STOCK") {
        this.metrics.stockReservations.inc({ result: "rejected" });
      }
      this.metrics.checkoutRequests.inc({ result: error instanceof HttpError && error.statusCode === 503 ? "unavailable" : "rejected" });
      throw error;
    }
  }
}
