import type { Integration } from "../../database/integration.ts";
import type { Database } from "../../database/setup.ts";
import type {
  IntegrationAdapter,
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../types.ts";
import {
  type Freedom24Order,
  type Freedom24OrderHistoryResponse,
  type Freedom24PortfolioPosition,
  type Freedom24PortfolioResponse,
  makeTradernetApiRequest,
} from "./api.ts";
import { parseFreedom24Credentials } from "./credentials.ts";

const COMPLETED_ORDER_STATUS = 21;
const BUY_OPERATION = 1;
const SELL_OPERATION = 3;

function getHistoryDateRange(years: number) {
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + 1);
  to.setUTCHours(23, 59, 59, 999);

  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - years);
  from.setUTCHours(0, 0, 0, 0);

  return { from, to };
}

function normalizeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getPositionTicker(position: Freedom24PortfolioPosition) {
  return position.i?.trim() || position.base_contract_code?.trim() || "UNKNOWN";
}

function getPositionCurrentPrice(position: Freedom24PortfolioPosition) {
  const marketPrice = normalizeNumber(position.mkt_price);
  if (marketPrice !== null && marketPrice > 0) {
    return marketPrice;
  }

  const closePrice = normalizeNumber(position.close_price);
  if (closePrice !== null && closePrice > 0) {
    return closePrice;
  }

  const marketValue = normalizeNumber(position.market_value);
  const quantity = normalizeNumber(position.q);
  const faceValue = normalizeNumber(position.face_val_a) ?? 1;
  if (marketValue !== null && quantity !== null && quantity !== 0) {
    return marketValue / quantity / faceValue;
  }

  return null;
}

function toPortfolioPosition(
  integration: Integration,
  position: Freedom24PortfolioPosition,
): IntegrationPortfolioPosition | null {
  const amount = normalizeNumber(position.q);
  if (amount === null || amount === 0) {
    return null;
  }

  const faceValue = normalizeNumber(position.face_val_a) ?? 1;
  const averageUnitPrice = normalizeNumber(position.price_a);
  const currentPrice = getPositionCurrentPrice(position);
  const totalInput =
    averageUnitPrice === null ? null : averageUnitPrice * faceValue * amount;
  const apiMarketValue = normalizeNumber(position.market_value);
  const totalNow =
    apiMarketValue ??
    (currentPrice === null ? null : currentPrice * faceValue * amount);

  return {
    integrationId: integration.id,
    integrationKind: integration.kind,
    account: "Freedom24",
    ticker: getPositionTicker(position),
    amount,
    averageUnitPrice:
      averageUnitPrice === null ? null : averageUnitPrice * faceValue,
    currentPrice: currentPrice === null ? null : currentPrice * faceValue,
    currency: position.curr?.trim() || position.base_currency?.trim() || "USD",
    totalInput,
    totalNow,
    unrealizedPnl:
      normalizeNumber(position.profit_close) ??
      (totalNow !== null && totalInput !== null ? totalNow - totalInput : null),
    realizedPnl: normalizeNumber(position.profit_price),
    openedAt: null,
  };
}

function getOrderTicker(order: Freedom24Order) {
  return order.instr?.trim() || order.base_contract_code?.trim() || "UNKNOWN";
}

function getOrderCurrency(order: Freedom24Order) {
  return (
    order.curr?.trim() ||
    order.curr_c?.trim() ||
    order.base_currency?.trim() ||
    "USD"
  );
}

function getOrderDate(order: Freedom24Order) {
  const tradeDates = order.trade
    ?.map((trade) => (trade.date ? new Date(trade.date) : null))
    .filter((date): date is Date => Boolean(date && !Number.isNaN(+date)));
  if (tradeDates && tradeDates.length > 0) {
    return tradeDates.reduce((earliest, date) =>
      date < earliest ? date : earliest,
    );
  }

  return order.date ? new Date(order.date) : null;
}

function getOrderQuantity(order: Freedom24Order) {
  const quantity =
    order.trade && order.trade.length > 0
      ? order.trade.reduce(
          (sum, trade) => sum + (normalizeNumber(trade.q) ?? 0),
          0,
        )
      : normalizeNumber(order.q);
  if (quantity === null || quantity === 0) {
    return null;
  }

  if (order.oper === SELL_OPERATION) {
    return -Math.abs(quantity);
  }

  if (order.oper === BUY_OPERATION) {
    return Math.abs(quantity);
  }

  return null;
}

function getOrderPrice(order: Freedom24Order, quantity: number) {
  const tradeValue =
    order.trade && order.trade.length > 0
      ? order.trade.reduce(
          (sum, trade) => sum + (normalizeNumber(trade.v) ?? 0),
          0,
        )
      : null;
  if (tradeValue !== null && quantity !== 0) {
    return Math.abs(tradeValue / quantity);
  }

  return normalizeNumber(order.p);
}

function toIntegrationOrder(
  integration: Integration,
  order: Freedom24Order,
): IntegrationOrder | null {
  if (
    order.stat !== COMPLETED_ORDER_STATUS ||
    (order.oper !== BUY_OPERATION && order.oper !== SELL_OPERATION)
  ) {
    return null;
  }

  const date = getOrderDate(order);
  const quantity = getOrderQuantity(order);
  if (!date || Number.isNaN(+date) || quantity === null) {
    return null;
  }

  return {
    integrationId: integration.id,
    integrationKind: integration.kind,
    account: "Freedom24",
    ticker: getOrderTicker(order),
    date,
    quantity,
    price: getOrderPrice(order, quantity),
    currency: getOrderCurrency(order),
    assetCategory: null,
  };
}

function getPositionOrderKey(ticker: string, currency: string) {
  return `${ticker.trim().toUpperCase()}:${currency.trim().toUpperCase()}`;
}

function getOpenLotDate(
  position: IntegrationPortfolioPosition,
  orders: IntegrationOrder[],
) {
  const matchingOrders = orders
    .filter(
      (order) =>
        getPositionOrderKey(order.ticker, order.currency) ===
        getPositionOrderKey(position.ticker, position.currency),
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const lots: { quantity: number; date: Date }[] = [];

  for (const order of matchingOrders) {
    if (order.quantity > 0) {
      lots.push({
        quantity: order.quantity,
        date: order.date,
      });
      continue;
    }

    let remainingSellQuantity = Math.abs(order.quantity);
    while (remainingSellQuantity > 0 && lots.length > 0) {
      const lot = lots[0];
      const consumedQuantity = Math.min(lot.quantity, remainingSellQuantity);
      lot.quantity -= consumedQuantity;
      remainingSellQuantity -= consumedQuantity;
      if (lot.quantity <= 0) {
        lots.shift();
      }
    }
  }

  const targetQuantity = Math.abs(position.amount);
  let remainingQuantity = targetQuantity;
  let openedAt: Date | null = null;
  for (
    let index = lots.length - 1;
    index >= 0 && remainingQuantity > 0;
    index--
  ) {
    const lot = lots[index];
    const usedQuantity = Math.min(lot.quantity, remainingQuantity);
    if (usedQuantity > 0 && (!openedAt || lot.date < openedAt)) {
      openedAt = lot.date;
    }
    remainingQuantity -= usedQuantity;
  }

  return openedAt;
}

async function fetchPortfolioResponse(integration: Integration) {
  const credentials = parseFreedom24Credentials(integration.credentials);
  const response = await makeTradernetApiRequest<Freedom24PortfolioResponse>(
    credentials.apiKey,
    credentials.secretKey,
    "getPositionJson",
  );

  if (!Array.isArray(response.result?.ps?.pos)) {
    throw new Error("Freedom24 portfolio response did not include positions");
  }

  return response;
}

async function fetchOrderHistoryResponse(integration: Integration) {
  const credentials = parseFreedom24Credentials(integration.credentials);
  const { from, to } = getHistoryDateRange(credentials.historyYears);

  const response = await makeTradernetApiRequest<Freedom24OrderHistoryResponse>(
    credentials.apiKey,
    credentials.secretKey,
    "getOrdersHistory",
    {
      from: from.toISOString(),
      to: to.toISOString(),
    },
  );

  return response.orders?.order ?? [];
}

async function fetchIntegrationOrderHistory(integration: Integration) {
  const orders = await fetchOrderHistoryResponse(integration);
  return orders.flatMap((order) => {
    const mapped = toIntegrationOrder(integration, order);
    return mapped ? [mapped] : [];
  });
}

export const freedom24Adapter: IntegrationAdapter = {
  async fetchPortfolio(_database: Database, integration: Integration) {
    const [portfolioResponse, orders] = await Promise.all([
      fetchPortfolioResponse(integration),
      fetchIntegrationOrderHistory(integration),
    ]);

    return (
      portfolioResponse.result?.ps?.pos
        ?.flatMap((position) => {
          const mapped = toPortfolioPosition(integration, position);
          if (!mapped) {
            return [];
          }

          return [
            {
              ...mapped,
              openedAt: getOpenLotDate(mapped, orders) ?? mapped.openedAt,
            },
          ];
        })
        .sort((a, b) => a.ticker.localeCompare(b.ticker)) ?? []
    );
  },

  async fetchOrderHistory(_database: Database, integration: Integration) {
    return fetchIntegrationOrderHistory(integration);
  },

  async probe(integration: Integration) {
    await fetchPortfolioResponse(integration);
  },
};
