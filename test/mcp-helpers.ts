import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EcashKey, Paywall } from "../src/index";
import { registerEcashTools, withEcashCharge } from "../src/mcp/index";

export class Matched extends Error {}

/** An MCP server with the ecash tools plus three paid test tools, connected to an in-memory client. */
export async function connect(paywall: Paywall, key: EcashKey | null, priceSats = 10) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const getKey = () => key;
  registerEcashTools(server, paywall, { getKey, priceSats });
  let ran = 0;
  server.registerTool("paid_ok", { description: "x".repeat(81), inputSchema: {} },
    withEcashCharge(paywall, { getKey, priceSats }, async () => { ran++; return { content: [{ type: "text", text: "{\"ok\":true}" }] }; }));
  server.registerTool("paid_matched", { description: "x".repeat(81), inputSchema: {} },
    withEcashCharge(paywall, { getKey, priceSats, refundOn: (e) => e instanceof Matched }, async () => { ran++; throw new Matched("data source down"); }));
  server.registerTool("paid_unmatched", { description: "x".repeat(81), inputSchema: { n: z.number().optional().describe("unused number here") } },
    withEcashCharge(paywall, { getKey, priceSats, refundOn: (e) => e instanceof Matched }, async () => { ran++; throw new Error("boom"); }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) as Record<string, any> };
  };
  return { client, call, ran: () => ran };
}
