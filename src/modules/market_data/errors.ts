import { VONTOBEL_PREFIX } from "./vontobel.ts";
import { MORGAN_STANLEY_PREFIX } from "./morgan_stanley.ts";

export type FailedHistory = { ticker: string; symbol: string };

export class HistoricalDataError extends Error {
  readonly commands: string[];
  constructor(failures: FailedHistory[]) {
    const unique = new Map(
      failures.map((f) => [f.ticker.trim().toUpperCase(), f]),
    );
    const commands = [...unique].map(([ticker, f]) =>
      f.symbol.startsWith(VONTOBEL_PREFIX)
        ? `${ticker}: Vontobel warrant history unavailable (${
          f.symbol.slice(VONTOBEL_PREFIX.length)
        }).`
        : f.symbol.startsWith(MORGAN_STANLEY_PREFIX)
        ? `${ticker}: Morgan Stanley warrant history unavailable (${
          f.symbol.slice(MORGAN_STANLEY_PREFIX.length)
        }).`
        : `/yahoo ${ticker} ${f.symbol}`
    );
    super(
      `Failed to fetch historical data:\n${
        commands.map((c) => `- ${c}`).join("\n")
      }`,
    );
    this.name = "HistoricalDataError";
    this.commands = commands;
  }
}
