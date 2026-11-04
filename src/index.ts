#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCredentials } from "./config.ts";
import { createServer } from "./server.ts";
import { XApi } from "./x/api.ts";
import { XClient } from "./x/client.ts";

/**
 * stdio MCP server. stdout is the protocol channel, so every log line goes to
 * stderr; a stray console.log here breaks the client connection.
 */
async function main(): Promise<void> {
  const credentials = loadCredentials();
  const api = new XApi(new XClient(credentials));
  const server = createServer(api);
  await server.connect(new StdioServerTransport());
  console.error(
    `x-mcp ready (ops scraped ${(await import("./x/ops.generated.ts")).OPS_SCRAPED_AT})`,
  );
}

main().catch((error: unknown) => {
  console.error(`x-mcp failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
