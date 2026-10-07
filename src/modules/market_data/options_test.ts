import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { historicalQuoteMultiplier, yahooOptionContract } from "./options.ts";

Deno.test("Freedom24 and IBKR option symbols map expiry, right and fractional strike exactly", () => {
  for (
    const [ticker, symbol, expiry] of [
      ["+BOTZ.15MAR2024.C33", "BOTZ240315C00033000", "2024-03-15"],
      ["+AMD.15JAN2027.C280", "AMD270115C00280000", "2027-01-15"],
      ["+MU.26JUN2026.P850", "MU260626P00850000", "2026-06-26"],
      ["+TSM.15MAR2024.C148.125", "TSM240315C00148125", "2024-03-15"],
      ["AMD   270115C00280000", "AMD270115C00280000", "2027-01-15"],
      ["AMD270115C00280000", "AMD270115C00280000", "2027-01-15"],
    ]
  ) {
    equal(yahooOptionContract(ticker)?.symbol, symbol);
    equal(yahooOptionContract(ticker)?.expiry, expiry);
  }
  for (
    const ticker of [
      "AAPL",
      "+AMD.31FEB2027.C280",
      "+AMD.15JAN2027.C10.0001",
      "AMD271332C00280000",
    ]
  ) equal(yahooOptionContract(ticker), null);
});

Deno.test("historical option premium multipliers respect broker units and contract metadata", () => {
  equal(
    historicalQuoteMultiplier({
      ticker: "+AMD.15JAN2027.C280",
      integrationKind: "f24",
    }),
    100,
  );
  equal(
    historicalQuoteMultiplier({
      ticker: "+NANOS.29SEP2025.C666",
      integrationKind: "f24",
    }),
    1,
  );
  equal(
    historicalQuoteMultiplier({
      ticker: "AMD270115C00280000",
      integrationKind: "ibkr",
    }),
    1,
  );
  equal(
    historicalQuoteMultiplier({
      ticker: "+AMD.15JAN2027.C280",
      integrationKind: "f24",
      historicalPriceMultiplier: 10,
    }),
    10,
  );
  throws(
    () =>
      historicalQuoteMultiplier({
        ticker: "AAPL",
        integrationKind: "f24",
        historicalPriceMultiplier: 0,
      }),
    /Invalid contract multiplier/,
  );
  deepStrictEqual(yahooOptionContract("+AMD.15JAN2027.C280"), {
    underlying: "AMD",
    expiry: "2027-01-15",
    symbol: "AMD270115C00280000",
  });
});
