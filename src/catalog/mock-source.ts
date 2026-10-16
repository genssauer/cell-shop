export interface CatalogProduct {
  productId: string;
  sku: string;
  name: string;
  priceAmountCents: number;
  currency: "BRL";
}

export interface CatalogSource {
  fetchCatalog(): Promise<CatalogProduct[]>;
}

const products: CatalogProduct[] = [
  { productId: "product-001", sku: "SKU-001", name: "Smartphone CellShop One", priceAmountCents: 12990, currency: "BRL" },
  { productId: "product-002", sku: "SKU-002", name: "Fone Bluetooth CellShop", priceAmountCents: 2990, currency: "BRL" },
  { productId: "product-003", sku: "SKU-003", name: "Carregador USB-C CellShop", priceAmountCents: 1590, currency: "BRL" },
];

export interface MockCatalogSourceOptions {
  delayMs?: number;
}

export class MockCatalogSource implements CatalogSource {
  calls = 0;
  private unavailable = false;

  constructor(private readonly options: MockCatalogSourceOptions = {}) {}

  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  async fetchCatalog(): Promise<CatalogProduct[]> {
    this.calls += 1;
    if ((this.options.delayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
    if (this.unavailable) throw new Error("simulated_catalog_unavailable");
    return products.map((product) => ({ ...product }));
  }
}
