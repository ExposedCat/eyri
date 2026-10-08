import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Database } from "../database/setup.ts";
import {
  type ReportArgs,
  ReportError,
  type ReportName,
  type ReportRuntime,
  reportDescriptions,
  runReport,
} from "./reports.ts";

const userId = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe("Telegram user ID. No authentication is required.");
const bucketName = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,19}$/)
  .optional()
  .describe(
    "Accessible bucket name. Omit for the default portfolio plus included buckets.",
  );
const cutoff = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
  }, "Use a valid UTC date in YYYY-MM-DD format.");
const prices = z
  .record(z.string().trim().min(1).max(64), z.number().finite())
  .refine(
    (value) => Object.keys(value).length > 0,
    "Provide at least one target price.",
  )
  .describe("Ticker to hypothetical price, in the user's reporting currency.");

export function createMcpServer(db: Database, runtime?: ReportRuntime) {
  const server = new McpServer(
    { name: "Eyri", version: "1.0.0" },
    {
      instructions:
        "Eyri portfolio reports mirror Telegram commands. Supply the Telegram userId; authentication is currently disabled. Monetary values use the user's saved reporting currency, percentage values are percentage points, and null means unavailable. Empty lists mean no positions. Tools refresh broker data and may update local caches. Tools do not change user settings or place trades.",
    },
  );
  for (const name of Object.keys(reportDescriptions) as ReportName[]) {
    const inputSchema =
      name === "when"
        ? { userId, prices }
        : name === "rsu_at"
          ? { userId, cutoff }
          : ["buckets", "integrations", "rsu"].includes(name)
            ? { userId }
            : { userId, bucketName };
    server.registerTool(
      name,
      {
        description: reportDescriptions[name],
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async (args: ReportArgs) => {
        try {
          const result = await runReport(db, name, args, runtime);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          const result = {
            error: {
              code: error instanceof ReportError ? error.code : "report_failed",
              message: error instanceof Error ? error.message : String(error),
            },
          };
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }
      },
    );
  }
  return server;
}

export function createMcpHttpHandler(
  db: Database,
  runtime?: ReportRuntime,
  allowedHosts?: string[],
) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp")
      return new Response("Not found", { status: 404 });
    const origin = request.headers.get("origin");
    if (
      (origin && origin !== url.origin) ||
      (allowedHosts && !allowedHosts.includes(url.host))
    ) {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Invalid origin or host." },
        },
        { status: 403 },
      );
    }
    if (request.method !== "POST") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Method not allowed." },
        },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    // A fresh server/transport per request keeps stateless and concurrent calls isolated.
    const server = createMcpServer(db, runtime);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  };
}

export function startMcpHttpServer(db: Database) {
  const configuredPort = Deno.env.get("EYRI_MCP_PORT") ?? "8000";
  if (!/^\d+$/.test(configuredPort))
    throw new Error("EYRI_MCP_PORT must be an integer between 0 and 65535.");
  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("EYRI_MCP_PORT must be an integer between 0 and 65535.");
  if (port === 0) return null;
  const hostname = Deno.env.get("EYRI_MCP_HOST") ?? "127.0.0.1";
  return Deno.serve(
    {
      hostname,
      port,
      onListen: () =>
        console.error(`Eyri MCP listening at http://${hostname}:${port}/mcp`),
    },
    createMcpHttpHandler(
      db,
      undefined,
      ["127.0.0.1", "localhost"].includes(hostname)
        ? [`127.0.0.1:${port}`, `localhost:${port}`]
        : undefined,
    ),
  );
}
