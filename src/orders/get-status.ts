import type { SqliteStore } from "../infrastructure/sqlite-store.js";
import { HttpError } from "../infrastructure/errors.js";

export class GetOrderStatus {
  constructor(private readonly store: SqliteStore) {}

  execute(orderId: string) {
    const order = this.store.getOrderStatus(orderId);
    if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "Pedido não encontrado.");
    return order;
  }
}
