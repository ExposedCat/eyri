import { deepStrictEqual } from "node:assert/strict";
import { defaultYahooSymbols, likelyYahooSymbols } from "./symbols.ts";

Deno.test("default Yahoo patterns cover broker suffixes without metadata and remain currency scoped", () => {
  for (
    const [ticker, currency, expected] of [
      ["AAPL_US_EQ", "USD", ["AAPL"]],
      ["2DGd_EQ", "EUR", ["2DG.DE", "2DG.F"]],
      ["SOIp_EQ", "EUR", ["SOI.PA"]],
      ["IQEl_EQ", "GBX", ["IQE.L"]],
      ["VODL_EQ", "GBP", ["VOD.L"]],
      ["SMSNL_EQ", "USD", ["SMSN.IL", "SMSN.L"]],
      ["SOIP_EQ", "USD", []],
      ["UNKNOWN_EQ", "EUR", []],
      ["BRK.B", "USD", ["BRK-B"]],
      ["BRK B", "USD", ["BRK-B"]],
      ["CRDO.US", "USD", ["CRDO", "CRDO.US"]],
      ["BRK.B.US", "USD", ["BRK-B", "BRK.B.US"]],
      ["AAPL", "USD", ["AAPL"]],
      ["VUAA", "USD", ["VUAA.L", "VUAA"]],
      ["SPYL", "USD", ["SPYL.L", "SPYL"]],
      ["VOD", "GBP", ["VOD.L", "VOD"]],
      ["VOD", "GBX", ["VOD.L", "VOD"]],
      ["VOD.L", "GBX", ["VOD.L"]],
      ["SAP.F", "EUR", ["SAP.F"]],
      ["SMSN.L", "USD", ["SMSN.L"]],
      ["SAP", "EUR", ["SAP"]],
      ["+APH.15JAN2027.C200", "USD", []],
    ] as const
  ) {
    deepStrictEqual(defaultYahooSymbols({ ticker, currency }), expected);
  }
  deepStrictEqual(
    defaultYahooSymbols({
      ticker: "2DGD_EQ",
      currency: "EUR",
      yahooSymbol: "2DG.DE",
    }),
    ["2DG.DE", "2DG.F"],
  );
  deepStrictEqual(
    defaultYahooSymbols({
      ticker: "SMSNL_EQ",
      currency: "USD",
      yahooSymbol: "SMSN.L",
    }),
    ["SMSN.IL", "SMSN.L"],
  );
});

Deno.test("likely Yahoo candidates are bounded, currency scoped, normalized and exclude already tried defaults", () => {
  for (
    const [ticker, currency, expected] of [
      ["CSPX", "USD", ["CSPX.L", "CSPX.IL"]],
      ["VWCE", "EUR", [
        "VWCE.DE",
        "VWCE.F",
        "VWCE.PA",
        "VWCE.AS",
        "VWCE.MI",
        "VWCE.MC",
      ]],
      ["CSPX.US", "USD", ["CSPX.L", "CSPX.IL"]],
      ["ABC_US_EQ", "USD", ["ABC.L", "ABC.IL"]],
      ["2DGD_EQ", "EUR", ["2DG.PA", "2DG.AS", "2DG.MI", "2DG.MC"]],
      ["ABC", "CAD", ["ABC.TO", "ABC.V"]],
      ["700", "HKD", ["0700.HK"]],
      ["VOD", "GBP", []],
      ["VUAA", "USD", ["VUAA.IL"]],
      ["UNKNOWN_EQ", "EUR", []],
      ["+APH.15JAN2027.C200", "USD", []],
    ] as const
  ) deepStrictEqual(likelyYahooSymbols({ ticker, currency }), expected);
});
