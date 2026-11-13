import type { Database } from "../database/setup.ts";
import { fetchHistoricalUsdConversionRates, fetchUsdConversionRates } from "../../utils/exchange_rates.ts";
import { dayAfter } from "../market_data/history.ts";
import { userErrorMessage, UserFacingError } from "../../utils/user_error.ts";

export async function loadChartFx(db: Database, currencies: string[], start: string, end: string, request: typeof fetch, forceIgnore = false) {
  db.exec("CREATE TABLE IF NOT EXISTS chart_exchange_rates(currency TEXT PRIMARY KEY,factor REAL NOT NULL,date TEXT NOT NULL)");
  const codes = [...new Set(currencies.map(code => code.trim().toUpperCase()))].filter(code => code !== "USD" && /^[A-Z]{3}$/.test(code));
  const rates = new Map<string, number>([["USD", 1]]);
  const historical = new Map<string, { date: string; factor: number }[]>();
  const notes: string[] = [];
  let ignoreFx = forceIgnore;
  await Promise.all(codes.map(async code => {
    try {
      const current = await fetchUsdConversionRates([code], request);
      rates.set(code, current.get(code)!);
      db.prepare("INSERT OR REPLACE INTO chart_exchange_rates VALUES (?,?,?)").run(code, current.get(code)!, end);
    } catch (error) {
      ignoreFx = true;
      console.error(`Chart ${code} spot conversion failed:`, error);
      notes.push(`Currency P/L excluded: ${userErrorMessage(error)}`);
      const saved = db.prepare("SELECT factor,date FROM chart_exchange_rates WHERE currency=?").get(code) as { factor: number; date: string } | undefined;
      if (saved && Number.isFinite(saved.factor) && saved.factor > 0) {
        rates.set(code, saved.factor);
        notes.push(`Using saved ${code} conversion from ${saved.date}. Currency P/L excluded.`);
      }
    }
    try {
      const rows = (await fetchHistoricalUsdConversionRates([code], start, end, request)).get(code)!;
      historical.set(code, rows);
      if (!rates.has(code)) {
        const latest = rows.at(-1)!;
        rates.set(code, latest.factor);
        db.prepare("INSERT OR REPLACE INTO chart_exchange_rates VALUES (?,?,?)").run(code, latest.factor, latest.date);
      }
      const gap = rows.findIndex((row, i) => i > 0 && Date.parse(row.date) - Date.parse(rows[i - 1].date) > 7 * 86400000);
      const missing = !rows.some(row => row.date <= start) ? `no rate on/before ${start}`
        : Date.parse(end) - Date.parse(rows.at(-1)!.date) > 7 * 86400000 ? `last rate ${rows.at(-1)!.date}`
        : gap >= 0 ? `rates missing between ${rows[gap - 1].date} and ${rows[gap].date}` : undefined;
      if (missing) { ignoreFx = true; notes.push(`Currency P/L excluded: ${code} ${missing}. Using latest known conversion.`); }
    } catch (error) {
      ignoreFx = true;
      console.error(`Chart ${code} conversion history failed:`, error);
      notes.push(`Currency P/L excluded: ${userErrorMessage(error)}`);
    }
    if (!rates.has(code)) notes.push(`${code} conversion unavailable; affected dates are gaps. Retry later.`);
  }));
  if (ignoreFx) {
    notes.push("Currency P/L excluded; conversion uses latest known rates.");
    // Use a consistent conversion basis for the complete curve and its index.
    for (const code of codes) {
      const factor = rates.get(code);
      if (factor === undefined) { historical.delete(code); continue; }
      const rows = [];
      for (let date = dayAfter(start, -7); date <= end; date = dayAfter(date)) rows.push({ date, factor });
      historical.set(code, rows);
    }
  }
  const withKnownRates: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const quote = url.hostname === "api.frankfurter.dev" ? url.pathname.match(/^\/v2\/rate\/usd\/([a-z]+)$/i)?.[1].toUpperCase() : undefined;
    if (!quote) return request(input, init);
    const factor = rates.get(quote) ?? (quote === "GBP" && rates.has("GBX") ? rates.get("GBX")! * 100 : undefined);
    if (factor === undefined) return Promise.reject(new UserFacingError(`${quote} conversion rate is missing. Retry later.`, { code: "chart_rate" }));
    return Promise.resolve(Response.json({ base: "USD", quote, rate: 1 / factor }));
  };
  return { rates, historical, ignoreFx, notes, request: withKnownRates };
}
