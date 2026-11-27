import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import {
  clearMarketCaches,
  computeMarketSession,
  fetchTickerChart,
  searchTickers,
} from "./market.ts";
import {
  buildMarketStatusFromIbHours,
  parseIbHoursString,
} from "./ibkr_market.ts";

Deno.test("computeMarketSession detects PRE, REGULAR, POST, CLOSED, weekend rollover, and 24/7 crypto", () => {
  // Friday Nov 27, 2026 in New York (EST, UTC-5):
  // Pre: 04:00-09:30 EST -> 09:00-14:30 UTC
  // Regular: 09:30-16:00 EST -> 14:30-21:00 UTC
  // Post: 16:00-20:00 EST -> 21:00-01:00 UTC (Nov 28)
  const periods = {
    pre: {
      start: Date.UTC(2026, 10, 27, 9, 0, 0) / 1000,
      end: Date.UTC(2026, 10, 27, 14, 30, 0) / 1000,
    },
    regular: {
      start: Date.UTC(2026, 10, 27, 14, 30, 0) / 1000,
      end: Date.UTC(2026, 10, 27, 21, 0, 0) / 1000,
    },
    post: {
      start: Date.UTC(2026, 10, 27, 21, 0, 0) / 1000,
      end: Date.UTC(2026, 10, 28, 1, 0, 0) / 1000,
    },
  };

  // Pre-market at 08:00 EST (13:00 UTC)
  const preStatus = computeMarketSession({
    instrumentType: "EQUITY",
    timezone: "America/New_York",
    currentTradingPeriod: periods,
    nowMs: Date.UTC(2026, 10, 27, 13, 0, 0),
  });
  assertEquals(preStatus.state, "PRE");
  assertEquals(preStatus.isOpenNow, true);
  assertEquals(preStatus.isRegularOpen, false);
  assertEquals(preStatus.isExtendedHours, true);
  assertEquals(preStatus.nextRegularOpenAt, Date.UTC(2026, 10, 27, 14, 30, 0));

  // Regular open at 11:00 EST (16:00 UTC)
  const regStatus = computeMarketSession({
    instrumentType: "EQUITY",
    timezone: "America/New_York",
    currentTradingPeriod: periods,
    nowMs: Date.UTC(2026, 10, 27, 16, 0, 0),
  });
  assertEquals(regStatus.state, "REGULAR");
  assertEquals(regStatus.isRegularOpen, true);
  assertEquals(regStatus.nextRegularCloseAt, Date.UTC(2026, 10, 27, 21, 0, 0));

  // After-hours at 17:30 EST (22:30 UTC)
  const postStatus = computeMarketSession({
    instrumentType: "EQUITY",
    timezone: "America/New_York",
    currentTradingPeriod: periods,
    nowMs: Date.UTC(2026, 10, 27, 22, 30, 0),
  });
  assertEquals(postStatus.state, "POST");
  assertEquals(postStatus.isExtendedHours, true);
  assertEquals(postStatus.nextTransitionAt, Date.UTC(2026, 10, 28, 1, 0, 0));

  // Closed on Friday night 22:00 EST (Saturday 03:00 UTC) -> rolls over to Monday Nov 30 09:30 EST (14:30 UTC)
  const closedStatus = computeMarketSession({
    instrumentType: "EQUITY",
    timezone: "America/New_York",
    currentTradingPeriod: periods,
    nowMs: Date.UTC(2026, 10, 28, 3, 0, 0),
  });
  assertEquals(closedStatus.state, "CLOSED");
  assertEquals(closedStatus.isOpenNow, false);
  assertEquals(closedStatus.nextRegularOpenAt, Date.UTC(2026, 10, 30, 14, 30, 0));

  // Crypto is 24/7
  const cryptoStatus = computeMarketSession({
    instrumentType: "CRYPTOCURRENCY",
    timezone: "UTC",
    nowMs: Date.UTC(2026, 10, 28, 3, 0, 0),
  });
  assertEquals(cryptoStatus.state, "OPEN_24_7");
  assertEquals(cryptoStatus.isOpenNow, true);
});

Deno.test("fetchTickerChart extracts intraday pre/regular/post sessions, key points, dividends, and splits", async () => {
  clearMarketCaches();
  const preStart = Date.UTC(2026, 10, 27, 9, 0, 0) / 1000;
  const regStart = Date.UTC(2026, 10, 27, 14, 30, 0) / 1000;
  const regEnd = Date.UTC(2026, 10, 27, 21, 0, 0) / 1000;
  const postEnd = Date.UTC(2026, 10, 28, 1, 0, 0) / 1000;

  const mockFetch = ((_url: string | URL | Request) => {
    const payload = {
      chart: {
        result: [{
          meta: {
            symbol: "NVDA",
            shortName: "NVIDIA Corporation",
            fullExchangeName: "NasdaqGS",
            instrumentType: "EQUITY",
            currency: "USD",
            exchangeTimezoneName: "America/New_York",
            regularMarketPrice: 145.5,
            previousClose: 140.0,
            regularMarketOpen: 141.0,
            regularMarketDayHigh: 147.0,
            regularMarketDayLow: 140.5,
            regularMarketVolume: 42_000_000,
            fiftyTwoWeekHigh: 152.0,
            fiftyTwoWeekLow: 85.0,
            postMarketPrice: 146.2,
            postMarketTime: regEnd + 600,
            currentTradingPeriod: {
              pre: { start: preStart, end: regStart },
              regular: { start: regStart, end: regEnd },
              post: { start: regEnd, end: postEnd },
            },
            tradingPeriods: {
              pre: [[{ start: preStart, end: regStart }]],
              regular: [[{ start: regStart, end: regEnd }]],
              post: [[{ start: regEnd, end: postEnd }]],
            },
          },
          timestamp: [preStart + 1800, regStart + 300, regStart + 3600, regEnd + 600],
          indicators: {
            quote: [{
              open: [140.2, 141.0, 144.0, 145.5],
              high: [141.0, 147.0, 146.0, 146.4],
              low: [139.8, 140.5, 143.5, 145.2],
              close: [140.8, 144.5, 145.5, 146.2],
              volume: [100_000, 5_000_000, 3_000_000, 250_000],
            }],
          },
          events: {
            dividends: { d1: { date: regStart, amount: 0.01 } },
            splits: { s1: { date: regStart, numerator: 10, denominator: 1, splitRatio: "10:1" } },
          },
        }],
      },
    };
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  }) as typeof fetch;

  const chart = await fetchTickerChart("nvda", "1d", mockFetch, (regEnd + 900) * 1000);
  assertEquals(chart.symbol, "NVDA");
  assertEquals(chart.marketStatus.state, "POST");
  assertEquals(chart.bars.length, 4);
  assertEquals(chart.bars.map((b) => b.session), ["pre", "regular", "regular", "post"]);
  assertEquals(chart.stats.periodHigh?.price, 147.0);
  assertEquals(chart.stats.periodLow?.price, 139.8);
  assertEquals(chart.extended?.session, "post");
  assertEquals(chart.extended?.price, 146.2);
  assertEquals(chart.dividends.length, 1);
  assertEquals(chart.splits[0]?.label, "10:1");
});

Deno.test("searchTickers filters and returns normalized results", async () => {
  clearMarketCaches();
  const mockFetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          quotes: [
            { symbol: "AAPL", shortname: "Apple Inc.", exchDisp: "NASDAQ", quoteType: "EQUITY" },
            { symbol: "VWCE.DE", longname: "Vanguard FTSE All-World", exchange: "GER", quoteType: "ETF" },
            { symbol: "NEWS_ITEM", quoteType: "STORY" },
          ],
        }),
        { status: 200 },
      ),
    )) as typeof fetch;

  const results = await searchTickers("aapl", mockFetch);
  assertEquals(results.length, 2);
  assertEquals(results[0].symbol, "AAPL");
  assertEquals(results[1].symbol, "VWCE.DE");
  assert(results.every((r) => r.quoteType !== "STORY"));
});

Deno.test("IBKR tradingHours / liquidHours parser handles Black Friday early close and weekend rollover", () => {
  const tradingHours =
    "20261127:0400-20261127:1700;20261128:CLOSED;20261129:CLOSED;20261130:0400-20261130:2000";
  const liquidHours =
    "20261127:0930-20261127:1300;20261128:CLOSED;20261129:CLOSED;20261130:0930-20261130:1600";

  const parsed = parseIbHoursString(liquidHours, "America/New_York");
  assertEquals(parsed.length, 2);
  // Black Friday Nov 27, 2026: 09:30-13:00 EST = 14:30-18:00 UTC
  assertEquals(parsed[0].start, Date.UTC(2026, 10, 27, 14, 30, 0));
  assertEquals(parsed[0].end, Date.UTC(2026, 10, 27, 18, 0, 0));

  // At 14:00 EST (19:00 UTC) on Black Friday -> POST (after early 13:00 close, before 17:00 extended end)
  const postRes = buildMarketStatusFromIbHours({
    tradingHours,
    liquidHours,
    timeZoneId: "US/Eastern",
    nowMs: Date.UTC(2026, 10, 27, 19, 0, 0),
  });
  assertEquals(postRes.status.state, "POST");
  assertEquals(postRes.status.nextTransitionAt, Date.UTC(2026, 10, 27, 22, 0, 0));

  // At 18:00 EST (23:00 UTC) on Black Friday -> CLOSED, next regular open Monday Nov 30 09:30 EST (14:30 UTC)
  const closedRes = buildMarketStatusFromIbHours({
    tradingHours,
    liquidHours,
    timeZoneId: "US/Eastern",
    nowMs: Date.UTC(2026, 10, 27, 23, 0, 0),
  });
  assertEquals(closedRes.status.state, "CLOSED");
  assertEquals(closedRes.status.nextRegularOpenAt, Date.UTC(2026, 10, 30, 14, 30, 0));
});
