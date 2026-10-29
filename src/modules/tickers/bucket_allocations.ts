import type { IntegrationOrder } from "../integrations/types.ts";
import {
  type BucketAllocations,
  partialTransactionKey,
} from "../database/bucket.ts";
import { getOrderTransactionKey, isDisplayableOrder } from "./portfolio.ts";

const EPSILON = 1e-9;

const scaleOptional = (value: number | undefined, share: number) =>
  value === undefined ? undefined : value * share;

export function scaleOrder(
  order: IntegrationOrder,
  share: number,
): IntegrationOrder {
  if (share === 1) return order;
  return {
    ...order,
    quantity: order.quantity * share,
    ...(order.commission ? { commission: { ...order.commission, amount: order.commission.amount * share } } : {}),
    ...(order.walletImpact
      ? {
        walletImpact: {
          ...order.walletImpact,
          netValue: order.walletImpact.netValue * share,
          realisedProfitLoss: scaleOptional(
            order.walletImpact.realisedProfitLoss,
            share,
          ),
          taxes: order.walletImpact.taxes.map((tax) => ({
            ...tax,
            quantity: tax.quantity * share,
          })),
        },
      }
      : {}),
  };
}

function withQuantity(
  order: IntegrationOrder,
  quantity: number,
  transactionKey?: string,
) {
  return {
    ...scaleOrder(order, quantity / order.quantity),
    quantity,
    ...(transactionKey ? { transactionKey } : {}),
  };
}

// Splits purchases with partial bucket allocations into a portfolio remainder
// and one order per bucket part, each with its own transaction key. Every
// bucket report then treats the parts like separately assigned purchases.
// Parts take from the latest fills and follow the remainder, so FIFO sales
// consume the portfolio remainder of a purchase before its bucket parts.
export function applyBucketAllocations(
  orders: IntegrationOrder[],
  allocations: BucketAllocations,
) {
  if (allocations.size === 0) return orders;
  const purchases = new Map<string, number[]>();
  orders.forEach((order, index) => {
    if (order.quantity <= 0 || order.transactionKey) return;
    const key = getOrderTransactionKey(order);
    if (!allocations.has(key)) return;
    purchases.set(key, [...(purchases.get(key) ?? []), index]);
  });

  const remainders = new Map<number, IntegrationOrder | null>();
  const parts = new Map<number, IntegrationOrder[]>();
  for (const [key, indices] of purchases) {
    const pending = (allocations.get(key) ?? []).map((part) => ({ ...part }));
    const fragments: { index: number; order: IntegrationOrder }[] = [];
    for (let position = indices.length - 1; position >= 0; position--) {
      const index = indices[position];
      const order = orders[index];
      let left = order.quantity;
      for (const part of pending) {
        const take = Math.min(left, part.quantity);
        if (take <= EPSILON) continue;
        fragments.push({
          index,
          order: withQuantity(
            order,
            take,
            partialTransactionKey(key, part.bucketName),
          ),
        });
        part.quantity -= take;
        left -= take;
      }
      if (left < order.quantity) {
        remainders.set(index, left > EPSILON ? withQuantity(order, left) : null);
      }
    }
    fragments.sort((a, b) => a.index - b.index);
    parts.set(indices[indices.length - 1], fragments.map(({ order }) => order));
  }

  return orders.flatMap((order, index) => {
    const base = remainders.has(index) ? remainders.get(index) : order;
    return [...(base ? [base] : []), ...(parts.get(index) ?? [])];
  });
}

// Resolves user input such as AAPL to the broker ticker (e.g. AAPL.US).
export function matchOrderTickers(orders: IntegrationOrder[], input: string) {
  const wanted = input.trim().toUpperCase();
  const tickers = [...new Set(orders.map((order) => order.ticker))];
  const exact = tickers.filter((ticker) => ticker.toUpperCase() === wanted);
  return exact.length > 0
    ? exact
    : tickers.filter((ticker) => ticker.toUpperCase().split(".")[0] === wanted);
}

// Open portfolio (unbucketed) purchase quantity of a ticker per transaction,
// oldest first, using the same FIFO matching as bucket positions.
export function findOpenPortfolioLots(
  orders: IntegrationOrder[],
  assignments: Map<string, string>,
  ticker: string,
) {
  type Lot = { transactionKey: string; quantity: number; movable: boolean };
  const lotsByKey = new Map<string, Lot[]>();
  const sorted = orders.filter(isDisplayableOrder)
    .filter((order) => order.ticker === ticker)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const order of sorted) {
    const lotKey = JSON.stringify([
      order.integrationId,
      order.ticker.trim().toUpperCase(),
      order.currency.trim().toUpperCase(),
    ]);
    const lots = lotsByKey.get(lotKey) ?? [];
    lotsByKey.set(lotKey, lots);
    if (order.quantity > 0) {
      const transactionKey = getOrderTransactionKey(order);
      lots.push({
        transactionKey,
        quantity: order.quantity,
        // Synthesized entries (CFD funding, partial parts) are not purchases
        // that can be split again.
        movable: !order.transactionKey && !assignments.has(transactionKey),
      });
      continue;
    }
    let selling = -order.quantity;
    while (selling > EPSILON && lots.length > 0) {
      const consumed = Math.min(lots[0].quantity, selling);
      lots[0].quantity -= consumed;
      selling -= consumed;
      if (lots[0].quantity <= EPSILON) lots.shift();
    }
  }

  const open = new Map<string, number>();
  for (const lot of [...lotsByKey.values()].flat()) {
    if (!lot.movable || lot.quantity <= EPSILON) continue;
    open.set(lot.transactionKey, (open.get(lot.transactionKey) ?? 0) + lot.quantity);
  }
  // Keys start with the purchase date, so they sort chronologically.
  return [...open].sort(([a], [b]) => a.localeCompare(b))
    .map(([transactionKey, quantity]) => ({ transactionKey, quantity }));
}
