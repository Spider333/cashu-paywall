-- Total rollback of cashu-paywall (PRD 11.5). Kept OUT of migrations/ on purpose: it deletes every key, proof and op.
-- Run only with the operator's explicit yes, and only after melting or refunding the pot.
DROP TABLE IF EXISTS ecash_mint_cache;
DROP TABLE IF EXISTS ecash_counters;
DROP TABLE IF EXISTS ecash_ops;
DROP TABLE IF EXISTS ecash_proofs;
DROP TABLE IF EXISTS ecash_keys;
