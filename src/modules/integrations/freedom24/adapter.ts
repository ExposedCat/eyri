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
import { yahooOptionContract } from "../../market_data/options.ts";

const COMPLETED_ORDER_STATUS = 21;
const BUY_OPERATION = 1;
const SELL_OPERATION = 3;

type QuotePrices = {
  currentPrice: number | null;
  previousClose: number | null;
  tradedToday: boolean | null;
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

function normalizeTradernetNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    if (!value.trim()) return null;
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

function toPortfolioPosition(
  integration: Integration,
  position: Freedom24PortfolioPosition,
  quotePrices: Map<string, QuotePrices>,
): IntegrationPortfolioPosition | null {
  const amount = normalizeTradernetNumber(position.q);
  if (amount === null || amount === 0) return null;

  const ticker = getPositionTicker(position);
  const faceValue = normalizePositiveTradernetNumber(position.fv);
  const multiplier =
    faceValue !== null
      ? faceValue / 100
      : (normalizePositiveTradernetNumber(position.face_val_a) ?? 1);
  const quote = quotePrices.get(ticker);
  const averagePrice = normalizeTradernetNumber(position.price_a);
  // s is the broker's book cost, including its rounding and corporate actions.
  const totalInput =
    normalizeTradernetNumber(position.s) ??
    (averagePrice === null ? null : averagePrice * multiplier * amount);
  const currentPrice =
    quote?.currentPrice ?? normalizePositiveTradernetNumber(position.mkt_price);
  const totalNow =
    currentPrice === null ? null : currentPrice * multiplier * amount;
  const unrealizedPnl =
    totalNow === null || totalInput === null ? null : totalNow - totalInput;

  // profit_close is unrealized P&L at the previous day's close, not current P&L.
  // Quote pp/p5 are historical prices and are not a daily portfolio baseline.
  const profitAtClose = normalizeTradernetNumber(position.profit_close);
  const valueAtClose =
    totalInput === null || profitAtClose === null
      ? null
      : totalInput + profitAtClose;
  const previousClose =
    valueAtClose ??
    (quote?.previousClose == null
      ? null
      : quote.previousClose * multiplier * amount);
  // Freedom24 reports no daily movement for an instrument without a trade today.
  const dailyPnl =
    totalNow === null
      ? null
      : quote?.tradedToday === false
        ? 0
        : previousClose === null
          ? null
          : totalNow - previousClose;
  const dailyPnlBaseline = dailyPnl === 0 ? totalNow : previousClose;

  return {
    integrationId: integration.id,
    integrationKind: integration.kind,
    account: "Freedom24",
    ticker,
    amount,
    averageUnitPrice: totalInput === null ? null : totalInput / amount,
    currentPrice: currentPrice === null ? null : currentPrice * multiplier,
    currency: position.curr?.trim() || position.base_currency?.trim() || "USD",
    totalInput,
    totalNow,
    unrealizedPnl,
    realizedPnl: null,
    dailyPnl,
    dailyPnlPercentage:
      dailyPnl === null || dailyPnlBaseline === null || dailyPnlBaseline === 0
        ? null
        : (dailyPnl / dailyPnlBaseline) * 100,
    dailyPnlBaseline,
    dailyPnlTotalBaseline: totalNow,
    openedAt: null,
    ...(yahooOptionContract(ticker) ? { historicalPriceMultiplier: multiplier } : {}),
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

function isQuoteMarketOpen(quote: Freedom24Quote) {
  return quote.marketStatus?.trim().toUpperCase() === "OPEN";
}

function getQuoteCurrentPrice(quote: Freedom24Quote, amount: number) {
  if (isQuoteMarketOpen(quote)) {
    return (
      normalizePositiveTradernetNumber(amount < 0 ? quote.bap : quote.bbp) ??
      normalizePositiveTradernetNumber(quote.ltp) ??
      normalizePositiveTradernetNumber(amount < 0 ? quote.bbp : quote.bap)
    );
  }
  return normalizePositiveTradernetNumber(quote.ltp);
}

function getQuotePreviousClose(quote: Freedom24Quote) {
  return (
    normalizePositiveTradernetNumber(quote.close_price) ??
    normalizePositiveTradernetNumber(quote.ClosePrice)
  );
}

function hasTradedToday(quote: Freedom24Quote) {
  if (!quote.ltt) return null;
  const offset = normalizeTradernetNumber(quote.UTCOffset);
  if (offset === null) return null;
  // ltt is exchange-local time; UTCOffset is minutes east of UTC.
  const tradeDate = new Date(
    /(?:Z|[+-]\d{2}:?\d{2})$/.test(quote.ltt) ? quote.ltt : `${quote.ltt}Z`,
  );
  if (Number.isNaN(+tradeDate)) return null;
  const nowAtExchange = new Date(Date.now() + offset * 60_000);
  return (
    tradeDate.toISOString().slice(0, 10) ===
    nowAtExchange.toISOString().slice(0, 10)
  );
}

async function fetchQuotePrices(
  integration: Integration,
  positions: Freedom24PortfolioPosition[],
): Promise<Map<string, QuotePrices>> {
  const credentials = parseFreedom24Credentials(integration.credentials);
  const prices = new Map<string, QuotePrices>();

  await Promise.all(
    positions.map(async (position) => {
      const ticker = getPositionTicker(position);
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
        const quote = quotes.find((item) => item.c === ticker);
        if (quote) {
          prices.set(ticker, {
            currentPrice: getQuoteCurrentPrice(
              quote,
              normalizeTradernetNumber(position.q) ?? 0,
            ),
            previousClose: getQuotePreviousClose(quote),
            tradedToday: hasTradedToday(quote),
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
    const rawPositions = portfolioResponse.result?.ps?.pos ?? [];
    const quotePrices = await fetchQuotePrices(integration, rawPositions);

    return (
      rawPositions
        .flatMap((position) => {
          const mapped = toPortfolioPosition(
            integration,
            position,
            quotePrices,
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
