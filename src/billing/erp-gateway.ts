export type ErpOutcome =
  | { kind: "success" }
  | { kind: "transient"; code?: string }
  | { kind: "definitive"; code?: string }
  | { kind: "unknown"; invoiceCreated: boolean };

export type InvoiceStatus = "SUCCEEDED" | "FAILED" | "NOT_FOUND" | "UNKNOWN";

export interface ErpGateway {
  createInvoice(orderId: string): Promise<ErpOutcome>;
  lookupInvoice(orderId: string): Promise<InvoiceStatus>;
}

export class MockErpGateway implements ErpGateway {
  private readonly outcomes: ErpOutcome[] = [];
  private readonly invoiceStatuses = new Map<string, InvoiceStatus>();
  private readonly billedOrders = new Set<string>();
  readonly submittedOrderIds: string[] = [];
  readonly lookupOrderIds: string[] = [];

  enqueueOutcome(outcome: ErpOutcome): void {
    this.outcomes.push(outcome);
  }

  resolveOrder(orderId: string, status: InvoiceStatus): void {
    this.invoiceStatuses.set(orderId, status);
    if (status === "SUCCEEDED") this.billedOrders.add(orderId);
  }

  invoiceCount(orderId: string): number {
    return this.billedOrders.has(orderId) ? 1 : 0;
  }

  async createInvoice(orderId: string): Promise<ErpOutcome> {
    this.submittedOrderIds.push(orderId);
    if (this.billedOrders.has(orderId)) return { kind: "success" };

    const outcome = this.outcomes.shift() ?? { kind: "success" as const };
    switch (outcome.kind) {
      case "success":
        this.billedOrders.add(orderId);
        this.invoiceStatuses.set(orderId, "SUCCEEDED");
        break;
      case "transient":
        this.invoiceStatuses.set(orderId, "NOT_FOUND");
        break;
      case "definitive":
        this.invoiceStatuses.set(orderId, "FAILED");
        break;
      case "unknown":
        if (outcome.invoiceCreated) {
          this.billedOrders.add(orderId);
          this.invoiceStatuses.set(orderId, "SUCCEEDED");
        } else {
          this.invoiceStatuses.set(orderId, "UNKNOWN");
        }
        break;
    }
    return outcome;
  }

  async lookupInvoice(orderId: string): Promise<InvoiceStatus> {
    this.lookupOrderIds.push(orderId);
    return this.invoiceStatuses.get(orderId) ?? "NOT_FOUND";
  }
}
