import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { FastifyOtelInstrumentation } from "@fastify/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { AppConfig } from "../config.js";

export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
}

export interface TelemetryRuntime {
  shutdown(): Promise<void>;
}

export async function startTelemetry(config: AppConfig): Promise<TelemetryRuntime> {
  if (!config.telemetryEnabled) return { shutdown: async () => undefined };

  const base = config.otlpEndpoint.replace(/\/$/, "");
  const endpoint = base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
  const sdk = new NodeSDK({
    serviceName: config.serviceName,
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyOtelInstrumentation({ registerOnInitialization: true }),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}

export function captureTraceCarrier(): TraceCarrier {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return {
    ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}),
    ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
  };
}

export function contextFromTraceCarrier(carrier: TraceCarrier): Context {
  return propagation.extract(context.active(), carrier);
}

export async function inSpan<T>(
  name: string,
  operation: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  const tracer = trace.getTracer("cellshop-api");
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await operation(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
