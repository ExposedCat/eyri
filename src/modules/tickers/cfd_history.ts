import type {
  IntegrationCashTransaction,
  IntegrationOrder,
} from "../integrations/types.ts";
import { fetchUsdConversionRates } from "../../utils/exchange_rates.ts";
import { usdFactor } from "../integrations/usd.ts";

export async function buildCfdHistoryOrders(
  transactions: IntegrationCashTransaction[],
  request: typeof fetch = fetch,
): Promise<IntegrationOrder[]> {
  const transfers = transactions.filter((transaction) =>
    transaction.type === "TRANSFER"
  );
  if (!transfers.length) return [];
  const rates = await fetchUsdConversionRates(
    transfers.map((t) => t.currency),
    request,
  );
  const accounts = new Map<number, IntegrationOrder>();
  for (const transfer of transfers) {
    const order = accounts.get(transfer.integrationId) ?? {
      transactionKey: `t212:CFD:${transfer.integrationId}`,
      integrationId: transfer.integrationId,
      integrationKind: "t212",
      account: `Trading 212 #${transfer.integrationId}`,
      ticker: "CFD",
      date: transfer.date,
      quantity: 1,
      price: 0,
      currency: "USD",
      assetCategory: "CFD_TRANSFER",
    };
    order.price = (order.price ?? 0) +
      transfer.amount * usdFactor(transfer.currency, rates);
    if (transfer.date > order.date) order.date = transfer.date;
    accounts.set(transfer.integrationId, order);
  }
  return [...accounts.values()];
}
