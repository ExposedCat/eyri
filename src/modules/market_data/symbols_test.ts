import { deepStrictEqual } from "node:assert/strict";
import { defaultYahooSymbols } from "./symbols.ts";

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
