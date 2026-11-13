import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { loadChartFx } from "./chart_fx.ts";
import { historicalUsdFactor } from "../../utils/exchange_rates.ts";

const start = "2025-01-02", end = "2025-01-04";
const online: typeof fetch = async input => {
  const url = new URL(String(input));
  return Response.json(url.pathname.includes("/rate/")
    ? { base: "USD", quote: "EUR", rate: .8 }
    : [{ base: "USD", quote: "EUR", date: "2025-01-01", rate: 1 },
      { base: "USD", quote: "EUR", date: end, rate: .8 }]);
};

Deno.test("chart FX keeps historical returns when rates are available", async () => {
  const db = new Database(":memory:");
  try {
  const fx = await loadChartFx(db, ["USD", "EUR"], start, end, online);
  equal(fx.ignoreFx, false);
  equal(fx.rates.get("EUR"), 1.25);
  equal(historicalUsdFactor(fx.historical, "EUR", start), 1);
  } finally { db.close(); }
});

Deno.test("FX outage reuses a saved conversion and excludes currency P/L consistently", async () => {
  const db = new Database(":memory:");
  try {
  await loadChartFx(db, ["EUR"], start, end, online);
  const offline: typeof fetch = async () => { throw new TypeError("fetch failed"); };
  const fx = await loadChartFx(db, ["USD", "EUR"], start, "2025-01-05", offline);
  equal(fx.ignoreFx, true);
  equal(fx.rates.get("EUR"), 1.25);
  equal(historicalUsdFactor(fx.historical, "EUR", start), 1.25);
  equal(historicalUsdFactor(fx.historical, "EUR", "2025-01-05"), 1.25);
  match(fx.notes.join(" "), /saved EUR conversion from 2025-01-04/);
  const reply = await fx.request("https://api.frankfurter.dev/v2/rate/usd/eur");
  equal((await reply.json()).rate, .8);
  } finally { db.close(); }
});

Deno.test("invalid spot FX uses historical conversion, without silently accepting the bad rate", async () => {
  const db = new Database(":memory:");
  try {
  const request: typeof fetch = (input, init) => new URL(String(input)).pathname.includes("/rate/")
    ? Promise.resolve(Response.json({ base: "USD", quote: "EUR", rate: -1 })) : online(input, init);
  const fx = await loadChartFx(db, ["EUR"], start, end, request);
  equal(fx.ignoreFx, true);
  equal(fx.rates.get("EUR"), 1.25);
  equal(historicalUsdFactor(fx.historical, "EUR", start), 1.25);
  } finally { db.close(); }
});

Deno.test("missing conversion leaves USD usable and never assumes one foreign unit equals a dollar", async () => {
  const db = new Database(":memory:");
  try {
  const fx = await loadChartFx(db, ["USD", "EUR"], start, end, async () => new Response("", { status: 503 }));
  deepStrictEqual([...fx.rates], [["USD", 1]]);
  equal(fx.historical.has("EUR"), false);
  match(fx.notes.join(" "), /EUR conversion unavailable/);
  await rejects(fx.request("https://api.frankfurter.dev/v2/rate/usd/eur"), /EUR conversion rate is missing/);
  } finally { db.close(); }
});

Deno.test("unreadable FX trades force the same fixed conversion basis for actual and index", async () => {
  const db = new Database(":memory:");
  try {
  const fx = await loadChartFx(db, ["EUR"], start, end, online, true);
  equal(fx.ignoreFx, true);
  equal(historicalUsdFactor(fx.historical, "EUR", start), fx.rates.get("EUR"));
  } finally { db.close(); }
});
