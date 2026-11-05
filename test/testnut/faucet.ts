// Live-test helper: mints test sats on testnut (its Lightning is fake: invoices get paid by themselves) and hands
// out tokens of exact amounts. One faucet per spec file; calls are serialised because they share proofs.
import { Mint, MintQuoteState, Wallet, getEncodedToken, type Proof } from "@cashu/cashu-ts";
import { createMintRequest } from "../../src/core/mint-request";
import { TESTNUT } from "../helpers";

export function testWallet(unit = "sat", mintUrl = TESTNUT): Wallet {
  return new Wallet(new Mint(mintUrl, { customRequest: createMintRequest(fetch) }), { unit, denominationTarget: 1 });
}

export async function mintProofs(wallet: Wallet, amount: number): Promise<Proof[]> {
  const q = await wallet.createMintQuoteBolt11(amount);
  const t0 = Date.now();
  let st = await wallet.checkMintQuoteBolt11(q.quote);
  while (st.state === MintQuoteState.UNPAID) {
    if (Date.now() - t0 > 60_000) throw new Error("testnut quote not paid within 60 s");
    await new Promise((r) => setTimeout(r, 500));
    st = await wallet.checkMintQuoteBolt11(q.quote);
  }
  return wallet.mintProofsBolt11(amount, q.quote);
}

export class Faucet {
  wallet: Wallet;
  private proofs: Proof[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(private unit = "sat") {
    this.wallet = testWallet(unit);
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async ensure(amount: number) {
    const have = this.proofs.reduce((s, p) => s + p.amount.toNumber(), 0);
    if (have >= amount + 20) return;
    if (!this.loaded) {
      await this.wallet.loadMint();
      this.loaded = true;
    }
    this.proofs.push(...(await mintProofs(this.wallet, Math.max(2_000, amount + 50))));
  }

  /** A token worth exactly `amount` (the swap fee is paid from the faucet's change). */
  token(amount: number, opts: { p2pkPubkey?: string } = {}): Promise<string> {
    return this.run(async () => {
      await this.ensure(amount);
      const { send, keep } = await this.wallet.send(amount, this.proofs, { includeFees: false },
        opts.p2pkPubkey ? { send: { type: "p2pk", options: { pubkey: opts.p2pkPubkey } } } : undefined);
      this.proofs = keep;
      return getEncodedToken({ mint: TESTNUT, proofs: send, unit: this.unit });
    });
  }

  /** The fee testnut charges to swap this token (100 ppk per input, rounded up). */
  async load(): Promise<void> {
    await this.run(async () => {
      if (!this.loaded) {
        await this.wallet.loadMint();
        this.loaded = true;
      }
    });
  }

  feeFor(token: string): number {
    return this.wallet.getFeesForProofs(this.wallet.decodeToken(token).proofs).toNumber();
  }
}

/** Receives a token in a fresh wallet (proves a refund token is claimable). Returns the received amount. */
export async function claim(token: string): Promise<number> {
  const w = testWallet();
  await w.loadMint();
  const got = await w.receive(token);
  return got.reduce((s, p) => s + p.amount.toNumber(), 0);
}

/** The pot in D1 must match the mint: every proof we call unspent is UNSPENT at the mint. Returns their sum. */
export async function potMatchesMint(db: D1Database, makeOpen: (rows: unknown[]) => Promise<Proof[]>): Promise<number> {
  const rows = (await db.prepare("SELECT * FROM ecash_proofs WHERE state = 'unspent'").all()).results;
  if (rows.length === 0) return 0;
  const proofs = await makeOpen(rows);
  const w = testWallet();
  await w.loadMint();
  const states = await w.checkProofsStates(proofs);
  if (!states.every((s) => s.state === "UNSPENT")) throw new Error("D1 says unspent but the mint disagrees");
  return proofs.reduce((s, p) => s + p.amount.toNumber(), 0);
}
