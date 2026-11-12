import type { IntegrationOrder } from "../types.ts";
import { yahooOptionContract } from "../../market_data/options.ts";

export function ibkrOptionMultiplier(instrument: Pick<IntegrationOrder, "ticker" | "assetCategory" | "contractMultiplier">) {
  const option = yahooOptionContract(instrument.ticker);
  if (!["OPT", "FOP"].includes(instrument.assetCategory?.toUpperCase() ?? "") && !option) return undefined;
  if (instrument.contractMultiplier !== undefined) {
    if (!Number.isFinite(instrument.contractMultiplier) || instrument.contractMultiplier <= 0) {
      throw new Error(`Invalid contract multiplier for ${instrument.ticker}`);
    }
    return instrument.contractMultiplier;
  }
  // Older rows lack metadata. Standard OCC contracts use 100; NANOS uses 1.
  if (option) return option.underlying === "NANOS" ? 1 : 100;
  throw new Error(`Missing contract multiplier for ${instrument.ticker}`);
}

// Persist broker premiums unchanged, but expose per-contract prices to every
// consumer, like Freedom24. Fees are already monetary amounts and stay intact.
export function normalizeIbkrOrder(order: IntegrationOrder): IntegrationOrder {
  const multiplier = ibkrOptionMultiplier(order);
  return multiplier === undefined ? order : {
    ...order,
    price: order.price === null ? null : order.price * multiplier,
    historicalPriceMultiplier: multiplier,
  };
}
