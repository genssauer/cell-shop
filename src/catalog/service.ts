import type { SqliteDatabase } from "../infrastructure/database.js";
import { HttpError } from "../infrastructure/errors.js";
import { inSpan } from "../infrastructure/tracing.js";
import type { CatalogCache } from "./cache.js";

export interface CatalogProductResponse {
  productId: string;
  sku: string;
  name: string;
  price: { currency: "BRL"; amountCents: number };
  availableQuantity: number;
  priceAsOf: string;
}

export interface CatalogResponse {
  products: CatalogProductResponse[];
  asOf: string;
}

interface StockRow {
  sku: string;
  availableQuantity: number;
}

export class CatalogService {
  constructor(private readonly cache: CatalogCache, private readonly database: SqliteDatabase) {}

  async listProducts(): Promise<CatalogResponse> {
    const snapshot = await this.cache.get();
    const stock = await inSpan("catalog.stock.read", async () => {
      try {
        return this.database.prepare(`
          SELECT sku, on_hand - reserved AS availableQuantity
          FROM stock_positions
        `).all() as StockRow[];
      } catch {
        throw new HttpError(503, "STOCK_UNAVAILABLE", "Não foi possível confirmar o estoque atual.");
      }
    });
    const bySku = new Map(stock.map((row) => [row.sku, row.availableQuantity]));

    return {
      asOf: snapshot.asOf,
      products: snapshot.products.map((product) => ({
        productId: product.productId,
        sku: product.sku,
        name: product.name,
        price: { currency: product.currency, amountCents: product.priceAmountCents },
        availableQuantity: bySku.get(product.sku) ?? 0,
        priceAsOf: product.priceAsOf,
      })),
    };
  }
}
