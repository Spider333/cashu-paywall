import type { Ctx } from "../core/context.js";
import { hostOf } from "../core/context.js";
import { potByMint } from "../core/store.js";
import { meltMint } from "./melt.js";
import { recoverStuckOps } from "./recovery.js";

export interface CronReport {
  recovered: number;
  melted: Array<{ mint: string; amountSats: number; feeSats: number; opId: string }>;
  skipped: Array<{ mint: string; reason: string }>;
  invariantOk: boolean;
  deletedEmptyKeys: number;
}

/** The daily job (melt + cleanup). Any other cron string runs recovery and the invariant check only. */
export const DAILY_CRON = "0 3 * * *";
const EMPTY_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function runScheduled(ctx: Ctx, controller: { cron: string; scheduledTime: number }): Promise<CronReport> {
  const report: CronReport = { recovered: 0, melted: [], skipped: [], invariantOk: true, deletedEmptyKeys: 0 };
  report.recovered = await recoverStuckOps(ctx);

  // Invariant: for every mint, proofs held (unspent + reserved) >= balances owed to keys bound to it.
  const pot = await potByMint(ctx);
  for (const [mint, p] of pot) {
    if (p.held < p.owed) {
      report.invariantOk = false;
      ctx.log.error("ecash_invariant_broken", { mint_host: hostOf(mint), held: p.held, owed: p.owed });
    }
  }

  if (controller.cron === DAILY_CRON) {
    for (const mint of ctx.mints) {
      if (!report.invariantOk) {
        report.skipped.push({ mint, reason: "invariant broken: melts skipped" });
        continue;
      }
      const p = pot.get(mint) ?? { held: 0, unspent: 0, owed: 0 };
      const r = await meltMint(ctx, mint, p.unspent, p.owed);
      if ("melted" in r) report.melted.push(r.melted);
      else {
        report.skipped.push(r.skipped);
        ctx.log.info("ecash_melt_skipped", { mint_host: hostOf(mint), reason: r.skipped.reason });
      }
    }
    const del = await ctx.db
      .prepare(
        `DELETE FROM ecash_keys WHERE credited_total = 0 AND balance = 0 AND created_at < ?1
           AND NOT EXISTS (SELECT 1 FROM ecash_ops o WHERE o.key_hash = ecash_keys.key_hash AND o.status = 'pending')`,
      )
      .bind(ctx.now() - EMPTY_KEY_TTL_MS)
      .run();
    report.deletedEmptyKeys = del.meta.changes;
  }
  ctx.log.info("ecash_cron", {
    cron: controller.cron, recovered: report.recovered, melted: report.melted.length, invariant_ok: report.invariantOk,
    deleted_empty_keys: report.deletedEmptyKeys,
  });
  return report;
}
