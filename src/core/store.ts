// D1 statements (PRD 6.3). Every balance change is one conditional statement or one batch (a transaction).
import type { CounterRange, CounterSource, Proof } from "@cashu/cashu-ts";
import { JSONInt, deserializeProofs, hashToCurve } from "@cashu/cashu-ts";
import type { Ctx } from "./context.js";
import { randomId } from "./crypto.js";

export interface KeyRow {
  key_hash: string;
  kid: string;
  mint_url: string | null;
  balance: number;
  credited_total: number;
  spent_total: number;
  refunded_total: number;
  calls: number;
  status: "active" | "frozen";
  created_at: number;
  last_used_at: number | null;
}

export interface OpRow {
  op_id: string;
  kind: "topup_token" | "topup_lightning" | "refund" | "melt";
  status: "pending" | "done" | "failed";
  key_hash: string | null;
  mint_url: string;
  input_id: string | null;
  amount: number;
  fee: number | null;
  credited: number | null;
  keyset_id: string | null;
  counter_start: number | null;
  counter_count: number | null;
  detail: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProofRow {
  y: string;
  mint_url: string;
  keyset_id: string;
  amount: number;
  sealed: string;
  state: "unspent" | "reserved" | "spent";
  op_id: string | null;
}

/**
 * NUT-13 outputs reserved per operation. With minimal splits (denominationTarget 1) an amount below 2^16 needs at most
 * 16 outputs, so one block holds: send/receive/mint outputs at +0, keep outputs at +KEEP_OFFSET, melt change at +CHANGE_OFFSET.
 */
export const COUNTER_BLOCK = 64;
export const KEEP_OFFSET = 32;
export const CHANGE_OFFSET = 48;

export function sats(a: { toNumber(): number } | number | bigint | string): number {
  const n = typeof a === "object" ? a.toNumber() : Number(a);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("amount out of range");
  return n;
}

export function sumSats(proofs: Array<{ amount: { toNumber(): number } | number }>): number {
  return proofs.reduce((s, p) => s + sats(p.amount), 0);
}

/** Y = hash_to_curve(secret), compressed hex: the public id of a proof (NUT-00, used by NUT-07). */
export function proofY(secret: string): string {
  return hashToCurve(new TextEncoder().encode(secret)).toHex(true);
}

// ---- keys -----------------------------------------------------------------------------------------

export async function getKeyRow(ctx: Ctx, keyHash: string): Promise<KeyRow | null> {
  return ctx.db.prepare("SELECT * FROM ecash_keys WHERE key_hash = ?").bind(keyHash).first<KeyRow>();
}

export function insertKeyStmt(ctx: Ctx, keyHash: string, kid: string, mintUrl: string | null): D1PreparedStatement {
  return ctx.db
    .prepare("INSERT INTO ecash_keys (key_hash, kid, mint_url, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(keyHash, kid, mintUrl, ctx.now());
}

/** Binds an unbound key to a mint (before any swap, so two first top-ups can't race), then re-reads it. */
export async function bindKeyToMint(ctx: Ctx, keyHash: string, mintUrl: string): Promise<KeyRow | null> {
  await ctx.db.prepare("UPDATE ecash_keys SET mint_url = ?1 WHERE key_hash = ?2 AND mint_url IS NULL").bind(mintUrl, keyHash).run();
  return getKeyRow(ctx, keyHash);
}

/** The atomic debit (PRD 6.3). `meta.changes === 1` is the success signal. */
export async function debitStmt(ctx: Ctx, keyHash: string, amount: number): Promise<{ ok: boolean; balance: number | null }> {
  const r = await ctx.db
    .prepare(
      `UPDATE ecash_keys
          SET balance = balance - ?1, spent_total = spent_total + ?1, calls = calls + 1, last_used_at = ?2
        WHERE key_hash = ?3 AND status = 'active' AND balance >= ?1
        RETURNING balance`,
    )
    .bind(amount, ctx.now(), keyHash)
    .all<{ balance: number }>();
  if (r.meta.changes !== 1) return { ok: false, balance: null };
  return { ok: true, balance: r.results[0]?.balance ?? null };
}

// ---- pot ------------------------------------------------------------------------------------------

export async function totalHeld(ctx: Ctx): Promise<number> {
  const r = await ctx.db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ecash_proofs WHERE state != 'spent'").first<{ s: number }>();
  return r?.s ?? 0;
}

export async function potByMint(ctx: Ctx): Promise<Map<string, { held: number; unspent: number; owed: number }>> {
  const held = await ctx.db
    .prepare(
      `SELECT mint_url, COALESCE(SUM(amount), 0) AS held, COALESCE(SUM(CASE WHEN state = 'unspent' THEN amount ELSE 0 END), 0) AS unspent
         FROM ecash_proofs WHERE state != 'spent' GROUP BY mint_url`,
    )
    .all<{ mint_url: string; held: number; unspent: number }>();
  const owed = await ctx.db
    .prepare("SELECT mint_url, COALESCE(SUM(balance), 0) AS owed FROM ecash_keys WHERE mint_url IS NOT NULL GROUP BY mint_url")
    .all<{ mint_url: string; owed: number }>();
  const out = new Map<string, { held: number; unspent: number; owed: number }>();
  for (const r of held.results) out.set(r.mint_url, { held: r.held, unspent: r.unspent, owed: 0 });
  for (const r of owed.results) {
    const e = out.get(r.mint_url) ?? { held: 0, unspent: 0, owed: 0 };
    e.owed = r.owed;
    out.set(r.mint_url, e);
  }
  return out;
}

export async function sealProofStmts(ctx: Ctx, mintUrl: string, proofs: Proof[], opId: string): Promise<D1PreparedStatement[]> {
  const now = ctx.now();
  const out: D1PreparedStatement[] = [];
  for (const p of proofs) {
    const y = proofY(p.secret);
    const plain = JSONInt.stringify({ id: p.id, amount: sats(p.amount), secret: p.secret, C: p.C, ...(p.dleq ? { dleq: p.dleq } : {}) }) as string;
    const sealed = await ctx.sealer.seal(plain, y);
    // OR IGNORE: the same proof restored twice (NUT-09) must not be stored twice.
    out.push(
      ctx.db
        .prepare(
          `INSERT OR IGNORE INTO ecash_proofs (y, mint_url, keyset_id, amount, sealed, state, op_id, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'unspent', ?6, ?7, ?7)`,
        )
        .bind(y, mintUrl, p.id, sats(p.amount), sealed, opId, now),
    );
  }
  return out;
}

export async function openProofs(ctx: Ctx, rows: ProofRow[]): Promise<Proof[]> {
  const raw = await Promise.all(rows.map(async (r) => JSONInt.parse(await ctx.sealer.open(r.sealed, r.y))));
  return deserializeProofs(raw as never);
}

/** Picks unspent proofs of one mint, largest first, until they cover `target`. Returns null if the pot is short. */
export async function selectProofs(ctx: Ctx, mintUrl: string, target: number): Promise<ProofRow[] | null> {
  const rows = await ctx.db
    .prepare("SELECT * FROM ecash_proofs WHERE mint_url = ? AND state = 'unspent' ORDER BY amount DESC, y")
    .bind(mintUrl)
    .all<ProofRow>();
  const out: ProofRow[] = [];
  let sum = 0;
  for (const r of rows.results) {
    if (sum >= target) break;
    out.push(r);
    sum += r.amount;
  }
  return sum >= target ? out : null;
}

/** Reserves exactly these proofs for an op. True only if every one was still unspent. */
export async function reserveProofs(ctx: Ctx, rows: ProofRow[], opId: string): Promise<boolean> {
  if (rows.length === 0) return true;
  const ys = rows.map((r) => r.y);
  const marks = ys.map((_, i) => `?${i + 3}`).join(",");
  const r = await ctx.db
    .prepare(`UPDATE ecash_proofs SET state = 'reserved', op_id = ?1, updated_at = ?2 WHERE state = 'unspent' AND y IN (${marks})`)
    .bind(opId, ctx.now(), ...ys)
    .run();
  if (r.meta.changes === rows.length) return true;
  await releaseProofs(ctx, opId);
  return false;
}

export async function releaseProofs(ctx: Ctx, opId: string): Promise<void> {
  await ctx.db
    .prepare("UPDATE ecash_proofs SET state = 'unspent', op_id = NULL, updated_at = ?2 WHERE op_id = ?1 AND state = 'reserved'")
    .bind(opId, ctx.now())
    .run();
}

export function spendReservedStmt(ctx: Ctx, opId: string): D1PreparedStatement {
  return ctx.db
    .prepare("UPDATE ecash_proofs SET state = 'spent', updated_at = ?2 WHERE op_id = ?1 AND state = 'reserved'")
    .bind(opId, ctx.now());
}

// ---- ops ------------------------------------------------------------------------------------------

export function newOpId(): string {
  return randomId();
}

export async function getOp(ctx: Ctx, opId: string): Promise<OpRow | null> {
  return ctx.db.prepare("SELECT * FROM ecash_ops WHERE op_id = ?").bind(opId).first<OpRow>();
}

export async function getOpByInput(ctx: Ctx, inputId: string): Promise<OpRow | null> {
  return ctx.db.prepare("SELECT * FROM ecash_ops WHERE input_id = ?").bind(inputId).first<OpRow>();
}

export function insertOpStmt(
  ctx: Ctx,
  op: Pick<OpRow, "op_id" | "kind" | "key_hash" | "mint_url" | "input_id" | "amount" | "keyset_id" | "counter_start" | "counter_count"> & { detail?: Record<string, unknown> },
): D1PreparedStatement {
  const now = ctx.now();
  return ctx.db
    .prepare(
      `INSERT INTO ecash_ops (op_id, kind, status, key_hash, mint_url, input_id, amount, keyset_id, counter_start, counter_count, detail, created_at, updated_at)
       VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
    )
    .bind(op.op_id, op.kind, op.key_hash, op.mint_url, op.input_id, op.amount, op.keyset_id, op.counter_start, op.counter_count,
      op.detail ? JSON.stringify(op.detail) : null, now);
}

export async function failOp(ctx: Ctx, opId: string, code: string, clearInput: boolean): Promise<void> {
  await ctx.db
    .prepare(
      `UPDATE ecash_ops SET status = 'failed', updated_at = ?2,
              input_id = CASE WHEN ?4 = 1 THEN NULL ELSE input_id END,
              detail = json_set(COALESCE(detail, '{}'), '$.error', ?3)
        WHERE op_id = ?1 AND status = 'pending'`,
    )
    .bind(opId, ctx.now(), code, clearInput ? 1 : 0)
    .run();
}

export function opDetail(op: OpRow): Record<string, unknown> {
  try {
    return op.detail ? (JSON.parse(op.detail) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Credits a key for a finished money-in op, at most once (PRD 6.6 step 6): store the new proofs, mark the op done, add the
 * credit. One D1 batch = one transaction. The key credit runs only if THIS batch flipped the op from pending to done
 * (a random claim id is written with it), so a second poll or a racing recovery can't credit twice.
 * Returns false if the op was already settled by someone else.
 */
export async function creditBatch(
  ctx: Ctx, op: Pick<OpRow, "op_id" | "mint_url" | "key_hash">, proofs: Proof[], credited: number, fee: number,
  extraDetail: Record<string, unknown> = {},
): Promise<boolean> {
  const claim = randomId();
  const now = ctx.now();
  const stmts = [
    ...(await sealProofStmts(ctx, op.mint_url, proofs, op.op_id)),
    ctx.db
      .prepare(
        `UPDATE ecash_ops SET status = 'done', credited = ?2, fee = ?3, updated_at = ?4,
                detail = json_set(json_patch(COALESCE(detail, '{}'), ?6), '$.claim', ?5)
          WHERE op_id = ?1 AND status = 'pending'`,
      )
      .bind(op.op_id, credited, fee, now, claim, JSON.stringify(extraDetail)),
    ctx.db
      .prepare(
        `UPDATE ecash_keys SET balance = balance + ?1, credited_total = credited_total + ?1
          WHERE key_hash = ?2 AND EXISTS (SELECT 1 FROM ecash_ops WHERE op_id = ?3 AND json_extract(detail, '$.claim') = ?4)`,
      )
      .bind(credited, op.key_hash, op.op_id, claim),
  ];
  const res = await ctx.db.batch(stmts);
  return res[res.length - 1]!.meta.changes === 1;
}

// ---- NUT-13 counters --------------------------------------------------------------------------------

/** cashu-ts CounterSource backed by `ecash_counters`. Each reserve is one atomic statement. */
export class D1CounterSource implements CounterSource {
  constructor(private db: D1Database) {}

  async reserve(keysetId: string, n: number): Promise<CounterRange> {
    if (n === 0) {
      const r = await this.db.prepare("SELECT next FROM ecash_counters WHERE keyset_id = ?").bind(keysetId).first<{ next: number }>();
      return { start: r?.next ?? 1, count: 0 };
    }
    // Counters start at 1: cashu-ts reads a counter of 0 as "auto".
    const r = await this.db
      .prepare(
        `INSERT INTO ecash_counters (keyset_id, next) VALUES (?1, 1 + ?2)
         ON CONFLICT(keyset_id) DO UPDATE SET next = next + ?2
         RETURNING next - ?2 AS start`,
      )
      .bind(keysetId, n)
      .first<{ start: number }>();
    if (!r) throw new Error("counter reservation failed");
    return { start: r.start, count: n };
  }

  async advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ecash_counters (keyset_id, next) VALUES (?1, ?2)
         ON CONFLICT(keyset_id) DO UPDATE SET next = MAX(next, ?2)`,
      )
      .bind(keysetId, minNext)
      .run();
  }
}
