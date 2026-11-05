#!/usr/bin/env node
// Prints a fresh testnut token worth N sats (default 20): `TOKEN=$(npm run -s demo:token -- 20)`.
// testnut's Lightning is fake: its invoices pay themselves, so this costs nothing and is worth nothing.
import { Wallet, MintQuoteState, getEncodedToken } from "@cashu/cashu-ts";

const MINT = process.env.TESTNUT_URL ?? "https://testnut.cashu.space";
const amount = Number(process.argv[2] ?? 20);
if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100_000) {
  console.error("usage: npm run -s demo:token -- <sats 1..100000>");
  process.exit(2);
}
const wallet = new Wallet(MINT, { denominationTarget: 1 });
await wallet.loadMint();
const quote = await wallet.createMintQuoteBolt11(amount);
const started = Date.now();
let state = await wallet.checkMintQuoteBolt11(quote.quote);
while (state.state === MintQuoteState.UNPAID) {
  if (Date.now() - started > 60_000) {
    console.error("testnut did not mark the quote paid within 60 s");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 500));
  state = await wallet.checkMintQuoteBolt11(quote.quote);
}
const proofs = await wallet.mintProofsBolt11(amount, quote.quote);
process.stdout.write(getEncodedToken({ mint: MINT, proofs, unit: "sat" }) + "\n");
