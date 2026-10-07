export type FailedHistory = { ticker: string; symbol: string };

export class HistoricalDataError extends Error {
  readonly commands: string[];
  constructor(failures: FailedHistory[]) {
    const unique = new Map(
      failures.map((f) => [f.ticker.trim().toUpperCase(), f]),
    );
    const commands = [...unique].map(([ticker, f]) =>
      `/yahoo ${ticker} ${f.symbol}`
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
