import { equal, match, ok } from "node:assert/strict";
import {
  httpError,
  IntegrationDataError,
  networkError,
  userErrorMessage,
  UserFacingError,
} from "./user_error.ts";
import {
  fetchHistoricalUsdConversionRates,
  fetchUsdConversionRates,
  historicalUsdFactor,
} from "./exchange_rates.ts";

Deno.test("public errors keep known causes and actions, hiding diagnostic details", () => {
  const error = new UserFacingError("IBKR is logging in. Please wait.", {
    detail: "secret internal stack",
  });
  equal(userErrorMessage(error), "IBKR is logging in. Please wait.");
  const grouped = new IntegrationDataError([{
    label: "ibkr (private-host:4003)",
    publicLabel: "IBKR",
    error,
  }]);
  equal(userErrorMessage(grouped), "IBKR: IBKR is logging in. Please wait.");
  equal(
    userErrorMessage(new Error("secret unexpected provider response"), "42"),
    "Unexpected bot error (42). Send this code to admin.",
  );
  equal(
    userErrorMessage(
      new Error("S&P 500 benchmark (CSPX.L) unavailable: outage", {
        cause: httpError("Yahoo history", 429, "Retry shortly."),
      }),
    ),
    "Yahoo history: request limit reached (HTTP 429). Retry shortly.",
  );
  equal(
    userErrorMessage(
      new Error("Momentum benchmark (IUMO.L) unavailable: Unavailable"),
    ),
    "Momentum price feed unavailable. Retry.",
  );
});

Deno.test("API status errors distinguish limits, credentials and permissions", () => {
  match(userErrorMessage(httpError("Freedom24", 401)), /401.*Update.*API key/);
  match(
    userErrorMessage(httpError("Trading 212", 403)),
    /403.*read permissions/,
  );
  equal(
    userErrorMessage(
      networkError("FX service", new DOMException("deadline", "TimeoutError")),
    ),
    "FX service timed out. Retry.",
  );
  equal(
    userErrorMessage({ error_code: 429, parameters: { retry_after: 13 } }),
    "Telegram request limit reached. Retry in 13 seconds.",
  );
});

Deno.test("FX errors identify HTTP failure, missing currency, unusable response and actual last rate", async () => {
  for (
    const [request, expected] of [
      [async () => new Response(null, { status: 429 }), /HTTP 429.*Retry/],
      [
        async () => new Response(null, { status: 404 }),
        /no EUR rate.*currency support/,
      ],
      [
        async () => Response.json({ base: "USD", quote: "EUR", rate: 0 }),
        /nonpositive/,
      ],
      [
        async () => Response.json({ base: "USD", quote: "EUR", rate: "oops" }),
        /nonnumeric/,
      ],
      [
        async () => Response.json({ base: "USD", quote: "GBP", rate: 1 }),
        /wrong currency pair/,
      ],
    ] as const
  ) {
    try {
      await fetchUsdConversionRates(["EUR"], request);
      throw new Error("Expected error");
    } catch (error) {
      match(userErrorMessage(error), expected);
    }
  }
  try {
    historicalUsdFactor(
      new Map([["EUR", [{ date: "2025-01-01", factor: 1 }]]]),
      "EUR",
      "2025-01-10",
    );
  } catch (error) {
    match(userErrorMessage(error), /last rate is 2025-01-01.*2025-01-10/);
  }
  try {
    await fetchHistoricalUsdConversionRates(
      ["EUR"],
      "2025-01-01",
      "2025-01-10",
      async () => Response.json([]),
    );
  } catch (error) {
    match(userErrorMessage(error), /EUR.*history is empty/);
  }
});

Deno.test("legacy validation errors identify the observed issue without inventing transfers or auth expiry", () => {
  const cases = [
    ["Unsupported IBKR cash transaction type: Refund", "Refund"],
    ["IBKR funding transaction ID is missing.", "cash IDs are missing"],
    [
      "Account funding cannot be assigned to an individual bucket",
      "Bot mixed account and bucket funding",
    ],
    [
      "Bucket quantity for AAPL exceeds the live holding.",
      "saved bucket shares exceed holdings",
    ],
    ["Invalid provisional purchase cost for AAPL", "AAPL"],
    [
      "This chart predates index switching. Create a new chart with /chart.",
      "Saved index details are missing",
    ],
  ];
  for (const [input, observed] of cases) {
    const message = userErrorMessage(new Error(input), "test");
    ok(message.includes(observed), message);
    ok(!/expired|transfers between/i.test(message), message);
    ok(message.length < 160, message);
  }
});
