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
  type Freedom24Quote,
  type Freedom24QuotesResponse,
  makeTradernetApiRequest,
} from "./api.ts";
import { parseFreedom24Credentials } from "./credentials.ts";

const COMPLETED_ORDER_STATUS = 21;
const BUY_OPERATION = 1;
const SELL_OPERATION = 3;

type QuotePrices = {
  currentPrice: number | null;
  previousClose: number | null;
};

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

function normalizePositiveNumber(value: unknown) {
  const number = normalizeNumber(value);
  return number !== null && number > 0 ? number : null;
}

function normalizeTradernetNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizePositiveTradernetNumber(value: unknown) {
  const number = normalizeTradernetNumber(value);
  return number !== null && number > 0 ? number : null;
}

function getPositionTicker(position: Freedom24PortfolioPosition) {
  return position.i?.trim() || position.base_contract_code?.trim() || "UNKNOWN";
}

function getPositionCurrentPrice(
  position: Freedom24PortfolioPosition,
  quotePrices: QuotePrices | undefined,
) {
  if (
    quotePrices?.currentPrice !== undefined &&
    quotePrices.currentPrice !== null &&
    quotePrices.currentPrice > 0
  ) {
    return quotePrices.currentPrice;
  }

  const marketPrice = normalizePositiveNumber(position.mkt_price);
  if (marketPrice !== null) {
    return marketPrice;
  }

  const closePrice = normalizePositiveNumber(position.close_price);
  if (closePrice !== null) {
    return closePrice;
  }

  const marketValue = normalizeNumber(position.market_value);
  const quantity = normalizeNumber(position.q);
  const faceValue = normalizePositiveNumber(position.face_val_a) ?? 1;
  if (marketValue !== null && quantity !== null && quantity !== 0) {
    return marketValue / quantity / faceValue;
  }

  return null;
}

function toPortfolioPosition(
  integration: Integration,
  position: Freedom24PortfolioPosition,
  quotePrices: Map<string, QuotePrices>,
  dailyRealizedPnlByTicker: Map<string, number>,
): IntegrationPortfolioPosition | null {
  const amount = normalizeNumber(position.q);
  if (amount === null || amount === 0) {
    return null;
  }

  const ticker = getPositionTicker(position);
  const faceValue = normalizePositiveNumber(position.face_val_a) ?? 1;
  const averageUnitPrice = normalizeNumber(position.price_a);
  const currentPrice = getPositionCurrentPrice(
    position,
    quotePrices.get(ticker),
  );
  const totalInput =
    averageUnitPrice === null ? null : averageUnitPrice * faceValue * amount;
  const apiMarketValue = normalizeNumber(position.market_value);
  const totalNow =
    (apiMarketValue !== null && apiMarketValue > 0 ? apiMarketValue : null) ??
    (currentPrice === null ? null : currentPrice * faceValue * amount);
  const resolvedCurrentPrice =
    totalNow !== null && amount !== 0
      ? totalNow / amount / faceValue
      : currentPrice;
  const previousClose = quotePrices.get(ticker)?.previousClose ?? null;
  const openDailyPnl =
    resolvedCurrentPrice === null || previousClose === null
      ? null
      : (resolvedCurrentPrice - previousClose) * faceValue * amount;
  const dailyRealizedPnl =
    dailyRealizedPnlByTicker.get(ticker.trim().toUpperCase()) ?? 0;
  const dailyPnl =
    openDailyPnl === null && dailyRealizedPnl === 0
      ? null
      : (openDailyPnl ?? 0) + dailyRealizedPnl;
  const dailyPnlBaseline =
    previousClose === null ? null : previousClose * faceValue * amount;

  return {
    integrationId: integration.id,
    integrationKind: integration.kind,
    account: "Freedom24",
    ticker,
    amount,
    averageUnitPrice:
      averageUnitPrice === null ? null : averageUnitPrice * faceValue,
    currentPrice:
      resolvedCurrentPrice === null ? null : resolvedCurrentPrice * faceValue,
    currency: position.curr?.trim() || position.base_currency?.trim() || "USD",
    totalInput,
    totalNow,
    unrealizedPnl:
      normalizeNumber(position.profit_close) ??
      (totalNow !== null && totalInput !== null ? totalNow - totalInput : null),
    realizedPnl: normalizeNumber(position.profit_price),
    dailyPnl,
    dailyPnlPercentage:
      dailyPnl === null || dailyPnlBaseline === null || dailyPnlBaseline === 0
        ? null
        : (dailyPnl / dailyPnlBaseline) * 100,
    dailyPnlBaseline,
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

function isToday(date: Date) {
  const now = new Date();
  return (
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate()
  );
}

function getTodayRealizedPnlByTicker(orders: Freedom24Order[]) {
  const realizedPnlByTicker = new Map<string, number>();

  for (const order of orders) {
    if (
      order.stat !== COMPLETED_ORDER_STATUS ||
      order.oper !== SELL_OPERATION ||
      !order.trade ||
      order.trade.length === 0
    ) {
      continue;
    }

    const ticker = getOrderTicker(order).trim().toUpperCase();
    const realizedPnl = order.trade.reduce((sum, trade) => {
      if (!trade.date) {
        return sum;
      }

      const date = new Date(trade.date);
      if (Number.isNaN(+date) || !isToday(date)) {
        return sum;
      }

      return sum + (normalizeNumber(trade.profit) ?? 0);
    }, 0);

    if (realizedPnl !== 0) {
      realizedPnlByTicker.set(
        ticker,
        (realizedPnlByTicker.get(ticker) ?? 0) + realizedPnl,
      );
    }
  }

  return realizedPnlByTicker;
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

function getQuoteCurrentPrice(quote: Freedom24Quote) {
  return (
    normalizeTradernetNumber(quote.ltp) ??
    normalizeTradernetNumber(quote.bbp) ??
    normalizeTradernetNumber(quote.bap) ??
    normalizeTradernetNumber(quote.close_price) ??
    normalizeTradernetNumber(quote.ClosePrice) ??
    normalizeTradernetNumber(quote.pp) ??
    normalizeTradernetNumber(quote.op)
  );
}

function getQuotePreviousClose(quote: Freedom24Quote) {
  return (
    normalizePositiveTradernetNumber(quote.pp) ??
    normalizePositiveTradernetNumber(quote.close_price) ??
    normalizePositiveTradernetNumber(quote.ClosePrice)
  );
}

async function fetchQuotePrices(
  integration: Integration,
  tickers: string[],
): Promise<Map<string, QuotePrices>> {
  const credentials = parseFreedom24Credentials(integration.credentials);
  const prices = new Map<string, QuotePrices>();

  await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const response = await makeTradernetApiRequest<Freedom24QuotesResponse>(
          credentials.apiKey,
          credentials.secretKey,
          "getStockQuotesJson",
          { tickers: ticker },
        );
        const quotes = response.result?.q
          ? Array.isArray(response.result.q)
            ? response.result.q
            : Object.values(response.result.q)
          : [];
        const quote = quotes.find((item) => item.c === ticker) ?? quotes.at(0);
        if (quote) {
          prices.set(ticker, {
            currentPrice: getQuoteCurrentPrice(quote),
            previousClose: getQuotePreviousClose(quote),
          });
        }
      } catch (error) {
        console.error(`Failed to fetch Freedom24 quote for ${ticker}:`, error);
      }
    }),
  );

  return prices;
}

async function fetchIntegrationOrderHistory(integration: Integration) {
  const orders = await fetchOrderHistoryResponse(integration);
  return mapIntegrationOrderHistory(integration, orders);
}

function mapIntegrationOrderHistory(
  integration: Integration,
  orders: Freedom24Order[],
) {
  return orders.flatMap((order) => {
    const mapped = toIntegrationOrder(integration, order);
    return mapped ? [mapped] : [];
  });
}

export const freedom24Adapter: IntegrationAdapter = {
  async fetchPortfolio(_database: Database, integration: Integration) {
    const [portfolioResponse, rawOrders] = await Promise.all([
      fetchPortfolioResponse(integration),
      fetchOrderHistoryResponse(integration),
    ]);
    const orders = mapIntegrationOrderHistory(integration, rawOrders);
    const dailyRealizedPnlByTicker = getTodayRealizedPnlByTicker(rawOrders);
    const rawPositions = portfolioResponse.result?.ps?.pos ?? [];
    const tickers = [...new Set(rawPositions.map(getPositionTicker))];
    const quotePrices = await fetchQuotePrices(integration, tickers);

    return (
      rawPositions
        .flatMap((position) => {
          const mapped = toPortfolioPosition(
            integration,
            position,
            quotePrices,
            dailyRealizedPnlByTicker,
          );
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
