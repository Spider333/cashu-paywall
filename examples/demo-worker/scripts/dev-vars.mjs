// Writes .dev.vars with FRESH random demo secrets for local `wrangler dev`. Never prints them. Refuses to overwrite.
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const path = new URL("../.dev.vars", import.meta.url);
if (existsSync(path)) {
  console.log(".dev.vars already exists; leaving it alone (it may hold a seed you need).");
  process.exit(0);
}
const lines = [
  `ECASH_KEY_PEPPER=${randomBytes(32).toString("hex")}`,
  `ECASH_PROOF_KEY=${randomBytes(32).toString("base64")}`,
  `ECASH_WALLET_SEED=${randomBytes(64).toString("hex")}`,
];
writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
console.log(
  "Wrote .dev.vars (mode 600) with fresh local secrets. Back up the seed before this demo ever accepts a real mint.",
);
