import { applyD1Migrations, env } from "cloudflare:test";

for (const name of env.TEST_DBS) {
  await applyD1Migrations(env[name as "DB"], env.TEST_MIGRATIONS);
}
