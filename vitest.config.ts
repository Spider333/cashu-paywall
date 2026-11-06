import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// One D1 database per spec file that needs global state (pot totals), so parallel files can't disturb each other.
const DBS = ["DB", "DB_MELT", "DB_REC", "DB_LOG", "DB_MCP", "DB_402", "DB_LN", "DB_TOP", "DB_REF"];

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  const live = process.env.TESTNUT === "1";
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-08-22",
          d1Databases: DBS,
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_DBS: DBS,
            MIGRATION_FILE_SQL: readFileSync("migrations/0001_init.sql", "utf8"),
            ROLLBACK_SQL: readFileSync("sql/drop-all.sql", "utf8"),
            TESTNUT: live ? "1" : "0",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["test/setup.ts"],
      include: live ? ["test/testnut/**/*.spec.ts"] : ["test/*.spec.ts"],
      testTimeout: live ? 120_000 : 20_000,
      hookTimeout: 120_000,
    },
  };
});
