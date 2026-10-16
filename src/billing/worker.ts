import { context, type Span } from "@opentelemetry/api";
import type { FastifyBaseLogger } from "fastify";
import { performance } from "node:perf_hooks";
import type { AppMetrics } from "../infrastructure/metrics.js";
import {
  contextFromTraceCarrier,
  inSpan,
} from "../infrastructure/tracing.js";
import type { ClaimedBillingTask, SqliteStore } from "../infrastructure/sqlite-store.js";
import type { ErpGateway, ErpOutcome, InvoiceStatus } from "./erp-gateway.js";

export interface BillingWorkerOptions {
  retryDelaysMs?: number[];
  reconciliationDelayMs?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  now?: () => Date;
}

const defaultRetryDelays = [1_000, 2_000, 4_000];

export class BillingWorker {
  private readonly retryDelaysMs: number[];
  private readonly reconciliationDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeRun: Promise<boolean> | undefined;

  constructor(
    private readonly store: SqliteStore,
    private readonly gateway: ErpGateway,
    private readonly metrics: AppMetrics,
    options: BillingWorkerOptions = {},
    private readonly logger?: FastifyBaseLogger,
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelays;
    this.reconciliationDelayMs = options.reconciliationDelayMs ?? 5_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
  }

  async recover(): Promise<number> {
    const recovered = this.store.recoverProcessingTasks(this.now());
    this.refreshQueueMetrics();
    this.logger?.info({ operation: "billing.recovery", result: "completed", recovered }, "billing tasks recovered");
    return recovered;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.recover();
    void this.processNext().catch((error: unknown) => {
      this.logger?.error({ operation: "billing.worker", result: "error", error }, "billing worker iteration failed");
    });
    this.timer = setInterval(() => {
      void this.processNext().catch((error: unknown) => {
        this.logger?.error({ operation: "billing.worker", result: "error", error }, "billing worker iteration failed");
      });
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.activeRun) await this.activeRun;
  }

  processNext(): Promise<boolean> {
    if (this.activeRun) return this.activeRun;
    const run = this.processNextInternal();
    this.activeRun = run;
    return run.finally(() => {
      if (this.activeRun === run) this.activeRun = undefined;
    });
  }

  private async processNextInternal(): Promise<boolean> {
    let task: ClaimedBillingTask | undefined;
    try {
      const claimedTask = this.store.claimNextBillingTask(this.now(), this.leaseMs);
      if (!claimedTask) return false;
      task = claimedTask;
      const carrier = {
        ...(claimedTask.traceparent ? { traceparent: claimedTask.traceparent } : {}),
        ...(claimedTask.tracestate ? { tracestate: claimedTask.tracestate } : {}),
      };
      await context.with(contextFromTraceCarrier(carrier), () => inSpan(
        "billing.process_order",
        async (span) => {
          span.setAttribute("order.id", claimedTask.orderId);
          const traceId = span.spanContext().traceId;
          this.logger?.info({
            operation: "billing.process_order",
            result: "started",
            orderId: claimedTask.orderId,
            ...(traceId && !/^0+$/.test(traceId) ? { traceId } : {}),
          }, "billing task started");
          if (claimedTask.previousState === "RECONCILIATION") await this.reconcile(claimedTask, span);
          else await this.submit(claimedTask, span);
        },
        { "order.id": claimedTask.orderId },
      ));
      return true;
    } catch (error) {
      if (task) {
        try {
          this.store.scheduleReconciliation(task.taskId, this.after(this.reconciliationDelayMs), "worker_result_unknown");
        } catch {
          // The lease remains as durable evidence for recovery on the next process start.
        }
        this.logger?.error({ operation: "billing.process_order", result: "unknown", orderId: task.orderId }, "billing task moved to reconciliation");
      }
      throw error;
    } finally {
      this.refreshQueueMetrics();
    }
  }

  private async reconcile(task: ClaimedBillingTask, span: Span): Promise<void> {
    const result = await this.callErp("lookup_unknown", () => this.gateway.lookupInvoice(task.orderId));
    span.setAttribute("erp.lookup_result", result);
    switch (result) {
      case "SUCCEEDED":
        this.complete(task.orderId);
        return;
      case "FAILED":
        this.fail(task.orderId, "erp_definitive_failure");
        return;
      case "NOT_FOUND": {
        const attemptCount = this.store.incrementBillingAttempt(task.taskId, this.now(), this.leaseMs);
        await this.submit({ ...task, attemptCount }, span);
        return;
      }
      case "UNKNOWN":
        this.metrics.billingAttempts.inc({ outcome: "reconciliation_unknown" });
        this.store.scheduleReconciliation(task.taskId, this.after(this.reconciliationDelayMs), "erp_result_unknown");
        this.logger?.warn({ operation: "billing.reconciliation", result: "unknown", orderId: task.orderId }, "ERP result remains unknown");
        return;
    }
  }

  private async submit(task: ClaimedBillingTask, span: Span): Promise<void> {
    const outcome = await this.callErp<ErpOutcome>("unknown", async () => {
      try {
        return await this.gateway.createInvoice(task.orderId);
      } catch {
        return { kind: "unknown", invoiceCreated: false };
      }
    });
    span.setAttribute("erp.submit_result", outcome.kind);
    this.metrics.billingAttempts.inc({ outcome: outcome.kind });
    switch (outcome.kind) {
      case "success":
        this.complete(task.orderId);
        return;
      case "definitive":
        this.fail(task.orderId, outcome.code ?? "erp_definitive_failure");
        return;
      case "transient":
        if (task.attemptCount >= this.retryDelaysMs.length) {
          this.fail(task.orderId, outcome.code ?? "erp_retries_exhausted");
          return;
        }
        this.store.scheduleBillingRetry(
          task.taskId,
          this.after(this.retryDelaysMs[Math.max(0, task.attemptCount - 1)] ?? 0),
          outcome.code ?? "erp_transient_failure",
        );
        this.logger?.warn({ operation: "billing.retry", result: "scheduled", orderId: task.orderId, attempt: task.attemptCount }, "billing retry scheduled");
        return;
      case "unknown":
        this.metrics.billingAttempts.inc({ outcome: "reconciliation_required" });
        this.store.scheduleReconciliation(task.taskId, this.after(this.reconciliationDelayMs), "erp_result_unknown");
        this.logger?.warn({ operation: "billing.reconciliation", result: "scheduled", orderId: task.orderId }, "billing result requires reconciliation");
        return;
    }
  }

  private async callErp<T extends ErpOutcome | InvoiceStatus>(fallback: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await operation();
      const outcome = typeof result === "string" ? `lookup_${result.toLowerCase()}` : result.kind;
      this.metrics.erpRequests.inc({ outcome });
      return result;
    } catch (error) {
      this.metrics.erpRequests.inc({ outcome: fallback });
      throw error;
    } finally {
      this.metrics.erpRequestDuration.observe((performance.now() - startedAt) / 1000);
    }
  }

  private complete(orderId: string): void {
    const quantity = this.store.completeBilling(orderId);
    if (quantity > 0) this.metrics.stockReservations.inc({ result: "confirmed" }, quantity);
    this.logger?.info({ operation: "billing.process_order", result: "completed", orderId }, "order billing confirmed");
  }

  private fail(orderId: string, errorCode: string): void {
    const quantity = this.store.failBilling(orderId, errorCode);
    if (quantity > 0) this.metrics.stockReservations.inc({ result: "released" }, quantity);
    this.logger?.warn({ operation: "billing.process_order", result: "failed", orderId, errorCode }, "order billing definitively failed");
  }

  private after(delayMs: number): Date {
    return new Date(this.now().getTime() + Math.max(0, delayMs));
  }

  private refreshQueueMetrics(): void {
    const stats = this.store.getQueueStats(this.now());
    this.metrics.billingQueueDepth.set(stats.depth);
    this.metrics.billingOldestTaskAge.set(stats.oldestTaskAgeSeconds);
  }
}
