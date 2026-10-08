import {
  deepStrictEqual,
  equal,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import { Database } from "@db/sqlite";
import { ensureSchema } from "../../database/setup.ts";
import {
  createIntegration,
  getUserIntegrations,
} from "../../database/integration.ts";
import {
  buildTrading212Ledger,
  fetchTrading212AccountPerformance,
  parseTrading212Csv,
  reconcileTrading212Account,
} from "./ledger.ts";
import { toCashTransaction } from "./transactions.ts";
import { toTrading212Order, toTrading212Position } from "./adapter.ts";
import {
  buildIntegratedAllTimePerformanceList,
  buildIntegratedAllTimeReport,
  buildIntegratedSoldPerformances,
} from "../../tickers/portfolio.ts";
import type { Trading212AccountSummary } from "./ledger.ts";

const headers = [
  "Action",
  "Time (UTC)",
  "ISIN",
  "Ticker",
  "Name",
  "Notes",
  "ID",
  "No. of shares",
  "Gross Total",
  "Currency (Gross Total)",
  "Net Total",
  "Currency (Net Total)",
  "Currency conversion from amount",
  "Currency (Currency conversion from amount)",
  "Currency conversion to amount",
  "Currency (Currency conversion to amount)",
  "Currency conversion fee",
  "Currency (Currency conversion fee)",
  "Taxes",
  "Currency (Taxes)",
];

Deno.test("empty Trading 212 export intervals can omit the ID column", () => {
  const emptyHeaders =
    "Action,Time (UTC),ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share),Exchange rate,Gross Total,Currency (Gross Total),Withholding tax,Currency (Withholding tax),Taxes,Currency (Taxes),Net Total,Currency (Net Total)";
  deepStrictEqual(parseTrading212Csv(emptyHeaders + "\n"), []);
  throws(
    () =>
      parseTrading212Csv(
        emptyHeaders + "\nDeposit,2026-01-01,,,,,,,,1,EUR,,,,,,\n",
      ),
    /missing IDs/,
  );
});
function row(
  Action: string,
  ID: string,
  amount: string,
  extra: Record<string, string> = {},
) {
  return Object.fromEntries(
    headers.map(
      (h) => [
        h,
        ({
          Action,
          ID,
          "Time (UTC)": "2026-01-01 12:00:00",
          "Gross Total": amount,
          "Currency (Gross Total)": "EUR",
          ...extra,
        } as Record<string, string>)[h] ?? "",
      ],
    ),
  );
}
function csv(rows: Record<string, string>[]) {
  const escape = (s: string) => '"' + s.replaceAll('"', '""') + '"';
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\r\n");
}

Deno.test("dividend-only exports omit IDs and deduplicate against full-history exports with extra empty columns", () => {
  const full = row("Dividend (Dividend)", "", "3", {
    ISIN: "TEST",
    "Net Total": "2",
    "Currency (Net Total)": "EUR",
  });
  const narrow =
    "Action,Time (UTC),ISIN,Gross Total,Currency (Gross Total),Net Total,Currency (Net Total)\nDividend (Dividend),2026-01-01 12:00:00,TEST,3,EUR,2,EUR";
  const rows = [
    ...parseTrading212Csv(csv([full])),
    ...parseTrading212Csv(narrow),
  ];
  const ledger = buildTrading212Ledger(rows, new Set());
  deepStrictEqual(ledger.cash, { EUR: 2 });
  deepStrictEqual(ledger.deposits, {});
  throws(
    () =>
      buildTrading212Ledger(
        [...rows, { ...rows[1], "Net Total": "1" }],
        new Set(),
      ),
    /Conflicting/,
  );
});
const entries = [
  row("Deposit", "external", "100"),
  row("Market buy", "EOF1", "50", {
    ISIN: "TEST",
    "No. of shares": "1",
    Taxes: "-1",
    "Currency (Taxes)": "EUR",
    Name: 'A, "stock"\nname',
  }),
  row("Tax Adjustment", "refund", "5"),
  row("Dividend (Dividend)", "dividend", "3", {
    "Net Total": "2",
    "Currency (Net Total)": "EUR",
  }),
  row("Withdrawal", "outgoing", "-10"),
  row("Deposit", "incoming", "12"),
  row("Withdrawal", "external-withdrawal", "-4"),
];
const summary: Trading212AccountSummary = {
  currency: "EUR",
  totalValue: 120,
  cash: { availableToTrade: 54.96, reservedForOrders: 0, inPies: .04 },
  investments: {
    currentValue: 65,
    totalCost: 50,
    realizedProfitLoss: 0,
    unrealizedProfitLoss: 15,
  },
};
const integration = {
  id: 1,
  kind: "t212",
  userId: 1,
  credentials: {},
  createdAt: new Date(),
  updatedAt: new Date(),
} as const;
const p = toTrading212Position(integration, {
  instrument: { ticker: "TEST_US_EQ", currency: "USD", isin: "TEST" },
  quantity: 1,
  averagePricePaid: 70,
  currentPrice: 80,
  walletImpact: {
    currency: "EUR",
    totalCost: 50,
    currentValue: 65,
    unrealizedProfitLoss: 15,
  },
})!;
const transfers = ["outgoing", "incoming"].map((reference) =>
  toCashTransaction(integration, {
    reference,
    dateTime: "2026-01-01T12:00:00Z",
    amount: reference === "outgoing" ? -10 : 12,
    currency: "EUR",
    type: "TRANSFER",
  })
);
const fx: typeof fetch = () =>
  Promise.resolve(Response.json({ base: "USD", quote: "EUR", rate: .8 }));

Deno.test("CSV cash ledger distinguishes funding, tax refunds and CFD transfers; fees and withholding count once", () => {
  deepStrictEqual(parseTrading212Csv(csv(entries)), entries);
  const ledger = buildTrading212Ledger(
    parseTrading212Csv(csv(entries)),
    new Set(["outgoing", "incoming"]),
  );
  deepStrictEqual(ledger.cash, { EUR: 55 });
  deepStrictEqual(ledger.deposits, { EUR: 100 });
  deepStrictEqual(ledger.withdrawals, { EUR: 4 });
  deepStrictEqual(ledger.quantities, { TEST: 1 });
  deepStrictEqual(
    buildTrading212Ledger(
      [...entries, entries[0]],
      new Set(["outgoing", "incoming"]),
    ).cash,
    ledger.cash,
  );
});

Deno.test("cash conversions and their signed fees are counted without inventing deposits", () => {
  const conversion = row("Currency conversion", "conversion", "", {
    "Currency conversion from amount": "20",
    "Currency (Currency conversion from amount)": "EUR",
    "Currency conversion to amount": "25",
    "Currency (Currency conversion to amount)": "USD",
    "Currency conversion fee": "-0.10",
    "Currency (Currency conversion fee)": "USD",
  });
  const ledger = buildTrading212Ledger([
    row("Deposit", "d", "20"),
    conversion,
    row("Market buy", "b", "24.90", {
      ISIN: "TEST",
      "No. of shares": "1",
      "Currency (Gross Total)": "USD",
    }),
  ], new Set());
  deepStrictEqual(ledger.cash, { EUR: 0, USD: 0 });
  deepStrictEqual(ledger.deposits, { EUR: 20 });
});

Deno.test("account return reconciles deposits, broker value, cash and every position; incomplete data fails", async () => {
  const account = reconcileTrading212Account(
    1,
    entries,
    transfers,
    [p],
    summary,
    new Date("2026-01-02"),
  );
  equal(account.pnl, 24);
  equal(account.netContributions, 96);
  equal(account.cash, 55);
  account.reportedComponents = [{ currency: "EUR", cost: 50, pnl: 15 }];
  const report = await buildIntegratedAllTimeReport({
    positions: [p],
    orders: [],
    currency: "EUR",
    request: fx,
    accountPerformances: [account],
  });
  equal(report?.total.change, 24);
  equal(report?.total.cost, 96);
  equal(report?.performances.reduce((sum, p) => sum + p.change!, 0), 24);
  const text = await buildIntegratedAllTimePerformanceList({
    positions: [p],
    orders: [],
    currency: "EUR",
    request: fx,
    accountPerformances: [account],
    numberOnly: true,
  });
  ok(text.endsWith("+24.00 EUR"));
  throws(
    () =>
      reconcileTrading212Account(
        1,
        entries,
        transfers,
        [{ ...p, amount: 2 }],
        summary,
        new Date(),
      ),
    /share history/,
  );
  throws(
    () =>
      reconcileTrading212Account(1, entries, transfers, [p], {
        ...summary,
        cash: { ...summary.cash, availableToTrade: 1 },
      }, new Date()),
    /cash history/,
  );
  throws(
    () =>
      reconcileTrading212Account(1, entries, transfers, [p], {
        ...summary,
        cash: { ...summary.cash, availableToTrade: 54.95 },
      }, new Date()),
    /cash history/,
  );
  throws(
    () =>
      reconcileTrading212Account(
        1,
        [
          ...entries,
          row("Deposit", "usd", "1", { "Currency (Gross Total)": "USD" }),
        ],
        transfers,
        [p],
        summary,
        new Date(),
      ),
    /historical FX/,
  );
  throws(
    () =>
      buildTrading212Ledger(
        [...entries, row("Mystery cash", "x", "100")],
        new Set(),
      ),
    /Unsupported/,
  );
  await rejects(
    buildIntegratedAllTimeReport({
      positions: [p],
      orders: [],
      currency: "EUR",
      request: fx,
      accountPerformances: [account],
      bucketName: "Partial",
    }),
    /individual bucket/,
  );
});

Deno.test("sell fills retain broker realized result and historical wallet currency instead of price-only FIFO", () => {
  const fill = (side: "BUY" | "SELL") =>
    toTrading212Order(integration, {
      order: {
        side,
        instrument: { ticker: "TEST_US_EQ", currency: "USD", isin: "TEST" },
      },
      fill: {
        id: side === "BUY" ? 1 : 2,
        filledAt: side === "BUY" ? "2026-01-01" : "2026-01-02",
        type: "TRADE",
        quantity: 1,
        price: side === "BUY" ? 100 : 110,
        walletImpact: {
          currency: "EUR",
          netValue: side === "BUY" ? 80 : 89,
          fxRate: 1.25,
          realisedProfitLoss: side === "BUY" ? undefined : 9.5,
          taxes: [{
            name: "CURRENCY_CONVERSION_FEE",
            quantity: -.5,
            currency: "EUR",
          }],
        },
      },
    })!;
  const sell = fill("SELL");
  equal(sell.walletImpact?.netValue, 89);
  const sold = buildIntegratedSoldPerformances([fill("BUY"), sell]);
  equal(sold[0].currency, "EUR");
  equal(sold[0].realizedPnl, 9.5);
  equal(sold[0].proceeds, 89.5);
  equal(sold[0].cost, 80);
  throws(
    () => buildIntegratedSoldPerformances([sell]),
    /Missing purchase history/,
  );
});

Deno.test("pending CSV exports are reused after broker preparation exceeds a minute and downloads never receive credentials", async () => {
  const db = new Database(":memory:");
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = Date.parse("2026-01-02T12:00:00Z"),
    requested = 0,
    exportTo = "",
    ready = false;
  Date.now = () => now;
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1)");
    createIntegration({
      database: db,
      userId: 1,
      kind: "t212",
      credentials: { apiKey: "ledger-test", secretKey: "secret" },
    });
    const i = getUserIntegrations(db, 1)[0];
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.host === "export.example") {
        equal(new Headers(init?.headers).has("Authorization"), false);
        return Promise.resolve(new Response(csv(entries)));
      }
      if (url.pathname.endsWith("transactions")) {
        return Promise.resolve(
          Response.json({
            items: transfers.map((t) => ({
              reference: t.reference,
              dateTime: t.date.toISOString(),
              amount: t.amount,
              currency: t.currency,
              type: t.type,
            })),
            nextPagePath: null,
          }),
        );
      }
      if (url.pathname.endsWith("summary")) {
        return Promise.resolve(Response.json(summary));
      }
      if (url.pathname.endsWith("exports") && init?.method === "POST") {
        requested++;
        exportTo = JSON.parse(String(init.body)).timeTo;
        return Promise.resolve(Response.json({ reportId: 123 }));
      }
      if (url.pathname.endsWith("exports")) {
        return Promise.resolve(Response.json(
          requested
            ? [{
              reportId: 123,
              status: ready ? "Finished" : "Queued",
              timeFrom: "2026-01-01T00:00:00.000Z",
              timeTo: exportTo,
              dataIncluded: {
                includeDividends: true,
                includeInterest: true,
                includeOrders: true,
                includeTransactions: true,
              },
              downloadLink: "https://export.example/report",
            }]
            : [],
        ));
      }
      throw Error("Unexpected endpoint");
    };
    const positions = [{ ...p, integrationId: i.id }];
    const orders = [
      toTrading212Order(i, {
        order: {
          side: "BUY",
          instrument: { ticker: "TEST_US_EQ", currency: "USD", isin: "TEST" },
        },
        fill: {
          id: 1,
          type: "TRADE",
          quantity: 1,
          price: 70,
          filledAt: "2026-01-01T12:00:00Z",
        },
      })!,
    ];
    await rejects(
      fetchTrading212AccountPerformance(db, i, positions, orders),
      /preparing/,
    );
    now += 120000;
    ready = true;
    const result = await fetchTrading212AccountPerformance(
      db,
      i,
      positions,
      orders,
    );
    equal(result.pnl, 24);
    equal(requested, 1);
    now += 120000;
    equal(
      (await fetchTrading212AccountPerformance(db, i, positions, orders)).pnl,
      24,
    );
    equal(requested, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    db.close();
  }
});
