const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
export type OptionContract = {
  symbol: string;
  underlying: string;
  expiry: string;
};

export function yahooOptionContract(ticker: string): OptionContract | null {
  const value = ticker.trim().toUpperCase();
  const broker = value.match(
    /^\+([A-Z0-9]{1,6})\.(\d{1,2})([A-Z]{3})(\d{4})\.([CP])(\d{1,5})(?:\.(\d{1,3}))?$/,
  );
  const occ = value.replaceAll(/\s+/g, "").match(
    /^([A-Z0-9]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/,
  );
  if (!broker && !occ) return null;
  const underlying = (broker ?? occ)![1];
  const year = broker ? Number(broker[4]) : 2000 + Number(occ![2]);
  const month = broker ? MONTHS.indexOf(broker[3]) + 1 : Number(occ![3]);
  const day = Number(broker ? broker[2] : occ![4]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 2000 || year > 2099 || date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
  ) return null;
  const expiry = date.toISOString().slice(0, 10);
  const strike = broker
    ? broker[6].padStart(5, "0") + (broker[7] ?? "").padEnd(3, "0")
    : occ![6];
  const right = broker ? broker[5] : occ![5];
  return {
    underlying,
    expiry,
    symbol: `${underlying}${
      expiry.replaceAll("-", "").slice(2)
    }${right}${strike}`,
  };
}

export function historicalQuoteMultiplier(
  instrument: {
    ticker: string;
    integrationKind: string;
    historicalPriceMultiplier?: number;
  },
) {
  if (instrument.historicalPriceMultiplier !== undefined) {
    if (
      !Number.isFinite(instrument.historicalPriceMultiplier) ||
      instrument.historicalPriceMultiplier <= 0
    ) throw new Error(`Invalid contract multiplier for ${instrument.ticker}.`);
    return instrument.historicalPriceMultiplier;
  }
  const option = yahooOptionContract(instrument.ticker);
  // Freedom24 normalized position/trade prices are dollars per contract;
  // Yahoo option premiums are quoted per underlying unit. NANOS uses $1 units.
  return option && instrument.integrationKind === "f24"
    ? option.underlying === "NANOS" ? 1 : 100
    : 1;
}
