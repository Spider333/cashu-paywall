# Security

cashu-paywall handles ecash, which is bearer money. It is **unaudited** and has only been run against the test mint `testnut.cashu.space`. Use a test mint first, and keep the caps low on any mint that holds real sats.

## Reporting a problem

Please report a vulnerability privately through GitHub: on the repository page, open **Security → Report a vulnerability**. Don't open a public issue for anything that could lose or leak funds.

Useful to include:

- the version or commit;
- what an attacker can do (steal from the pot, credit without paying, double-credit, leak a key or token, take the Worker down);
- steps or a test that shows it.

Fixes for anything that can lose funds come first.

## Scope

In scope: the library in `src/`, the schema in `migrations/`, and the demo Worker in `examples/demo-worker`.

Out of scope: bugs in a mint, in cashu-ts or in Cloudflare's runtime (report those upstream), and the custody risk of holding ecash at a mint, which is by design and described in [docs/security.md](docs/security.md).

## Supported versions

Only the latest release gets fixes. Today that is 0.1.0.
