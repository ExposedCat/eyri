import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  createBucket,
  moveTransactionToBucket,
  setBucketIncluded,
  transferBucketAccess,
} from "../database/bucket.ts";
import { createIntegration } from "../database/integration.ts";
import { saveRsuAward } from "../database/rsu.ts";
import { ensureSchema } from "../database/setup.ts";
import { findOrCreateUser, setUserCurrency } from "../database/user.ts";
import type {
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../integrations/types.ts";
import {
  buildIntegratedAllTimePerformanceList,
  buildIntegratedPerformanceList,
  getOrderTransactionKey,
} from "../tickers/portfolio.ts";
import { fetchPortfolioView } from "../tickers/portfolio_view.ts";
import type { ReportRuntime } from "./reports.ts";
import { createMcpHttpHandler, createMcpServer } from "./server.ts";

const position: IntegrationPortfolioPosition = {
  integrationId: 1,
  integrationKind: "ibkr",
  account: "test",
  ticker: "AAPL",
  assetCategory: "STK",
  amount: 6,
  averageUnitPrice: 100,
  currentPrice: 120,
  currency: "USD",
  totalInput: 600,
  totalNow: 720,
  unrealizedPnl: 120,
  realizedPnl: 999,
  dailyPnl: 12,
  dailyPnlPercentage: 2,
  dailyPnlBaseline: 600,
  openedAt: new Date("2025-01-01"),
};
const orders: IntegrationOrder[] = [
  {
    integrationId: 1,
    integrationKind: "ibkr",
    account: "test",
    ticker: "AAPL",
    date: new Date("2025-01-01"),
    quantity: 10,
    price: 100,
    currency: "USD",
    assetCategory: "STK",
  },
  {
    integrationId: 1,
    integrationKind: "ibkr",
    account: "test",
    ticker: "AAPL",
    date: new Date("2025-06-01"),
    quantity: -4,
    price: 150,
    currency: "USD",
    assetCategory: "STK",
  },
];
async function harness() {
  const db = new Database(":memory:");
  ensureSchema(db);
  for (const id of [1, 2, 3]) await findOrCreateUser(db, id);
  setUserCurrency(db, 2, "EUR");
  for (const userId of [1, 2]) {
    ok(
      createIntegration({
        database: db,
        userId,
        kind: "ibkr",
        credentials: { instanceUrl: "test:4001" },
      }).success,
    );
  }
  const runtime: ReportRuntime = {
    request: async () =>
      Response.json({ base: "USD", quote: "EUR", rate: 0.8 }),
    view: (database, userId, bucketName, options) =>
      fetchPortfolioView(database, userId, bucketName, options, {
        portfolio: (_db, id) =>
          Promise.resolve(id === 1 ? [structuredClone(position)] : []),
        orders: (_db, id) =>
          Promise.resolve(id === 1 ? structuredClone(orders) : []),
        history: (_db, id) =>
          Promise.resolve(id === 1 ? structuredClone(orders) : []),
      }),
    rsuQuotes: async () => new Map(),
    chart: async (_db, args, id, label) => ({
      userId: id,
      label,
      bucketName: args.bucketName,
      points: [{ date: "2025-06-01", gain: 320, percentage: 32 }],
    }),
  };
  const server = createMcpServer(db, runtime);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    db,
    runtime,
    server,
    client,
    async close() {
      await client.close();
      await server.close();
      db.close();
    },
  };
}
async function call(
  h: Awaited<ReturnType<typeof harness>>,
  name: string,
  args: Record<string, unknown> = { userId: 1 },
) {
  const result = await h.client.callTool({ name, arguments: args });
  equal(result.isError, undefined);
  const text = (result.content as { type: string; text: string }[])[0];
  equal(text.type, "text");
  const parsed = JSON.parse(text.text);
  deepStrictEqual(result.structuredContent, parsed);
  ok(!text.text.includes("\n"));
  return parsed;
}

Deno.test("MCP discovers command tools and validates userId, bucket, targets and cutoff", async () => {
  const h = await harness();
  try {
    const { tools } = await h.client.listTools();
    for (const name of [
      "number",
      "alltime",
      "perf",
      "worth",
      "sold",
      "stocks",
      "options",
      "history",
      "when",
      "rsu_at",
      "chart",
    ]) {
      const tool = tools.find((tool: Tool) => tool.name === name);
      ok(tool);
      equal(tool.annotations?.readOnlyHint, true);
      ok(tool.inputSchema.required?.includes("userId"));
    }
    for (const [name, args] of [
      ["number", {}],
      ["number", { userId: "1" }],
      ["number", { userId: -1 }],
      ["number", { userId: 1.5 }],
      ["number", { userId: 1, bucketName: "bad-name" }],
      ["when", { userId: 1 }],
      ["when", { userId: 1, prices: {} }],
      ["when", { userId: 1, prices: { AAPL: "invalid" } }],
      ["rsu_at", { userId: 1, cutoff: "2026-02-30" }],
    ] as const) {
      const result = await h.client.callTool({ name, arguments: args });
      equal(result.isError, true);
    }
    for (const [args, code] of [
      [{ userId: 999 }, "user_not_found"],
      [{ userId: 3 }, "no_integrations"],
    ] as const) {
      const result = await h.client.callTool({
        name: "number",
        arguments: args,
      });
      equal(result.isError, true);
      equal(
        (result.structuredContent as { error: { code: string } }).error.code,
        code,
      );
    }
    equal(
      h.db
        .prepare("SELECT COUNT(*) AS count FROM users")
        .get<{ count: number }>()?.count,
      3,
    );
  } finally {
    await h.close();
  }
});

Deno.test("MCP returns concise numerical reports matching Telegram totals and hypothetical returns", async () => {
  const h = await harness();
  try {
    deepStrictEqual(await call(h, "number"), {
      currency: "USD",
      tickers: ["AAPL"],
      total: 120,
    });
    deepStrictEqual(await call(h, "allnumber"), {
      currency: "USD",
      tickers: ["AAPL"],
      total: 320,
    });
    deepStrictEqual(await call(h, "worthnumber"), {
      currency: "USD",
      tickers: ["AAPL"],
      total: 720,
    });
    const perf = await call(h, "perf");
    equal(perf.positions[0].pnl, 120);
    equal(perf.total.returnPct, 20);
    const alltime = await call(h, "alltime");
    equal(alltime.total.pnl, 320);
    equal(alltime.total.returnPct, 32);
    match(
      await buildIntegratedPerformanceList({
        positions: [position],
        formatTicker: (s) => s,
      }),
      /Total: \+20.00% \+\$120.00/,
    );
    match(
      await buildIntegratedAllTimePerformanceList({
        positions: [position],
        orders,
        formatTicker: (s) => s,
      }),
      /Total: \+32.00% \+\$320.00/,
    );
    equal((await call(h, "worth")).total.value, 720);
    equal((await call(h, "sold")).total.pnl, 200);
    deepStrictEqual((await call(h, "dpnl")).total, { pnl: 12, returnPct: 2 });
    const stocks = await call(h, "stocks");
    equal(stocks.positions[0].amount, 6);
    equal(stocks.positions[0].averagePrice, 100);
    equal(stocks.positions[0].currentPrice, 120);
    deepStrictEqual((await call(h, "options")).positions, []);
    const hypothetical = await call(h, "when", {
      userId: 1,
      prices: { aapl: 150 },
    });
    equal(hypothetical.total.pnl, 300);
    equal(hypothetical.positions[0].currentPrice, 150);
    equal((await call(h, "number")).total, 120);
    equal(
      (await call(h, "when", { userId: 1, prices: { AAPL: 0 } })).total.pnl,
      -600,
    );
    const history = await call(h, "history");
    equal(history.years[0].year, 2025);
    equal(history.years[0].purchases[0].amount, 10);
    equal(history.total, 1000);
    const allocation = await call(h, "portfolio");
    equal(allocation.total, 720);
    equal(allocation.holdings[0].weightPct, 100);
    equal(allocation.holdings[0].returnPct, 20);
    equal((await call(h, "chart")).points[0].pnl, 320);
  } finally {
    await h.close();
  }
});

Deno.test("MCP honors shared buckets, included buckets and viewer currency without viewer integrations", async () => {
  const h = await harness();
  try {
    ok(
      (await createBucket({ database: h.db, userId: 1, name: "Core" })).success,
    );
    ok(
      (
        await moveTransactionToBucket({
          database: h.db,
          userId: 1,
          bucketName: "Core",
          transactionKey: getOrderTransactionKey(orders[0]),
        })
      ).success,
    );
    ok(
      transferBucketAccess({
        database: h.db,
        userId: 1,
        name: "Core",
        recipientId: 2,
      }).success,
    );
    ok(
      transferBucketAccess({
        database: h.db,
        userId: 1,
        name: "Core",
        recipientId: 3,
      }).success,
    );
    deepStrictEqual(await call(h, "buckets", { userId: 2 }), {
      buckets: [{ name: "Core", ownerUserId: 1, included: false }],
    });
    equal(
      (await call(h, "number", { userId: 2, bucketName: "Core" })).total,
      96,
    );
    equal(
      (await call(h, "allnumber", { userId: 2, bucketName: "Core" })).total,
      256,
    );
    equal(
      (await call(h, "number", { userId: 3, bucketName: "Core" })).total,
      120,
    );
    ok(
      setBucketIncluded({
        database: h.db,
        userId: 2,
        name: "Core",
        included: true,
      }).success,
    );
    equal((await call(h, "number", { userId: 2 })).total, 96);
    equal((await call(h, "chart", { userId: 2 })).points[0].pnl, 256);
  } finally {
    await h.close();
  }
});

Deno.test("MCP preserves empty/unknown values, masked integration details and RSU cutoff totals", async () => {
  const h = await harness();
  try {
    deepStrictEqual(await call(h, "number", { userId: 2 }), {
      currency: "EUR",
      tickers: [],
      total: null,
    });
    h.runtime.view = async () => ({
      positions: [{ ...position, currentPrice: null, totalNow: null }],
      orders: [],
      historyOrders: [],
      transactionBuckets: new Map(),
      bucketName: null,
      accountPerformances: [],
    });
    equal((await call(h, "number")).total, null);
    const daily = await call(h, "dpnl");
    equal(daily.positions[0].pnl, 12);
    equal(daily.total.pnl, null); // Same missing-price guard as the Telegram total.
    ok(
      createIntegration({
        database: h.db,
        userId: 1,
        kind: "t212",
        credentials: { apiKey: "1234-secret-5678", apiSecret: "private" },
      }).success,
    );
    const integrations = await call(h, "integrations");
    match(integrations.integrations[1].description, /1234…5678/);
    ok(!JSON.stringify(integrations).includes("secret"));
    ok(!JSON.stringify(integrations).includes("private"));
    equal((await call(h, "rsu")).total, null);
    saveRsuAward(h.db, 1, {
      ticker: "AAPL",
      amount: 10,
      price: 100,
      awardDate: "2025-01-01",
      vesting: [
        { date: "2090-01-01", amount: 4 },
        { date: "2091-01-01", amount: 6 },
      ],
    });
    h.runtime.rsuQuotes = async () =>
      new Map([
        [
          "AAPL",
          { price: 150, delayed: false, frozen: false, previousClose: false },
        ],
      ]);
    const rsu = await call(h, "rsu_at", { userId: 1, cutoff: "2090-01-01" });
    equal(rsu.total.value, 600);
    equal(rsu.total.pnl, 200);
    equal(rsu.missed.value, 900);
    equal(rsu.vestings.length, 1);
  } finally {
    await h.close();
  }
});

Deno.test("stateless HTTP works with a real MCP client, concurrent calls and JSON protocol errors", async () => {
  const h = await harness();
  const http = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    createMcpHttpHandler(h.db, h.runtime),
  );
  const url = new URL(`http://127.0.0.1:${http.addr.port}/mcp`);
  const client = new Client({ name: "http-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    equal((await client.listTools()).tools.length, 18);
    const results = await Promise.all([
      client.callTool({ name: "number", arguments: { userId: 1 } }),
      client.callTool({ name: "allnumber", arguments: { userId: 1 } }),
    ]);
    equal(results[0].structuredContent?.total, 120);
    equal(results[1].structuredContent?.total, 320);
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await fetch(url, { method });
      equal(response.status, 405);
      equal(response.headers.get("allow"), "POST");
      await response.body?.cancel();
    }
    const invalid = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{",
    });
    equal(invalid.status, 400);
    equal((await invalid.json()).error.code, -32700);
    const origin = await fetch(url, {
      method: "POST",
      headers: { origin: "https://untrusted.example" },
    });
    equal(origin.status, 403);
    await origin.body?.cancel();
    const missing = await fetch(new URL("/other", url));
    equal(missing.status, 404);
    await missing.body?.cancel();
  } finally {
    await client.close();
    await http.shutdown();
    await h.close();
  }
});

Deno.test("standalone stdio starts without a bot token and keeps stdout as JSON-RPC", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/eyri.sqlite`;
  const db = new Database(path);
  ensureSchema(db);
  await findOrCreateUser(db, 42);
  db.close();
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: Deno.execPath(),
    args: [
      "run",
      "--cached-only",
      "-A",
      new URL("../../mcp.ts", import.meta.url).pathname,
      "--stdio",
    ],
    cwd: new URL("../../../", import.meta.url).pathname,
    env: { EYRI_DATABASE_PATH: path, TOKEN: "" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "buckets",
      arguments: { userId: 42 },
    });
    deepStrictEqual(result.structuredContent, { buckets: [] });
    equal((await client.listTools()).tools.length, 18);
  } finally {
    await client.close();
    await transport.close();
    await Deno.remove(directory, { recursive: true });
  }
});
