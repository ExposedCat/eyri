import type { IntegrationOrder } from "../integrations/types.ts";
import { yahooOptionContract } from "./options.ts";

// Same CUSIP, no share conversion: SEC exhibit 99.1, May 21, 2026.
// https://www.sec.gov/Archives/edgar/data/1856437/000185643726000007/ex991vscomay212026pressrel.htm
export function currentStockTicker(ticker: string, currency: string) {
  if (currency.trim().toUpperCase() !== "USD") return ticker;
  const value = ticker.trim().toUpperCase();
  return value === "VSCO.US" ? "VSXY.US" : value === "VSCO" ? "VSXY" : ticker;
}

// OCC memos 54622 and 59532: two contracts replace one, strike is halved;
// each resulting contract still delivers 100 shares. These are option actions,
// separate from Yahoo's underlying stock split events.
// https://infomemo.theocc.com/infomemos?number=54622
// https://infomemo.theocc.com/infomemos?number=59532
const OPTION_SPLITS = [
  { underlying: "APH", date: "2024-06-12", ratio: 2 },
  { underlying: "APH", date: "2026-09-03", ratio: 2 },
];

function applicableSplits(ticker: string, through: string) {
  const option = yahooOptionContract(ticker);
  return option
    ? OPTION_SPLITS.filter((s) =>
      s.underlying === option.underlying &&
      s.date <= option.expiry && s.date <= through
    )
    : [];
}

function changeStrike(ticker: string, factor: number) {
  const option = yahooOptionContract(ticker)!;
  const strike = Number(option.symbol.slice(-8)) * factor;
  if (!Number.isInteger(strike) || strike <= 0 || strike > 99_999_999) {
    throw new Error(`Unsupported adjusted option strike for ${ticker}.`);
  }
  if (ticker.trim().startsWith("+")) {
    return ticker.trim().toUpperCase().replace(
      /([CP])\d+(?:\.\d+)?$/,
      (_match, right) => right + String(strike / 1000),
    );
  }
  return option.symbol.slice(0, -8) + String(strike).padStart(8, "0");
}

// Normalize fills into today's contract units while preserving the original
// transaction key (and therefore bucket assignment). Quantity × cost is invariant.
export function adjustOrderForCorporateActions(
  order: IntegrationOrder,
  through: string,
): IntegrationOrder {
  let ticker = currentStockTicker(order.ticker, order.currency), factor = 1;
  if (order.currency.trim().toUpperCase() === "USD") {
    const date = order.date.toISOString().slice(0, 10);
    for (const split of applicableSplits(ticker, through)) {
      if (date < split.date) {
        ticker = changeStrike(ticker, 1 / split.ratio);
        factor *= split.ratio;
      }
    }
  }
  return {
    ...order,
    ticker,
    quantity: order.quantity * factor,
    price: order.price === null ? null : order.price / factor,
    transactionKey: order.transactionKey ?? JSON.stringify([
      order.date.toISOString().slice(0, 10),
      order.ticker.trim().toUpperCase(),
      order.currency.trim().toUpperCase(),
    ]),
  };
}

// A strike can exist both before and after a split but represent different
// contracts. Stitch the predecessor's prices, scaled into the final units;
// never use the current strike's older, unrelated premium history.
export function optionHistorySegments(
  ticker: string,
  currency: string,
  start: string,
  end: string,
  through: string,
) {
  const splits = currency.trim().toUpperCase() === "USD"
    ? applicableSplits(ticker, through)
    : [];
  const boundaries = [
    start,
    ...splits.map((s) => s.date).filter((d) => d > start && d < end),
    end,
  ];
  return boundaries.slice(0, -1).map((from, index) => {
    const factor = splits.filter((s) => s.date > from).reduce(
      (f, s) => f * s.ratio,
      1,
    );
    return {
      ticker: factor === 1 ? ticker : changeStrike(ticker, factor),
      start: from,
      end: boundaries[index + 1],
      priceFactor: 1 / factor,
    };
  });
}
