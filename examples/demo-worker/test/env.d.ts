import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as DemoEnv } from "../src/paywall";

declare global {
  namespace Cloudflare {
    interface Env extends DemoEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
export {};
