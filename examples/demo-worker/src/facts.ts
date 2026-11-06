// One line per Cashu NUT, titles copied from the cashubtc/nuts README on 5 Nov 2026. No invented text.
export interface NutFact {
  nut: number;
  title: string;
  url: string;
}

const TITLES: Array<[number, string]> = [
  [0, "Cryptography and Models"],
  [1, "Mint public keys"],
  [2, "Keysets and fees"],
  [3, "Swapping tokens"],
  [4, "Minting tokens"],
  [5, "Melting tokens"],
  [6, "Mint info"],
  [7, "Token state check"],
  [8, "Overpaid Lightning fees"],
  [9, "Signature restore"],
  [10, "Spending conditions"],
  [11, "Pay-To-Pubkey (P2PK)"],
  [12, "DLEQ proofs"],
  [13, "Deterministic secrets"],
  [14, "Hashed Timelock Contracts (HTLCs)"],
  [15, "Partial multi-path payments (MPP)"],
  [16, "Animated QR codes"],
  [17, "WebSocket subscriptions"],
  [18, "Payment requests"],
  [19, "Cached Responses"],
  [20, "Signature on Mint Quote"],
  [21, "Clear authentication"],
  [22, "Blind authentication"],
  [23, "Payment Method: BOLT11"],
  [24, "HTTP 402 Payment Required"],
  [25, "Payment Method: BOLT12"],
  [26, "Payment Request Bech32m Encoding"],
  [27, "Nostr Mint Backup"],
  [28, "Pay to Blinded Key (P2BK)"],
  [29, "Batched Mint"],
  [30, "Payment Method: Onchain"],
];

export const FACTS: NutFact[] = TITLES.map(([nut, title]) => ({
  nut,
  title,
  url: `https://github.com/cashubtc/nuts/blob/main/${String(nut).padStart(2, "0")}.md`,
}));

/** No value -> a random fact. A number 0..99 not in the list -> null. Anything else -> null. */
export function findFact(value: string | number | null | undefined): NutFact | null {
  if (value === null || value === undefined || value === "") return FACTS[Math.floor(Math.random() * FACTS.length)]!;
  const s = String(value).trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  return FACTS.find((f) => f.nut === Number(s)) ?? null;
}
