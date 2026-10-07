import { deepStrictEqual, equal } from "node:assert/strict";
import {
  adjustOrderForCorporateActions,
  currentStockTicker,
  optionHistorySegments,
} from "./corporate_actions.ts";
import type { IntegrationOrder } from "../integrations/types.ts";

function order(ticker: string, date: string): IntegrationOrder {
  return {
    integrationId: 1,
    integrationKind: "f24",
    account: "one",
    ticker,
    date: new Date(date),
    currency: "USD",
    quantity: 1,
    price: 600,
    assetCategory: "OPT",
  };
}
Deno.test("verified rename is currency scoped and option adjustments preserve cost and bucket identity", () => {
  equal(currentStockTicker("VSCO.US", "USD"), "VSXY.US");
  equal(currentStockTicker("VSCO", "EUR"), "VSCO");
  const original = order("+APH.15JAN2027.C200", "2026-08-31");
  const adjusted = adjustOrderForCorporateActions(original, "2026-10-07");
  equal(adjusted.ticker, "+APH.15JAN2027.C100");
  equal(adjusted.quantity, 2);
  equal(adjusted.price, 300);
  equal(adjusted.transactionKey, '["2026-08-31","+APH.15JAN2027.C200","USD"]');
  equal(original.ticker, "+APH.15JAN2027.C200");
  equal(
    adjustOrderForCorporateActions(original, "2026-09-02").ticker,
    original.ticker,
  );
  equal(
    adjustOrderForCorporateActions(
      order("+APH.15JAN2027.C200", "2026-09-03"),
      "2026-10-07",
    ).ticker,
    original.ticker,
  );
  equal(
    adjustOrderForCorporateActions(
      order("APH270115P00200000", "2026-08-31"),
      "2026-10-07",
    ).ticker,
    "APH270115P00100000",
  );
  equal(
    adjustOrderForCorporateActions(
      order("+APH.21JUN2024.C200", "2024-05-31"),
      "2026-10-07",
    ).ticker,
    "+APH.21JUN2024.C100",
  );
  const twice = adjustOrderForCorporateActions(
    order("+APH.15JAN2027.C200", "2024-05-31"),
    "2026-10-07",
  );
  equal(twice.ticker, "+APH.15JAN2027.C50");
  equal(twice.quantity, 4);
  equal(twice.price, 150);
  equal(
    adjustOrderForCorporateActions(
      { ...original, transactionKey: "custom" },
      "2026-10-07",
    )
      .transactionKey,
    "custom",
  );
});
Deno.test("option history follows predecessor strikes and scales premiums into final contract units", () => {
  deepStrictEqual(
    optionHistorySegments(
      "+APH.15JAN2027.C100",
      "USD",
      "2026-08-24",
      "2026-10-08",
      "2026-10-07",
    ),
    [
      {
        ticker: "+APH.15JAN2027.C200",
        start: "2026-08-24",
        end: "2026-09-03",
        priceFactor: .5,
      },
      {
        ticker: "+APH.15JAN2027.C100",
        start: "2026-09-03",
        end: "2026-10-08",
        priceFactor: 1,
      },
    ],
  );
  deepStrictEqual(
    optionHistorySegments(
      "APH270115C00100000",
      "USD",
      "2026-08-24",
      "2026-09-02",
      "2026-10-07",
    ),
    [
      {
        ticker: "APH270115C00200000",
        start: "2026-08-24",
        end: "2026-09-02",
        priceFactor: .5,
      },
    ],
  );
  deepStrictEqual(
    optionHistorySegments(
      "+BOTZ.15MAR2024.C33",
      "USD",
      "2024-02-08",
      "2024-03-16",
      "2026-10-07",
    ),
    [
      {
        ticker: "+BOTZ.15MAR2024.C33",
        start: "2024-02-08",
        end: "2024-03-16",
        priceFactor: 1,
      },
    ],
  );
});
