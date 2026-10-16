import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type SqliteDatabase = InstanceType<typeof Database>;

const seedStock: ReadonlyArray<{ sku: string; quantity: number }> = [
  { sku: "SKU-001", quantity: 10 },
  { sku: "SKU-002", quantity: 5 },
  { sku: "SKU-003", quantity: 2 },
];

export function createDatabase(databasePath: string): SqliteDatabase {
  if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });

  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");

  const schemaPath = resolve(process.cwd(), "src/infrastructure/schema.sql");
  database.exec(readFileSync(schemaPath, "utf8"));

  const now = new Date().toISOString();
  const insert = database.prepare(`
    INSERT INTO stock_positions (sku, on_hand, reserved, updated_at)
    VALUES (@sku, @quantity, 0, @now)
    ON CONFLICT(sku) DO NOTHING
  `);
  const seed = database.transaction(() => {
    for (const item of seedStock) insert.run({ ...item, now });
  });
  seed();
  return database;
}
