#!/usr/bin/env node
// Bundle size of a Worker that uses cashu-paywall, as esbuild would ship it (minified ESM), raw and gzipped.
// Needs `npm run build` first (it bundles dist/). Usage: npm run bench:bundle
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const entries = {
  // A plain Worker with one protect()ed route: the library core plus cashu-ts.
  "library (createPaywall + protect)": `
    import { createPaywall } from "./dist/index.js";
    export default { fetch: (req, env) => createPaywall(env.cfg).protect(async () => new Response("ok"), { priceSats: 1 })(req) };
  `,
  // Adds the MCP adapter, the MCP SDK and zod.
  "library + cashu-paywall/mcp": `
    import { createPaywall } from "./dist/index.js";
    import { registerEcashTools } from "./dist/mcp/index.js";
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    export default { fetch: async (req, env) => {
      const s = new McpServer({ name: "x", version: "0" });
      registerEcashTools(s, createPaywall(env.cfg), { getKey: () => null, priceSats: 1 });
      return new Response("ok");
    } };
  `,
};

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
for (const [name, contents] of Object.entries(entries)) {
  const result = await build({
    stdin: { contents, resolveDir: root, loader: "js" },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*", "cloudflare:*"],
    write: false,
    logLevel: "error",
  });
  const code = result.outputFiles[0].contents;
  console.log(
    `${name.padEnd(36)} ${kb(code.length).padStart(7)} raw  ${kb(gzipSync(code).length).padStart(6)} gzipped`,
  );
}
