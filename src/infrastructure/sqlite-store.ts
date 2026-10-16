import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.js";
import { HttpError } from "./errors.js";
import type { TraceCarrier } from "./tracing.js";

export interface CheckoutItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface StoredOrder {
  id: string;
  requestHash: string;
  status: "PROCESSING" | "COMPLETED" | "FAILED";
}

export interface CreateCheckoutCommand {
  idempotencyKey: string;
  requestHash: string;
  items: CheckoutItem[];
  trace: TraceCarrier;
}

export interface CreatedOrder {
  orderId: string;
  status: StoredOrder["status"];
  replayed: boolean;
}

export type BillingTaskState = "PENDING" | "PROCESSING" | "RETRY_WAIT" | "RECONCILIATION" | "COMPLETED" | "DEAD_LETTER";

export interface ClaimedBillingTask {
  taskId: string;
  orderId: string;
  previousState: "PENDING" | "PROCESSING" | "RETRY_WAIT" | "RECONCILIATION";
  attemptCount: number;
  traceparent: string | null;
  tracestate: string | null;
}

export interface QueueStats {
  depth: number;
  oldestTaskAgeSeconds: number;
}

interface ExistingOrderRow {
  id: string;
  request_hash: string;
  status: StoredOrder["status"];
}

interface BillingTaskRow {
  id: string;
  order_id: string;
  state: "PENDING" | "PROCESSING" | "RETRY_WAIT" | "RECONCILIATION";
  attempt_count: number;
  traceparent: string | null;
  tracestate: string | null;
}

interface ReservationRow {
  id: string;
  sku: string;
  quantity: number;
}

export class SqliteStore {
  constructor(readonly database: SqliteDatabase) {}

  findOrderByIdempotencyKey(key: string): StoredOrder | undefined {
    const row = this.database.prepare(`
      SELECT id, request_hash, status FROM orders WHERE idempotency_key = ?
    `).get(key) as ExistingOrderRow | undefined;
    if (!row) return undefined;
    return { id: row.id, requestHash: row.request_hash, status: row.status };
  }

  getOrderStatus(orderId: string): { orderId: string; status: StoredOrder["status"]; updatedAt: string } | undefined {
    const row = this.database.prepare(`
      SELECT id, status, updated_at FROM orders WHERE id = ?
    `).get(orderId) as { id: string; status: StoredOrder["status"]; updated_at: string } | undefined;
    return row ? { orderId: row.id, status: row.status, updatedAt: row.updated_at } : undefined;
  }

  recoverProcessingTasks(now = new Date()): number {
    const timestamp = now.toISOString();
    const result = this.database.prepare(`
      UPDATE billing_tasks
      SET state = 'RECONCILIATION', available_at = ?, lease_until = NULL, updated_at = ?
      WHERE state = 'PROCESSING'
    `).run(timestamp, timestamp);
    return result.changes;
  }

  claimNextBillingTask(now = new Date(), leaseMs = 30_000): ClaimedBillingTask | undefined {
    const timestamp = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const claim = this.database.transaction((): ClaimedBillingTask | undefined => {
      const row = this.database.prepare(`
        SELECT id, order_id, state, attempt_count, traceparent, tracestate
        FROM billing_tasks
        WHERE state IN ('PENDING', 'RETRY_WAIT', 'RECONCILIATION') AND available_at <= ?
        ORDER BY available_at, created_at
        LIMIT 1
      `).get(timestamp) as BillingTaskRow | undefined;
      if (!row) return undefined;

      const nextAttempt = row.attempt_count + (row.state === "RECONCILIATION" ? 0 : 1);
      this.database.prepare(`
        UPDATE billing_tasks
        SET state = 'PROCESSING', attempt_count = ?, lease_until = ?, updated_at = ?
        WHERE id = ?
      `).run(nextAttempt, leaseUntil, timestamp, row.id);
      return {
        taskId: row.id,
        orderId: row.order_id,
        previousState: row.state,
        attemptCount: nextAttempt,
        traceparent: row.traceparent,
        tracestate: row.tracestate,
      };
    });
    return claim.immediate();
  }

  incrementBillingAttempt(taskId: string, now = new Date(), leaseMs = 30_000): number {
    const timestamp = now.toISOString();
    this.database.prepare(`
      UPDATE billing_tasks
      SET attempt_count = attempt_count + 1, lease_until = ?, updated_at = ?
      WHERE id = ? AND state = 'PROCESSING'
    `).run(new Date(now.getTime() + leaseMs).toISOString(), timestamp, taskId);
    const row = this.database.prepare("SELECT attempt_count FROM billing_tasks WHERE id = ?").get(taskId) as { attempt_count: number };
    return row.attempt_count;
  }

  scheduleBillingRetry(taskId: string, availableAt: Date, errorCode: string): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE billing_tasks
      SET state = 'RETRY_WAIT', available_at = ?, lease_until = NULL, last_error_code = ?, updated_at = ?
      WHERE id = ? AND state = 'PROCESSING'
    `).run(availableAt.toISOString(), errorCode, now, taskId);
  }

  scheduleReconciliation(taskId: string, availableAt: Date, errorCode: string): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE billing_tasks
      SET state = 'RECONCILIATION', available_at = ?, lease_until = NULL, last_error_code = ?, updated_at = ?
      WHERE id = ? AND state = 'PROCESSING'
    `).run(availableAt.toISOString(), errorCode, now, taskId);
  }

  completeBilling(orderId: string): number {
    const now = new Date().toISOString();
    const complete = this.database.transaction(() => {
      const reservations = this.database.prepare(`
        SELECT id, sku, quantity FROM reservations WHERE order_id = ? AND state = 'RESERVED'
      `).all(orderId) as ReservationRow[];
      const decrementStock = this.database.prepare(`
        UPDATE stock_positions
        SET on_hand = on_hand - @quantity, reserved = reserved - @quantity, updated_at = @now
        WHERE sku = @sku AND on_hand >= @quantity AND reserved >= @quantity
      `);
      const confirmReservation = this.database.prepare(`
        UPDATE reservations SET state = 'CONFIRMED', updated_at = ? WHERE id = ? AND state = 'RESERVED'
      `);
      for (const reservation of reservations) {
        const changed = decrementStock.run({ ...reservation, now });
        if (changed.changes !== 1) throw new Error("stock_reservation_invariant_failed");
        confirmReservation.run(now, reservation.id);
      }
      this.database.prepare(`
        UPDATE billing_tasks SET state = 'COMPLETED', lease_until = NULL, last_error_code = NULL, updated_at = ?
        WHERE order_id = ? AND state = 'PROCESSING'
      `).run(now, orderId);
      this.database.prepare(`
        UPDATE orders SET status = 'COMPLETED', updated_at = ? WHERE id = ? AND status = 'PROCESSING'
      `).run(now, orderId);
      return reservations.reduce((total, reservation) => total + reservation.quantity, 0);
    });
    return complete.immediate();
  }

  failBilling(orderId: string, errorCode: string): number {
    const now = new Date().toISOString();
    const fail = this.database.transaction(() => {
      const reservations = this.database.prepare(`
        SELECT id, sku, quantity FROM reservations WHERE order_id = ? AND state = 'RESERVED'
      `).all(orderId) as ReservationRow[];
      const releaseStock = this.database.prepare(`
        UPDATE stock_positions SET reserved = reserved - @quantity, updated_at = @now
        WHERE sku = @sku AND reserved >= @quantity
      `);
      const releaseReservation = this.database.prepare(`
        UPDATE reservations SET state = 'RELEASED', updated_at = ? WHERE id = ? AND state = 'RESERVED'
      `);
      for (const reservation of reservations) {
        const changed = releaseStock.run({ ...reservation, now });
        if (changed.changes !== 1) throw new Error("stock_reservation_invariant_failed");
        releaseReservation.run(now, reservation.id);
      }
      this.database.prepare(`
        UPDATE billing_tasks SET state = 'DEAD_LETTER', lease_until = NULL, last_error_code = ?, updated_at = ?
        WHERE order_id = ? AND state = 'PROCESSING'
      `).run(errorCode, now, orderId);
      this.database.prepare(`
        UPDATE orders SET status = 'FAILED', updated_at = ? WHERE id = ? AND status = 'PROCESSING'
      `).run(now, orderId);
      return reservations.reduce((total, reservation) => total + reservation.quantity, 0);
    });
    return fail.immediate();
  }

  getQueueStats(now = new Date()): QueueStats {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS depth, MIN(created_at) AS oldest_created_at
      FROM billing_tasks
      WHERE state IN ('PENDING', 'PROCESSING', 'RETRY_WAIT', 'RECONCILIATION')
    `).get() as { depth: number; oldest_created_at: string | null };
    const oldest = row.oldest_created_at ? Date.parse(row.oldest_created_at) : now.getTime();
    return {
      depth: row.depth,
      oldestTaskAgeSeconds: Math.max(0, (now.getTime() - oldest) / 1000),
    };
  }

  createCheckout(command: CreateCheckoutCommand): CreatedOrder {
    const timestamp = new Date().toISOString();
    const create = this.database.transaction((input: CreateCheckoutCommand): CreatedOrder => {
      const existing = this.findOrderByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "A chave de idempotência já foi usada com outro conteúdo.");
        }
        return { orderId: existing.id, status: existing.status, replayed: true };
      }

      const orderId = randomUUID();
      this.database.prepare(`
        INSERT INTO orders (id, idempotency_key, request_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, 'PROCESSING', ?, ?)
      `).run(orderId, input.idempotencyKey, input.requestHash, timestamp, timestamp);

      const reserveStock = this.database.prepare(`
        UPDATE stock_positions
        SET reserved = reserved + @quantity, updated_at = @timestamp
        WHERE sku = @sku AND on_hand - reserved >= @quantity
      `);
      const insertItem = this.database.prepare(`
        INSERT INTO order_items (order_id, sku, quantity, unit_price_cents)
        VALUES (@orderId, @sku, @quantity, @unitPriceCents)
      `);
      const insertReservation = this.database.prepare(`
        INSERT INTO reservations (id, order_id, sku, quantity, state, created_at, updated_at)
        VALUES (@id, @orderId, @sku, @quantity, 'RESERVED', @timestamp, @timestamp)
      `);

      for (const item of input.items) {
        const updated = reserveStock.run({ ...item, timestamp });
        if (updated.changes !== 1) {
          throw new HttpError(409, "OUT_OF_STOCK", `Estoque insuficiente para o SKU ${item.sku}.`);
        }
        insertItem.run({ orderId, ...item });
        insertReservation.run({ id: randomUUID(), orderId, ...item, timestamp });
      }

      this.database.prepare(`
        INSERT INTO billing_tasks (
          id, order_id, state, attempt_count, available_at, traceparent, tracestate, created_at, updated_at
        ) VALUES (?, ?, 'PENDING', 0, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        orderId,
        timestamp,
        input.trace.traceparent ?? null,
        input.trace.tracestate ?? null,
        timestamp,
        timestamp,
      );

      return { orderId, status: "PROCESSING", replayed: false };
    });

    return create.immediate(command);
  }
}
