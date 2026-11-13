// Public messages contain an observed cause and an action. Diagnostic details
// and provider responses stay on the error for logs, never in a chat reply.
export class UserFacingError extends Error {
  readonly userMessage: string;
  readonly code: string;
  constructor(
    message: string,
    options: { detail?: string; cause?: unknown; code?: string } = {},
  ) {
    super(options.detail ?? message, { cause: options.cause });
    this.name = "UserFacingError";
    this.userMessage = message;
    this.code = options.code ?? "data";
  }
}

export class IntegrationDataError extends AggregateError {
  constructor(
    readonly failures: {
      label: string;
      publicLabel?: string;
      error: unknown;
    }[],
  ) {
    super(
      failures.map((f) => f.error),
      `Failed to fetch integration data:\n${
        failures.map((f) =>
          `${f.label}: ${
            f.error instanceof Error ? f.error.message : String(f.error)
          }`
        ).join("\n")
      }`,
    );
    this.name = "IntegrationDataError";
  }
}

export function networkError(source: string, cause: unknown): UserFacingError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const timedOut = cause instanceof Error &&
      ["TimeoutError", "AbortError"].includes(cause.name) ||
    /timed? ?out/i.test(detail);
  return new UserFacingError(
    `${source} ${timedOut ? "timed out" : "connection failed"}. Retry.`,
    { detail, cause, code: "network" },
  );
}

export function httpError(
  source: string,
  status: number,
  action?: string,
): UserFacingError {
  const next = action ??
    (status === 401
      ? "Update the API key in /integrations."
      : status === 403
      ? "Check API read permissions."
      : status === 429
      ? "Retry in a minute."
      : "Retry shortly.");
  const state = status === 401
    ? "authentication rejected"
    : status === 403
    ? "access denied"
    : status === 404
    ? "data not found"
    : status === 429
    ? "request limit reached"
    : status >= 500
    ? "server error"
    : "request rejected";
  return new UserFacingError(`${source}: ${state} (HTTP ${status}). ${next}`, {
    code: status === 429 ? "rate_limit" : "http",
  });
}

// Compatibility for existing validators. New checks should throw
// UserFacingError at the source, with the instrument/field and measured values.
const rules: [RegExp, string | ((match: RegExpMatchArray) => string)][] = [
  [
    /^database(?: table)? is (?:locked|busy)\b/i,
    "The bot's database is busy. Retry shortly.",
  ],
  [
    /funding history is syncing/i,
    "IBKR funding is downloading. Retry after the next sync.",
  ],
  [
    /funding history import failed:.*(?:1003|Statement is not available)/is,
    "IBKR statement is not published yet. Retry later.",
  ],
  [
    /Flex.*1025|Too many requests/is,
    "IBKR report limit reached. Wait for the scheduled retry.",
  ],
  [
    /funding.*requires.*Flex Query|funding report is missing|funding requires exactly one/is,
    "IBKR funding fields are missing. Update the Activity Flex query.",
  ],
  [
    /funding query must include exactly|funding account identity mismatch|funding statement does not match/i,
    "IBKR statement account differs. Select the Gateway account in Flex.",
  ],
  [
    /truncated or overlapping period/i,
    "IBKR statement dates are incomplete. Enable custom date ranges in Flex.",
  ],
  [
    /security\/account transfers require/i,
    "IBKR reported an asset/account transfer. Ask admin to import its value.",
  ],
  [
    /unsupported IBKR cash transaction type: (.+)/i,
    (m) => `IBKR cash type “${m[1]}” is unsupported. Ask admin to add it.`,
  ],
  [
    /Cash Transactions summary is missing|Cash Transactions must use detail/i,
    "IBKR cash details are missing. Enable DETAIL rows in Flex.",
  ],
  [
    /Cash Report must exclude segments/i,
    "IBKR repeats currency totals. Disable Flex segments and MTD/YTD rows.",
  ],
  [
    /IBKR funding transaction ID is missing/i,
    "IBKR cash IDs are missing. Enable Transaction ID in Activity Flex.",
  ],
  [
    /Conflicting IBKR funding transactions/i,
    "IBKR repeated a cash ID with different values. Ask admin to check the import.",
  ],
  [
    /IBKR funding contains another account/i,
    "IBKR cash rows belong to another account. Select one account in Flex.",
  ],
  [
    /IBKR funding cash transaction is outside/i,
    "IBKR cash date falls outside its statement. Ask admin to check date parsing.",
  ],
  [
    /Invalid IBKR cash transaction currency/i,
    "IBKR cash currency is missing/unrecognized. Ask admin to check the import.",
  ],
  [
    /Invalid IBKR funding currency conversion/i,
    "IBKR funding FX rate is nonpositive/missing. Enable FX Rate to Base in Flex.",
  ],
  [
    /funding transactions do not reconcile with Cash Report/i,
    "IBKR funding rows differ from statement totals. Remove Flex filters.",
  ],
  [
    /cash discontinuity between annual statements/i,
    "IBKR yearly cash totals differ. Ask admin to refresh statements.",
  ],
  [
    /account starts with assets|funding report starts with assets/i,
    "Opening assets have no funding history. Ask admin to import the earlier statement.",
  ],
  [
    /funding history exceeds 100/i,
    "IBKR history exceeds the import limit. Ask admin to extend it.",
  ],
  [
    /Grant Activity needs/i,
    "IBKR award details are missing. Add date, symbol and quantity to Flex.",
  ],
  [
    /commission.*Flex|IBKR historical cash requires Commission/i,
    "IBKR fees are missing. Enable Commission in the trade Flex query.",
  ],
  [
    /IBKR.*no managed accounts/i,
    "IBKR returned no accounts. Check Gateway login.",
  ],
  [
    /IBKR.*summary.*missing|IBKR returned no cash balances/i,
    "IBKR omitted balances. Retry; if unchanged, ask admin.",
  ],
  [
    /IBKR contract identity unavailable for (\S+)/i,
    (m) => `${m[1]}: IBKR omitted contract details. Retry.`,
  ],
  [
    /IBKR.*(?:disconnected|connection.*reset)|Timed out.*IBKR/i,
    "IBKR connection interrupted. Retry.",
  ],
  [
    /Freedom24.*does not cover.*lifetime/is,
    "Freedom24 report dates are incomplete. Ask admin to refresh the report.",
  ],
  [
    /(?:Incomplete|Invalid) Freedom24 broker report(?: number| date)?: (.+)/i,
    (m) => `Freedom24 sent bad/missing ${m[1]}. Ask admin to check the import.`,
  ],
  [
    /Unsupported Freedom24 cash movement type: (.+)/i,
    (m) => `Freedom24 cash type “${m[1]}” is unsupported. Ask admin to add it.`,
  ],
  [
    /Freedom24 external security transfers/i,
    "Freedom24 reported incoming/outgoing shares. Ask admin to import their cost.",
  ],
  [
    /Freedom24.*(?:snapshot does not match|components do not reconcile|do not reconcile|history is incomplete)/i,
    "Freedom24 report totals differ. Retry; if unchanged, ask admin.",
  ],
  [
    /Freedom24 order history pagination did not advance/i,
    "Freedom24 repeated a history page. Retry.",
  ],
  [
    /Freedom24 cash movement has no ID/i,
    "Freedom24 cash entry lacks an ID. Ask admin to check the import.",
  ],
  [
    /Conflicting Freedom24 cash movements/i,
    "Freedom24 repeated a cash ID with different values. Ask admin to check the import.",
  ],
  [
    /Freedom24 funding currency signs disagree/i,
    "Freedom24 native and USD funding have opposite signs. Ask admin to check the import.",
  ],
  [
    /Unsupported Freedom24 off-balance/i,
    "Freedom24 reported off-balance cash. Ask admin to add support.",
  ],
  [
    /Freedom24.*falls outside/i,
    "Freedom24 entry date falls outside its report. Ask admin to check date parsing.",
  ],
  [
    /Invalid or duplicate Freedom24 cash currency/i,
    "Freedom24 cash currencies are missing or repeated. Ask admin to check the report.",
  ],
  [
    /Freedom24.*(?:response did not include|Invalid|Conflicting|missing|outside|disagree|off.balance)/i,
    "Freedom24 returned inconsistent data. Ask admin to check the import.",
  ],
  [
    /Trading 212 is preparing/i,
    "Trading 212 export is preparing. Retry in a minute.",
  ],
  [
    /Trading 212 cash-and-trade export failed/i,
    "Trading 212 export failed. Retry to request another.",
  ],
  [
    /Trading 212 rate limit reached/i,
    "Trading 212 request limit reached. Retry later.",
  ],
  [
    /Trading 212 request failed or timed out/i,
    "Trading 212 request timed out. Retry.",
  ],
  [
    /Trading 212 CSV events are missing IDs/i,
    "Trading 212 export lacks event IDs. Request a fresh export.",
  ],
  [
    /Conflicting Trading 212 CSV rows/i,
    "Trading 212 export repeats an event with different values. Request a fresh export.",
  ],
  [
    /Trading 212 CSV trade is missing ISIN/i,
    "Trading 212 trade lacks a security ID. Request a fresh export.",
  ],
  [
    /Trading 212.*unsupported corporate action \((.+?)\)/i,
    (m) => `Trading 212 event “${m[1]}” is unsupported. Ask admin to add it.`,
  ],
  [
    /Unsupported Trading 212 CSV action: (.+)/i,
    (m) => `Trading 212 event “${m[1]}” is unsupported. Ask admin to add it.`,
  ],
  [
    /external funding in other currencies/i,
    "Trading 212 funding FX is missing. Ask admin to add currency support.",
  ],
  [
    /non-account-currency cash requires/i,
    "Trading 212 omitted currency balances. Ask admin to add currency support.",
  ],
  [
    /current CFD account value/i,
    "Trading 212 CFD balance is missing. Ask admin to add its valuation.",
  ],
  [
    /Trading 212.*(?:does not reconcile|does not match|missing ISIN|missing broker wallet)/i,
    "Trading 212 export differs from live holdings. Refresh the export.",
  ],
  [
    /Trading 212.*(?:Invalid|Malformed|Unterminated|Conflicting|missing|history is empty)|Invalid Trading 212/i,
    "Trading 212 export data is unreadable. Request a fresh export.",
  ],
  [
    /Complete Trading 212 history is required/i,
    "Trading 212 history is empty. Check History read permissions.",
  ],
  [
    /historical.*exchange rates? unavailable.*HTTP (\d+)/i,
    (m) => `FX history service: HTTP ${m[1]}. Retry shortly.`,
  ],
  [
    /Historical USD exchange rate unavailable for (\S+) on (\S+)/i,
    (m) => `${m[1]}: no FX rate near ${m[2]}. Retry; if unchanged, ask admin.`,
  ],
  [
    /Historical exchange rates unavailable for (\S+)/i,
    (m) =>
      `${
        m[1]
      }: FX service returned no history. Ask admin to check currency support.`,
  ],
  [
    /Could not load USD exchange rate for (\S+)/i,
    (m) => `${m[1]}: FX request failed. Retry.`,
  ],
  [
    /Currency conversion unavailable for (\S+)|Conversion unavailable for (\S+)/i,
    (m) => `${m[1] ?? m[2]}: conversion rate is missing. Retry.`,
  ],
  [
    /Invalid historical exchange rates/i,
    "FX service returned unreadable rates. Retry.",
  ],
  [
    /Purchase history (?:is )?missing for (?:sale of )?([^.;\n]+)/i,
    (m) =>
      `${m[1]}: earlier buys are missing. Ask admin to refresh trade history.`,
  ],
  [
    /Missing purchase history for Trading 212 sale (\S+)/i,
    (m) => `${m[1]}: earlier buys are missing. Refresh the Trading 212 export.`,
  ],
  [
    /No purchase history|No dated portfolio history/i,
    "No dated trades found. Wait for history sync, then retry.",
  ],
  [
    /Historical quantity does not reconcile for (\S+)/i,
    (m) =>
      `${
        m[1]
      }: trade count differs from holdings. Retry; if unchanged, ask admin.`,
  ],
  [
    /Historical clos(?:e|ing price) unavailable.*for (\S+)/i,
    (m) =>
      `${m[1]}: first price is missing. Ask admin to check its price source.`,
  ],
  [
    /Historical close unavailable for (\S+) on (\S+)/i,
    (m) => `${m[1]}: no price on/before ${m[2]}. Check /yahoo mapping.`,
  ],
  [
    /Cannot build report: (.+) is unavailable\.?/i,
    (m) => `${m[1]} is missing. Retry; if unchanged, ask admin.`,
  ],
  [
    /Cannot build report: incomplete valuation for (\S+)/i,
    (m) => `${m[1]}: broker price or cost is missing. Retry.`,
  ],
  [
    /Cannot reconcile incomplete position valuations/i,
    "Broker price or cost is missing. Retry; if unchanged, ask admin.",
  ],
  [
    /Current price or book cost unavailable for (\S+)/i,
    (m) => `${m[1]}: broker price or cost is missing. Retry.`,
  ],
  [
    /Missing execution cash price for (\S+)/i,
    (m) => `${m[1]}: execution price is missing. Refresh trade history.`,
  ],
  [
    /Unsupported currency conversion (\S+)/i,
    (m) =>
      `FX trade “${m[1]}” is unsupported. Ask admin to check the importer.`,
  ],
  [
    /Invalid FX execution rate for (\S+)/i,
    (m) =>
      `${m[1]}: broker FX rate is unusable. Ask admin to check the import.`,
  ],
  [
    /Invalid dated account funding/i,
    "A funding date or amount is unusable. Ask admin to check the import.",
  ],
  [
    /Dated account funding does not reconcile/i,
    "Funding entries differ from their total. Ask admin to check the import.",
  ],
  [
    /Historical (\S+) cash does not reconcile/i,
    (m) =>
      `${m[1]} cash entries differ from the statement. Refresh the ledger.`,
  ],
  [
    /Complete dated external funding is required/i,
    "Deposit dates are missing. Wait for funding sync, then retry.",
  ],
  [
    /Complete broker cash history is required/i,
    "Cash history is missing. Refresh the integration ledger.",
  ],
  [
    /complete account funding is required/i,
    "Deposit coverage is incomplete. Wait for funding sync, then retry.",
  ],
  [
    /total deposits must be positive/i,
    "No funded capital in this view. Use money values.",
  ],
  [
    /deposit and withdrawal dates are missing or incomplete/i,
    "Deposit/withdrawal dates are incomplete. Wait for funding sync, then retry.",
  ],
  [
    /Duplicate account (?:reconciliation|valuation)/i,
    "Bot counted an account twice. Ask admin to fix the report.",
  ],
  [
    /Account deposits and withdrawals must be nonnegative/i,
    "Bot funding totals have wrong signs. Ask admin to check the import.",
  ],
  [
    /Account funding cannot be assigned to an individual bucket/i,
    "Bot mixed account and bucket funding. Ask admin to fix the report.",
  ],
  [
    /Excluded bucket capital exceeds account deposits/i,
    "Bucket cost exceeds recorded deposits. Ask admin to check allocation accounting.",
  ],
  [
    /Invalid cash-funded bucket purchase/i,
    "Bot calculated an unusable bucket cost. Ask admin to check allocations.",
  ],
  [
    /Bucket holding (\S+) is absent/i,
    (m) =>
      `${m[1]}: saved bucket shares are no longer held. Review /bucket move.`,
  ],
  [
    /Bucket quantity for (\S+) exceeds/i,
    (m) => `${m[1]}: saved bucket shares exceed holdings. Review /bucket move.`,
  ],
  [
    /Configure an integration|owner's integration is not configured/i,
    "Broker connection missing. Open /integrations.",
  ],
  [
    /credential (\S+) is required|API (?:key|secret) is required/i,
    "API credentials are missing. Update /integrations.",
  ],
  [
    /credential .*positive|instance URL|Invalid URL/i,
    "Broker connection settings are unusable. Update /integrations.",
  ],
  [
    /benchmark cannot fund.*withdrawals/i,
    "Index value is below the withdrawal. Ask admin to review the comparison.",
  ],
  [
    /benchmark allocation exceeds/i,
    "Bot allocated more index capital than deposited. Ask admin to check allocations.",
  ],
  [
    /benchmark closing price unavailable on (\S+)/i,
    (m) =>
      `Index purchase price missing for ${
        m[1]
      }. Ask admin to check its history.`,
  ],
  [
    /benchmark must use/i,
    "Bot selected the wrong index listing. Ask admin to fix its mapping.",
  ],
  [
    /benchmark has no valid prices/i,
    "Index service returned no usable prices. Retry or switch index.",
  ],
  [
    /Invalid .*benchmark (stock split|purchase|date range|valuation FX)/i,
    (m) => `Index ${m[1]} data is unusable. Ask admin to check the source.`,
  ],
  [
    /benchmark valuation FX unavailable for (\S+) on (\S+)/i,
    (m) => `Index FX missing: ${m[1]}, ${m[2]}. Retry.`,
  ],
  [
    /Invalid provisional purchase cost for (\S+)/i,
    (m) =>
      `${
        m[1]
      }: bot estimated an unusable funding amount. Ask admin to check it.`,
  ],
  [
    /Gift price history is missing for (\S+)/i,
    (m) => `${m[1]}: award price history is missing. Check /yahoo mapping.`,
  ],
  [
    /Gift closing price unavailable for (\S+) on (\S+)/i,
    (m) => `${m[1]}: award price missing on ${m[2]}. Check /yahoo mapping.`,
  ],
  [
    /Gift return exceeds received shares for (\S+)/i,
    (m) =>
      `${m[1]}: award returns exceed recorded awards. Refresh Grant Activity.`,
  ],
  [
    /Invalid gift stock split/i,
    "Award split ratio is unusable. Ask admin to check the price source.",
  ],
  [
    /Gift comparison needs a new chart|Index snapshot lacks/i,
    "Saved index details are missing. Run /chart again.",
  ],
  [
    /This chart.*older return calculation/i,
    "Saved chart uses an old calculation. Run /chart again.",
  ],
  [
    /This chart predates index switching/i,
    "Saved index details are missing. Run /chart again.",
  ],
  [
    /no performance history within this chart/i,
    "Portfolio dates do not overlap. Create a newer chart.",
  ],
  [
    /No performance points to chart/i,
    "Chart has no dated values. Wait for history sync, then retry.",
  ],
  [
    /widget requires portfolio|Widget benchmark history is incomplete/i,
    "Widget index dates are missing. Use /chart.",
  ],
  [
    /Invalid chart widget values/i,
    "Bot produced an unusable chart value. Ask admin to check the calculation.",
  ],
  [/widget exceeds Telegram/i, "Widget is too large. Use /chart."],
  [
    /Telegram is not allowing widgets/i,
    "Telegram blocks widgets here. Use /chart.",
  ],
  [
    /widgets require Bot API/i,
    "Bot API lacks widget support. Use /chart.",
  ],
  [
    /Podman socket not found/i,
    "Gateway restart socket is missing. Ask admin to enable it.",
  ],
  [
    /Podman socket .*not accessible/i,
    "Gateway restart permission denied. Ask admin to fix socket access.",
  ],
  [
    /Podman returned (\d+)/i,
    (m) => `Gateway restart failed: HTTP ${m[1]}. Ask admin.`,
  ],
  [
    /^Invalid date: (.+)$/i,
    (m) => `Date “${m[1]}” does not exist. Use DD.MM.YY.`,
  ],
  [
    /Not an option contract/i,
    "Yahoo returned a stock, not an option. Choose the option contract symbol.",
  ],
  [
    /No historical data/i,
    "Yahoo returned no prices. Check the symbol and retry.",
  ],
  [
    /Vontobel warrant history unavailable/i,
    "Vontobel returned no usable history. Retry; if unchanged, ask admin.",
  ],
  [
    /Morgan Stanley warrant history unavailable/i,
    "Morgan Stanley returned no usable history. Retry; if unchanged, ask admin.",
  ],
  [
    /Invalid contract multiplier for (\S+)|Missing contract multiplier for (\S+)/i,
    (m) =>
      `${
        m[1] ?? m[2]
      }: contract size is missing/nonpositive. Ask admin to check broker metadata.`,
  ],
  [
    /Invalid .*option trade|Invalid .*option premium|Invalid .*trade timestamp/i,
    "Option archive returned an unusable trade. Ask admin to check the feed.",
  ],
  [
    /Use DD\.MM\.YY|Each vesting line|Vesting cannot|Amounts and award price|Invalid stock ticker|Vesting amounts|Award value is too large|Use \/rsu/i,
    (m) =>
      m[0].startsWith("Use")
        ? "RSU input format is wrong. Check /rsu help."
        : "RSU dates or amounts are unusable. Check /rsu help.",
  ],
];

export function userErrorMessage(
  error: unknown,
  reference = "unknown",
): string {
  if (error instanceof UserFacingError) return error.userMessage;
  if (error instanceof IntegrationDataError) {
    return [
      ...new Set(
        error.failures.map((f) =>
          `${f.publicLabel ?? f.label}: ${userErrorMessage(f.error, reference)}`
        ),
      ),
    ].join("\n");
  }
  const message = error instanceof Error ? error.message : String(error);
  // A known low-level cause is more precise than an adapter's generic wrapper.
  if (error instanceof Error && error.cause instanceof UserFacingError) {
    return userErrorMessage(error.cause, reference);
  }
  const index = message.match(
    /^(.+?) benchmark \([^)]+\) unavailable: ([\s\S]+)$/,
  );
  if (index) {
    const nested = userErrorMessage(
      error instanceof Error && error.cause ? error.cause : new Error(index[2]),
      reference,
    );
    return nested.startsWith("Unexpected bot error")
      ? `${index[1]} price feed unavailable. Retry.`
      : `${index[1]}: ${nested}`;
  }
  const telegram = error as {
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  } | null;
  if (telegram?.error_code === 429) {
    return `Telegram request limit reached. Retry in ${
      telegram.parameters?.retry_after ?? 60
    } seconds.`;
  }
  if (telegram?.error_code === 403) {
    return /blocked by the user/i.test(telegram.description ?? "")
      ? "Telegram blocked bot messages. Unblock the bot."
      : "Telegram denied chat access. Check the bot's chat permissions.";
  }
  if (
    telegram?.error_code === 400 &&
    /message.*(?:not found|can't be edited)/i.test(telegram.description ?? "")
  ) return "Telegram message is unavailable. Run the command again.";
  const http = message.match(
    /(Yahoo Finance|Databento|Vontobel|Morgan Stanley|Trading 212|Freedom24)(?:.*?)(?:HTTP |failed: )(\d{3})/i,
  );
  if (http) {
    return httpError(
      http[1],
      Number(http[2]),
      /Freedom24|Trading 212/i.test(http[1])
        ? undefined
        : Number(http[2]) === 401 || Number(http[2]) === 403
        ? "Ask admin to check the price source."
        : "Retry shortly.",
    ).userMessage;
  }
  for (const [pattern, replacement] of rules) {
    const match = message.match(pattern);
    if (match) {
      return typeof replacement === "function"
        ? replacement(match)
        : replacement;
    }
  }
  if (error instanceof Error && error.cause) {
    const nested = userErrorMessage(error.cause, reference);
    if (!nested.startsWith("Unexpected bot error")) return nested;
  }
  return `Unexpected bot error (${reference}). Send this code to admin.`;
}
