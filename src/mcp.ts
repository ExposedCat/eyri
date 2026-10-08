import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectToDb } from "./modules/database/setup.ts";
import { createMcpServer, startMcpHttpServer } from "./modules/mcp/server.ts";

// Reserve stdout for JSON-RPC when used as a local MCP subprocess.
if (Deno.args.includes("--stdio")) {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  await createMcpServer(await connectToDb()).connect(
    new StdioServerTransport(),
  );
} else {
  startMcpHttpServer(await connectToDb());
}
