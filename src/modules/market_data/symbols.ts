import type { HistoricalInstrument } from "./yahoo.ts";
import { yahooOptionContract } from "./options.ts";

// A dotted exchange suffix must remain intact (VOD.L, SAP.F). US share classes
// use a hyphen on Yahoo; IBKR can provide either a space or a dot.
const shareClassSymbol = (symbol: string, currency: string) =>
  currency === "USD" ? symbol.replace(/ (?=[A-Z]$)|\.(?=[AB]$)/, "-") : symbol;

// Trading 212 appends its exchange code to the symbol. Keep the rules currency
// scoped: the same short symbol can name unrelated companies on other exchanges.
const DEFAULT_PATTERNS = [
  // Freedom24/Tradernet identifies US listings with a .US suffix.
  { pattern: /^(.+)\.US$/, currencies: ["USD"], suffixes: [""] },
  { pattern: /^(.+)_US_EQ$/, currencies: ["USD"], suffixes: [""] },
  { pattern: /^(.+)D_EQ$/, currencies: ["EUR"], suffixes: [".DE", ".F"] },
  { pattern: /^(.+)P_EQ$/, currencies: ["EUR"], suffixes: [".PA"] },
  { pattern: /^(.+)L_EQ$/, currencies: ["GBP", "GBX"], suffixes: [".L"] },
  // London USD GDRs use Yahoo's International Orderbook suffix. Its .L alias
  // can have a shorter history, as with Samsung, so prefer .IL.
  { pattern: /^(.+)L_EQ$/, currencies: ["USD"], suffixes: [".IL", ".L"] },
];
const DEFAULT_MAPPINGS: Record<string, string> = {
  "VUAA:USD": "VUAA.L",
  "SPYL:USD": "SPYL.L",
};

export function defaultYahooSymbols(
  instrument: HistoricalInstrument,
): string[] {
  const ticker = instrument.ticker.trim().toUpperCase();
  const currency = instrument.currency.trim().toUpperCase();
  const candidates: string[] = [];
  const option = yahooOptionContract(ticker);
  if (option) return [instrument.yahooSymbol ?? option.symbol];
  if (ticker.startsWith("+")) return candidates;
  const mapping = DEFAULT_MAPPINGS[`${ticker}:${currency}`];
  if (mapping) candidates.push(mapping);
  for (const rule of DEFAULT_PATTERNS) {
    const match = ticker.match(rule.pattern);
    if (match && rule.currencies.includes(currency)) {
      const base = shareClassSymbol(match[1], currency);
      candidates.push(...rule.suffixes.map((suffix) => base + suffix));
      break;
    }
  }
  if (instrument.yahooSymbol) {
    const hint = instrument.yahooSymbol.trim().toUpperCase();
    if (currency === "USD" && hint.endsWith(".L")) {
      candidates.push(hint.replace(/\.L$/, ".IL"));
    }
    candidates.push(hint);
    if (currency === "EUR" && hint.endsWith(".DE")) {
      candidates.push(hint.replace(/\.DE$/, ".F"));
    }
  }
  if (!ticker.startsWith("+") && !ticker.endsWith("_EQ")) {
    const symbol = shareClassSymbol(ticker, currency);
    // IBKR uses bare local stock symbols; sterling/pence quotes belong to
    // London. Other currencies can span several exchanges, so don't guess.
    if (
      /^[A-Z0-9-]+$/.test(symbol) && (currency === "GBP" || currency === "GBX")
    ) {
      candidates.push(`${symbol}.L`);
    }
    candidates.push(symbol);
  }
  return [...new Set(candidates)];
}

// Last-resort candidates after broker hints and ISIN lookup. These are checked
// against Yahoo's quote currency and the first purchase before being accepted.
const LIKELY_SUFFIXES: Record<string, string[]> = {
  USD: [".L", ".IL"],
  EUR: [".DE", ".F", ".PA", ".AS", ".MI", ".MC"],
  GBP: [".L"],
  GBX: [".L"],
  CAD: [".TO", ".V"],
  CHF: [".SW", ".VX"],
  HKD: [".HK"],
  AUD: [".AX"],
  NZD: [".NZ"],
  SEK: [".ST"],
  NOK: [".OL"],
  DKK: [".CO"],
  JPY: [".T"],
  SGD: [".SI"],
};

export function likelyYahooSymbols(instrument: HistoricalInstrument): string[] {
  const ticker = instrument.ticker.trim().toUpperCase();
  const currency = instrument.currency.trim().toUpperCase();
  if (ticker.startsWith("+") || yahooOptionContract(ticker)) return [];
  let base = ticker;
  if (base.endsWith("_EQ")) {
    base = base.match(/^(.+)_US_EQ$/)?.[1] ??
      base.match(/^(.+)[DLP]_EQ$/)?.[1] ?? "";
  } else {
    const suffixes = new Set([
      "US",
      ...Object.values(LIKELY_SUFFIXES).flat().map((s) => s.slice(1)),
    ]);
    const qualified = base.match(/^(.+)\.([A-Z]+)$/);
    if (qualified && suffixes.has(qualified[2])) base = qualified[1];
  }
  base = shareClassSymbol(base, currency);
  if (!/^[A-Z0-9-]+$/.test(base)) return [];
  if (currency === "HKD" && /^\d+$/.test(base)) base = base.padStart(4, "0");
  const known = new Set(defaultYahooSymbols(instrument));
  return (LIKELY_SUFFIXES[currency] ?? []).map((suffix) => base + suffix)
    .filter((symbol) => !known.has(symbol)).slice(0, 6);
}
