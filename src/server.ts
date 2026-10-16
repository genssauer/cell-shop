import { loadConfig } from "./config.js";
import { createDatabase } from "./infrastructure/database.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { startTelemetry } from "./infrastructure/tracing.js";
import { BillingWorker } from "./billing/worker.js";
import { MockErpGateway } from "./billing/erp-gateway.js";

const config = loadConfig();
const database = createDatabase(config.databasePath);
const telemetry = await startTelemetry(config);
const { buildApp } = await import("./app.js");
const app = await buildApp({ config, database, closeDatabaseOnClose: false });
const billingWorker = new BillingWorker(
  new SqliteStore(database),
  new MockErpGateway(),
  app.metrics,
  { pollIntervalMs: config.workerPollIntervalMs },
  app.log,
);
app.addHook("onClose", async () => billingWorker.stop());

try {
  await billingWorker.start();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info({ port: config.port }, "server listening");
} catch (error) {
  app.log.error({ error }, "server startup failed");
  await app.close();
  if (database.open) database.close();
  await telemetry.shutdown();
  process.exitCode = 1;
}

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "server shutting down");
  await app.close();
  if (database.open) database.close();
  await telemetry.shutdown();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
