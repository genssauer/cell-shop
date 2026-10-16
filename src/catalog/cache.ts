import type { AppMetrics } from "../infrastructure/metrics.js";
import { HttpError } from "../infrastructure/errors.js";
import { inSpan } from "../infrastructure/tracing.js";
import type { CatalogProduct, CatalogSource } from "./mock-source.js";

export interface CatalogEntry extends CatalogProduct {
  priceAsOf: string;
}

export interface CatalogSnapshot {
  products: CatalogEntry[];
  asOf: string;
}

export class CatalogCache {
  private snapshot: CatalogSnapshot | undefined;
  private expiresAt = 0;
  private refreshInFlight: Promise<CatalogSnapshot> | undefined;

  constructor(
    private readonly source: CatalogSource,
    private readonly ttlMs: number,
    private readonly metrics: AppMetrics,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<CatalogSnapshot> {
    this.updateSnapshotAge();
    if (this.snapshot && this.now() < this.expiresAt) {
      this.metrics.catalogCacheRequests.inc({ result: "hit" });
      return this.snapshot;
    }

    const existingRefresh = this.refreshInFlight;
    this.metrics.catalogCacheRequests.inc({ result: existingRefresh ? "coalesced" : "miss" });
    if (existingRefresh) {
      try {
        return await existingRefresh;
      } catch {
        this.metrics.catalogCacheRequests.inc({ result: "error" });
        throw new HttpError(503, "CATALOG_UNAVAILABLE", "Não foi possível confirmar o preço atual.");
      }
    }

    const refresh = inSpan("catalog.cache.refresh", async () => {
      const startedAt = this.now();
      try {
        const products = await inSpan("catalog.source.fetch", () => this.source.fetchCatalog());
        const asOf = new Date(this.now()).toISOString();
        const snapshot = {
          products: products.map((product) => ({ ...product, priceAsOf: asOf })),
          asOf,
        };
        this.snapshot = snapshot;
        this.expiresAt = this.now() + this.ttlMs;
        this.updateSnapshotAge();
        return snapshot;
      } catch {
        this.metrics.catalogCacheRequests.inc({ result: "error" });
        throw new HttpError(503, "CATALOG_UNAVAILABLE", "Não foi possível confirmar o preço atual.");
      } finally {
        this.metrics.catalogRefreshDuration.observe(Math.max(0, this.now() - startedAt) / 1000);
      }
    });
    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    }
  }

  private updateSnapshotAge(): void {
    if (this.snapshot) {
      const ageMs = Math.max(0, this.now() - Date.parse(this.snapshot.asOf));
      this.metrics.catalogPriceAge.set(ageMs / 1000);
    }
  }
}
