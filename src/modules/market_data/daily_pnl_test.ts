import { equal } from "node:assert/strict";
import { Database } from "@db/sqlite";
import type { IntegrationPortfolioPosition } from "../integrations/types.ts";
import { fillMissingDailyPnl } from "./daily_pnl.ts";
import type { PriceHistory } from "./history.ts";
import { YahooHistoryCache } from "./yahoo.ts";

const position = (
  overrides: Partial<IntegrationPortfolioPosition> = {},
): IntegrationPortfolioPosition => ({
  integrationId: 6,
  integrationKind: "t212",
  account: "Trading 212 #6",
  ticker: "2DGD_EQ",
  currency: "EUR",
  amount: 10,
  averageUnitPrice: 5,
  currentPrice: 11,
  totalInput: 50,
  totalNow: 110,
  unrealizedPnl: 60,
  realizedPnl: null,
  dailyPnl: null,
  dailyPnlPercentage: null,
  dailyPnlBaseline: null,
  openedAt: null,
  ...overrides,
});

const history = (bars: [string, number][], currency = "EUR"): PriceHistory => ({
  symbol: "2DG.DE",
  currency,
  bars: bars.map(([date, close]) => ({ date, close })),
  splits: [],
});

const source = (live: PriceHistory | Error, stored?: PriceHistory, resolve: string | Error = "2DG.DE") => ({
  resolve: () => resolve instanceof Error ? Promise.reject(resolve) : Promise.resolve(resolve),
  get: () => live instanceof Error ? Promise.reject(live) : Promise.resolve(live),
  stored: () => stored,
});

const now = new Date("2026-11-25T15:00:00Z");

Deno.test("missing daily P/L uses the previous session close from market data", async () => {
  const [filled] = await fillMissingDailyPnl([position()], source(
    history([["2026-11-23", 9], ["2026-11-24", 10], ["2026-11-25", 10.8]]),
  ), now);
  equal(filled.dailyPnl, 10);
  equal(filled.dailyPnlBaseline, 100);
  equal(filled.dailyPnlPercentage, 10);
  equal(filled.dailyPnlCached, undefined);
});

Deno.test("market data failure falls back to stored closes and marks them cached", async () => {
  const [filled] = await fillMissingDailyPnl([position()], source(
    new Error("Yahoo down"), history([["2026-11-21", 10], ["2026-11-24", 12]]),
  ), now);
  equal(filled.dailyPnl, 10);
  equal(filled.dailyPnlCached, true);
});

Deno.test("unavailable daily data leaves the holding without daily P/L", async () => {
  for (const unavailable of [
    source(new Error("Yahoo down")),
    source(history([["2026-11-25", 10]])),
    source(history([["2026-11-24", 10], ["2026-11-25", 11]], "USD")),
    source(history([]), undefined, new Error("not found")),
  ]) {
    equal((await fillMissingDailyPnl([position()], unavailable, now))[0].dailyPnl, null);
  }
});

Deno.test("broker daily P/L and CFD allocations are kept; pence and contract prices are scaled", async () => {
  const reported = position({ dailyPnl: 3, dailyPnlPercentage: 1, dailyPnlBaseline: 300 });
  const cfd = position({ assetCategory: "CFD_TRANSFER" });
  const kept = await fillMissingDailyPnl([reported, cfd], source(new Error("unused")), now);
  equal(kept[0], reported);
  equal(kept[1], cfd);
  const [pence] = await fillMissingDailyPnl([position({ currency: "GBP" })], source(
    history([["2026-11-24", 1000], ["2026-11-25", 1100]], "GBX"),
  ), now);
  equal(pence.dailyPnl, 10);
  const [option] = await fillMissingDailyPnl([position({
    integrationKind: "ibkr", ticker: "AAPL 261218C00200000", currency: "USD", amount: 2, currentPrice: 500,
  })], source(history([["2026-11-24", 4], ["2026-11-25", 5]], "USD")), now);
  equal(option.dailyPnl, 200);
});

Deno.test("stored closes are read without requests and apply later splits", () => {
  const db = new Database(":memory:");
  const cache = new YahooHistoryCache(db, () => Promise.reject(new Error("offline")));
  equal(cache.stored("2DG.DE", "2026-11-01"), undefined);
  db.prepare("INSERT INTO yahoo_prices(symbol,date,close,currency) VALUES (?,?,?,?)").run("2DG.DE", "2026-11-20", 9, "EUR");
  db.prepare("INSERT INTO yahoo_splits(symbol,date,ratio) VALUES (?,?,?)").run("2DG.DE", "2026-11-23", 2);
  db.prepare("INSERT INTO yahoo_recent(symbol,fetched_at,payload) VALUES (?,?,?)").run(
    "2DG.DE", 0, JSON.stringify(history([["2026-11-21", 10], ["2026-11-24", 6]])),
  );
  const stored = cache.stored("2DG.DE", "2026-11-01")!;
  equal(stored.currency, "EUR");
  equal(JSON.stringify(stored.bars.map((bar) => [bar.date, bar.close])),
    JSON.stringify([["2026-11-20", 9], ["2026-11-21", 20], ["2026-11-24", 6]]));
  equal(cache.stored("VONTOBEL:DE000VX0", "2026-11-01"), undefined);
});
