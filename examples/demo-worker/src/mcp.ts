// The demo's MCP server, built fresh per request with the caller's key in a closure (the transport is stateless).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EcashKey, Paywall } from "cashu-paywall";
import { registerEcashTools, withEcashCharge } from "cashu-paywall/mcp";
import { findFact } from "./facts";

export class NoSuchNut extends Error {
  constructor(nut: number) {
    super(`NUT-${String(nut).padStart(2, "0")} is not in this server's list. You were not charged.`);
  }
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function buildServer(paywall: Paywall, key: EcashKey, priceSats: number): McpServer {
  const server = new McpServer({ name: "cashu-paywall-demo", version: "0.1.0" });
  const getKey = () => key;

  server.registerTool(
    "nut_fact",
    {
      description:
        `Returns one Cashu protocol spec (a "NUT") as a short fact: its number, title and a link to the spec. ` +
        `Costs ${priceSats} sats of ecash credit per call; a NUT number not in the list is refunded.`,
      inputSchema: {
        nut: z.number().int().min(0).max(99).optional()
          .describe("The NUT number to look up, from 0 to 99 (for example 24 for HTTP 402). Leave it out for a random one."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    withEcashCharge(paywall, { getKey, priceSats, refundOn: (e) => e instanceof NoSuchNut }, async (args: { nut?: number }) => {
      const fact = findFact(args.nut ?? null);
      if (!fact) throw new NoSuchNut(args.nut ?? -1);
      return json(fact);
    }),
  );

  server.registerTool(
    "echo",
    {
      description:
        `Echoes the text you send back to you, with its length and the server time. Useful for watching the ecash balance ` +
        `drop: costs ${priceSats} sats of credit per call.`,
      inputSchema: {
        text: z.string().min(1).max(500).describe("Any text from 1 to 500 characters; it is returned unchanged."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    withEcashCharge(paywall, { getKey, priceSats }, async (args: { text: string }) =>
      json({ text: args.text, length: args.text.length, served_at: new Date().toISOString() })),
  );

  registerEcashTools(server, paywall, { getKey, priceSats });
  return server;
}
