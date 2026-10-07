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
import {
  historicalQuoteMultiplier,
  yahooOptionContract,
} from "../../market_data/options.ts";

const COMPLETED_ORDER_STATUS = 21;
const BUY_OPERATION = 1;
const SELL_OPERATION = 3;
const BUY_ON_MARGIN_OPERATION = 2;
const SELL_SHORT_OPERATION = 4;
const HISTORY_PAGE_SIZE = 1000;
type HistoricalExecution = IntegrationOrder & { executionId?: string };

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
  const multiplier = faceValue !== null
    ? faceValue / 100
    : (normalizePositiveTradernetNumber(position.face_val_a) ?? 1);
  const quote = quotePrices.get(ticker);
  const averagePrice = normalizeTradernetNumber(position.price_a);
  // s is the broker's book cost, including its rounding and corporate actions.
  const totalInput = normalizeTradernetNumber(position.s) ??
    (averagePrice === null ? null : averagePrice * multiplier * amount);
  const currentPrice = quote?.currentPrice ??
    normalizePositiveTradernetNumber(position.mkt_price);
  const totalNow = currentPrice === null
    ? null
    : currentPrice * multiplier * amount;
  const unrealizedPnl = totalNow === null || totalInput === null
    ? null
    : totalNow - totalInput;

  // profit_close is unrealized P&L at the previous day's close, not current P&L.
  // Quote pp/p5 are historical prices and are not a daily portfolio baseline.
  const profitAtClose = normalizeTradernetNumber(position.profit_close);
  const valueAtClose = totalInput === null || profitAtClose === null
    ? null
    : totalInput + profitAtClose;
  const previousClose = valueAtClose ??
    (quote?.previousClose == null
      ? null
      : quote.previousClose * multiplier * amount);
  // Freedom24 reports no daily movement for an instrument without a trade today.
  const dailyPnl = totalNow === null
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
    ...(yahooOptionContract(ticker)
      ? { historicalPriceMultiplier: multiplier }
      : {}),
  };
}

function getOrderTicker(order: Freedom24Order) {
  return order.instr?.trim() || order.base_contract_code?.trim() || "UNKNOWN";
}

function getOrderCurrency(order: Freedom24Order) {
  return (
    order.curr?.trim() ||
    order.cur?.trim() ||
    order.curr_c?.trim() ||
    order.base_currency?.trim() ||
    "USD"
  );
}

function toIntegrationOrders(
  integration: Integration,
  order: Freedom24Order,
): HistoricalExecution[] {
  const operation = normalizeTradernetNumber(order.oper);
  const direction =
    operation === BUY_OPERATION || operation === BUY_ON_MARGIN_OPERATION
      ? 1
      : operation === SELL_OPERATION || operation === SELL_SHORT_OPERATION
      ? -1
      : 0;
  if (!direction) return [];
  const ticker = getOrderTicker(order), currency = getOrderCurrency(order);
  const make = (
    date: Date,
    quantity: number,
    price: number | null,
  ): IntegrationOrder => ({
    integrationId: integration.id,
    integrationKind: integration.kind,
    account: "Freedom24",
    ticker,
    date,
    quantity: direction * Math.abs(quantity),
    price,
    currency,
    assetCategory: null,
  });
  if (order.trade?.length) {
    // Filled quantities survive a partial order's cancellation or expiration.
    // Each execution keeps its own time: an aggregate at the earliest fill can
    // move later sales ahead of the purchases that actually funded them.
    const fills = order.trade.map((trade) => {
      const date = new Date(trade.date ?? ""),
        quantity = normalizeTradernetNumber(trade.q);
      if (Number.isNaN(+date) || quantity === null || quantity <= 0) {
        throw new Error(
          `Invalid Freedom24 execution date or quantity for ${ticker}.`,
        );
      }
      const value = normalizeTradernetNumber(trade.v),
        premium = normalizeTradernetNumber(trade.p);
      const multiplier = normalizePositiveTradernetNumber(trade.fv);
      const price = value === null
        ? premium === null
          ? null
          : premium * (multiplier === null
            ? historicalQuoteMultiplier({
              ticker,
              integrationKind: integration.kind,
            })
            : multiplier / 100)
        : Math.abs(value / quantity);
      if (price === null || !Number.isFinite(price) || price < 0) {
        throw new Error(`Invalid Freedom24 execution price for ${ticker}.`);
      }
      return { trade, order: make(date, quantity, price) };
    });
    // Retain the old aggregate's bucket identity for every execution of an order.
    const first = fills.map((fill) =>
      fill.order.date.toISOString().slice(0, 10)
    ).sort()[0];
    const transactionKey = JSON.stringify([
      first,
      ticker.trim().toUpperCase(),
      currency.trim().toUpperCase(),
    ]);
    return fills.map(({ trade, order }) => ({
      ...order,
      transactionKey,
      // Private mapping metadata is consumed below, never exposed as a bucket key.
      ...(trade.id === undefined ? {} : { executionId: String(trade.id) }),
    }));
  }
  // Some archived fully executed orders omit the execution list. Only their
  // completed status establishes that the requested quantity actually filled.
  if (normalizeTradernetNumber(order.stat) !== COMPLETED_ORDER_STATUS) {
    return [];
  }
  const date = new Date(order.date ?? ""),
    quantity = normalizeTradernetNumber(order.q);
  if (Number.isNaN(+date) || quantity === null || quantity <= 0) {
    throw new Error(`Invalid completed Freedom24 order for ${ticker}.`);
  }
  const price = normalizeTradernetNumber(order.p);
  if (price === null || price < 0) {
    throw new Error(`Invalid completed Freedom24 order price for ${ticker}.`);
  }
  return [make(date, quantity, price)];
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

  const orders = new Map<string, Freedom24Order>();
  for (let skip = 0;;) {
    const response = await makeTradernetApiRequest<
      Freedom24OrderHistoryResponse
    >(
      credentials.apiKey,
      credentials.secretKey,
      "getOrdersHistory",
      {
        from: from.toISOString(),
        till: to.toISOString(),
        // Legacy v2 accepts pagination but rejects the documented "order"
        // parameter. Executions are sorted locally after all pages arrive.
        page: { take: HISTORY_PAGE_SIZE, skip },
      },
    );
    const page = response?.orders?.order;
    if (page === null) break;
    if (!Array.isArray(page)) {
      throw new Error(
        "Freedom24 order history response did not include orders",
      );
    }
    let added = 0;
    for (const order of page) {
      if (!order || typeof order !== "object") {
        throw new Error("Invalid Freedom24 historical order");
      }
      const key = order.id === undefined
        ? JSON.stringify(order)
        : String(order.id);
      if (!orders.has(key)) added++;
      orders.set(key, order);
    }
    if (page.length < HISTORY_PAGE_SIZE) break;
    if (!added) {
      throw new Error("Freedom24 order history pagination did not advance");
    }
    skip += page.length;
  }
  return [...orders.values()];
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
  const executions = new Map<string, IntegrationOrder>();
  const result: IntegrationOrder[] = [];
  for (const rawOrder of orders) {
    for (const mapped of toIntegrationOrders(integration, rawOrder)) {
      const { executionId, ...order } = mapped;
      if (executionId !== undefined) {
        const previous = executions.get(executionId);
        if (previous) {
          if (
            JSON.stringify({ ...previous, transactionKey: undefined }) !==
              JSON.stringify({ ...order, transactionKey: undefined })
          ) {
            throw new Error("Conflicting Freedom24 historical executions");
          }
          continue;
        }
        executions.set(executionId, order);
      }
      result.push(order);
    }
  }
  return result.sort((a, b) => +a.date - +b.date);
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

  fetchOrderHistory(_database: Database, integration: Integration) {
    return fetchIntegrationOrderHistory(integration);
  },

  async probe(integration: Integration) {
    await fetchPortfolioResponse(integration);
  },
};
