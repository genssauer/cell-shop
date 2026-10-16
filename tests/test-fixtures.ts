import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database.js";

export interface TestFixture {
  app: FastifyInstance;
}

export async function createTestFixture(configOverrides: Partial<AppConfig> = {}): Promise<TestFixture> {
  const config = {
    ...loadConfig({ DATABASE_PATH: ":memory:", OTEL_ENABLED: "false" }),
    ...configOverrides,
  };
  const database = createDatabase(":memory:");
  const app = await buildApp({ config, database, logger: false });
  await app.ready();
  return { app };
}

export async function closeTestFixture(fixture: TestFixture): Promise<void> {
  await fixture.app.close();
}
