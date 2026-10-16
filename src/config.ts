export interface AppConfig {
  port: number;
  databasePath: string;
  catalogTtlMs: number;
  workerPollIntervalMs: number;
  telemetryEnabled: boolean;
  otlpEndpoint: string;
  serviceName: string;
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = positiveInteger("PORT", env.PORT, 3000);
  if (port > 65535) throw new Error("PORT must be between 1 and 65535");

  const telemetryEnabled = env.OTEL_ENABLED === undefined
    ? false
    : env.OTEL_ENABLED.toLowerCase() === "true";
  if (env.OTEL_ENABLED !== undefined && !["true", "false"].includes(env.OTEL_ENABLED.toLowerCase())) {
    throw new Error("OTEL_ENABLED must be true or false");
  }

  return {
    port,
    databasePath: env.DATABASE_PATH?.trim() || "var/app.sqlite",
    catalogTtlMs: positiveInteger("CATALOG_TTL_MS", env.CATALOG_TTL_MS, 30_000),
    workerPollIntervalMs: positiveInteger("WORKER_POLL_INTERVAL_MS", env.WORKER_POLL_INTERVAL_MS, 250),
    telemetryEnabled,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || "http://localhost:4318",
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "cellshop-api",
  };
}
