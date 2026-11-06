-- Removes cashu-paywall from a D1 database: drops every ecash_* table, with every key, proof and op in it.
-- Not a migration, and kept out of migrations/ so `wrangler d1 migrations apply` can never run it.
-- Melt or refund the pot first: the rows in ecash_proofs are the Worker's only copy of that ecash
-- (apart from a NUT-09 restore with the wallet seed). See docs/integration.md, "Removing it".
DROP TABLE IF EXISTS ecash_mint_cache;
DROP TABLE IF EXISTS ecash_counters;
DROP TABLE IF EXISTS ecash_ops;
DROP TABLE IF EXISTS ecash_proofs;
DROP TABLE IF EXISTS ecash_keys;
