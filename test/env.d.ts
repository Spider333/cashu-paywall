import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      DB_MELT: D1Database;
      DB_REC: D1Database;
      DB_LOG: D1Database;
      DB_MCP: D1Database;
      DB_402: D1Database;
      DB_LN: D1Database;
      DB_TOP: D1Database;
      DB_REF: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      TEST_DBS: string[];
      MIGRATION_FILE_SQL: string;
      ROLLBACK_SQL: string;
      TESTNUT: string;
    }
  }
}
export {};
