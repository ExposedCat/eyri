import type {
  IntegrationCashTransaction,
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../integrations/types.ts";
import { fetchUsdConversionRates } from "../../utils/exchange_rates.ts";
import { usdFactor } from "../integrations/usd.ts";

export async function buildCfdHistoryOrders(
  transactions: IntegrationCashTransaction[],
  request: typeof fetch = fetch,
): Promise<IntegrationOrder[]> {
  const transfers = transactions.filter((transaction) =>
    transaction.type === "TRANSFER" && transaction.amount !== 0
  ).sort((a, b) =>
    +a.date - +b.date || a.amount - b.amount ||
    a.reference.localeCompare(b.reference)
  );
  if (!transfers.length) return [];
  const rates = await fetchUsdConversionRates(
    transfers.map((t) => t.currency),
    request,
  );
  const quantities = new Map<number, number>();
  const orders: IntegrationOrder[] = [];
  for (const transfer of transfers) {
    const amount = transfer.amount * usdFactor(transfer.currency, rates);
    const base = {
      integrationId: transfer.integrationId,
      integrationKind: "t212" as const,
      account: `Trading 212 #${transfer.integrationId}`,
      ticker: "CFD",
      date: transfer.date,
      currency: "USD",
      assetCategory: "CFD_TRANSFER",
    };
    const key = `t212:CFD:${transfer.integrationId}:${transfer.reference}`;
    let quantity = quantities.get(transfer.integrationId) ?? 0;
    if (amount < 0) {
      orders.push({
        ...base,
        transactionKey: key,
        quantity: 1,
        price: -amount,
      });
      quantities.set(transfer.integrationId, quantity + 1);
    } else {
      // Each return closes the whole allocation. A further return without new
      // funding is additional proceeds with zero remaining basis, not a short.
      if (quantity === 0) {
        quantity = 1;
        orders.push({ ...base, transactionKey: key, quantity, price: 0 });
      }
      orders.push({
        ...base,
        transactionKey: `${key}:sale`,
        quantity: -quantity,
        price: amount / quantity,
      });
      quantities.set(transfer.integrationId, 0);
    }
  }
  return orders;
}

export function isCfdAllocation(item: { assetCategory?: string | null }) {
  return item.assetCategory === "CFD_TRANSFER";
}

// The public API has no CFD mark. Under the transfer accounting convention,
// an allocation remains valued at its funding cost until a return closes it.
export function buildCfdPositions(
  orders: IntegrationOrder[],
): IntegrationPortfolioPosition[] {
  const positions = new Map<number, IntegrationPortfolioPosition>();
  for (const order of orders) {
    if (!isCfdAllocation(order)) continue;
    if (order.quantity < 0) {
      positions.delete(order.integrationId);
      continue;
    }
    const previous = positions.get(order.integrationId);
    const amount = (previous?.amount ?? 0) + order.quantity;
    const cost = (previous?.totalInput ?? 0) + order.quantity * order.price!;
    positions.set(order.integrationId, {
      integrationId: order.integrationId,
      integrationKind: order.integrationKind,
      account: order.account,
      ticker: order.ticker,
      currency: order.currency,
      assetCategory: order.assetCategory,
      amount,
      averageUnitPrice: cost / amount,
      currentPrice: cost / amount,
      totalInput: cost,
      totalNow: cost,
      unrealizedPnl: 0,
      realizedPnl: null,
      dailyPnl: null,
      dailyPnlPercentage: null,
      dailyPnlBaseline: null,
      openedAt: previous?.openedAt ?? order.date,
    });
  }
  return [...positions.values()];
}
