import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const hex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export default defineConfig(async () => {
  const migrations = await readD1Migrations("../../migrations");
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Fresh random secrets per run; the rate limiter is replaced by an unlimited stub in tests.
          bindings: {
            ECASH_KEY_PEPPER: hex(32),
            ECASH_PROOF_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
            ECASH_WALLET_SEED: hex(64),
            ECASH_PUBLIC_URL: "https://demo.test",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { setupFiles: ["test/setup.ts"], testTimeout: 120_000, hookTimeout: 120_000 },
  };
});
