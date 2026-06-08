import { type Contract, EventName, IBApi } from "@stoqey/ib";
import type { Integration } from "../../database/integration.ts";
import type { Database } from "../../database/setup.ts";
import type {
  IntegrationAdapter,
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../types.ts";
import { getIbkrHostPort, parseIbkrCredentials } from "./credentials.ts";
import { readFlexOrders } from "./flex.ts";

type IbkrConnectionConfig = {
  host: string;
  port: number;
  accountId?: string;
  clientId: number;
  timeoutMs: number;
};

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
) {
  let timeoutId: number | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectOnce(config: IbkrConnectionConfig) {
  const api = new IBApi({ host: config.host, port: config.port });

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        api.off(EventName.connected, onConnected);
        api.off(EventName.error, onError);
      };
      const onConnected = () => {
        cleanup();
        resolve();
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(normalizeError(error));
      };

      api.once(EventName.connected, onConnected);
      api.once(EventName.error, onError);
      api.connect(config.clientId);
    }),
    config.timeoutMs,
    `Timed out connecting to IBKR Gateway at ${config.host}:${config.port}`,
  );

  return api;
}

async function connect(config: IbkrConnectionConfig) {
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt < config.timeoutMs) {
    try {
      return await connectOnce(config);
    } catch (error) {
      lastError = normalizeError(error);
      await wait(1_000);
    }
  }

  throw (
    lastError ??
      new Error(
        `Timed out connecting to IBKR Gateway at ${config.host}:${config.port}`,
      )
  );
}

async function getManagedAccount(api: IBApi, config: IbkrConnectionConfig) {
  if (config.accountId) {
    return config.accountId;
  }

  const accountIds = await withTimeout(
    new Promise<string[]>((resolve, reject) => {
      const cleanup = () => {
        api.off(EventName.managedAccounts, onManagedAccounts);
        api.off(EventName.error, onError);
      };
      const onManagedAccounts = (accounts: string) => {
        cleanup();
        resolve(accounts.split(",").filter(Boolean));
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(normalizeError(error));
      };

      api.once(EventName.managedAccounts, onManagedAccounts);
      api.once(EventName.error, onError);
      api.reqManagedAccts();
    }),
    config.timeoutMs,
    "Timed out waiting for IBKR managed accounts",
  );

  const accountId = accountIds.at(0);
  if (!accountId) {
    throw new Error("IBKR Gateway returned no managed accounts");
  }

  return accountId;
}

function getTicker(contract: Contract) {
  return contract.localSymbol ?? contract.symbol ?? String(contract.conId);
}

function normalizeNumber(value: number | undefined) {
  return value === undefined || value === Number.MAX_VALUE ? null : value;
}

function toPortfolioPosition(
  integration: Integration,
  contract: Contract,
  amount: number,
  marketPrice: number,
  marketValue: number,
  averageCost: number | undefined,
  unrealizedPnl: number | undefined,
  realizedPnl: number | undefined,
  accountName: string | undefined,
): IntegrationPortfolioPosition {
  const currentPrice = normalizeNumber(marketPrice);
  const totalNow = normalizeNumber(marketValue);
  const averageUnitPrice = normalizeNumber(averageCost);
  const resolvedCurrentPrice = currentPrice ??
    (totalNow !== null && amount !== 0 ? totalNow / amount : null);
  const resolvedTotalNow = totalNow ??
    (resolvedCurrentPrice !== null ? resolvedCurrentPrice * amount : null);
  const totalInput = averageUnitPrice === null
    ? null
    : averageUnitPrice * amount;

  return {
    integrationId: integration.id,
    integrationKind: integration.kind,
    account: accountName ?? "",
    ticker: getTicker(contract),
    amount,
    averageUnitPrice,
    currentPrice: resolvedCurrentPrice,
    currency: contract.currency ?? "USD",
    totalInput,
    totalNow: resolvedTotalNow,
    unrealizedPnl: normalizeNumber(unrealizedPnl),
    realizedPnl: normalizeNumber(realizedPnl),
    openedAt: null,
  };
}

function getPositionOrderKey(ticker: string, currency: string) {
  return `${ticker.trim().toUpperCase()}:${currency.trim().toUpperCase()}`;
}

function getOpenLotCostBasis(
  position: IntegrationPortfolioPosition,
  orders: IntegrationOrder[],
) {
  const matchingOrders = orders
    .filter((order) =>
      getPositionOrderKey(order.ticker, order.currency) ===
        getPositionOrderKey(position.ticker, position.currency) &&
      order.price !== null
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const lots: { quantity: number; price: number; date: Date }[] = [];

  for (const order of matchingOrders) {
    if (order.quantity > 0) {
      lots.push({
        quantity: order.quantity,
        price: order.price ?? 0,
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
  let totalInput = 0;
  const openLotDate = lots.reduce(
    (earliest, lot) =>
      earliest === null || lot.date.getTime() < earliest.getTime()
        ? lot.date
        : earliest,
    null as Date | null,
  );

  for (
    let index = lots.length - 1;
    index >= 0 && remainingQuantity > 0;
    index--
  ) {
    const lot = lots[index];
    const usedQuantity = Math.min(lot.quantity, remainingQuantity);
    totalInput += usedQuantity * lot.price;
    remainingQuantity -= usedQuantity;
  }

  if (targetQuantity === 0 || remainingQuantity > 0) {
    return {
      averageUnitPrice: null,
      totalInput: null,
      openedAt: openLotDate,
    };
  }

  return {
    averageUnitPrice: totalInput / targetQuantity,
    totalInput,
    openedAt: openLotDate,
  };
}

function enrichPortfolioWithOrders(
  positions: IntegrationPortfolioPosition[],
  orders: IntegrationOrder[],
) {
  if (orders.length === 0) {
    return positions;
  }

  return positions.map((position) => {
    const basis = getOpenLotCostBasis(position, orders);
    if (!basis) {
      return position;
    }

    return {
      ...position,
      averageUnitPrice: position.averageUnitPrice ?? basis.averageUnitPrice,
      totalInput: position.totalInput ?? basis.totalInput,
      openedAt: position.openedAt ?? basis.openedAt,
    };
  });
}

async function getAccountPortfolio(
  api: IBApi,
  integration: Integration,
  accountId: string,
  config: IbkrConnectionConfig,
) {
  const positions = new Map<string, IntegrationPortfolioPosition>();

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          api.off(EventName.updatePortfolio, onUpdatePortfolio);
          api.off(EventName.accountDownloadEnd, onAccountDownloadEnd);
          api.off(EventName.error, onError);
        };
        const onUpdatePortfolio = (
          contract: Contract,
          amount: number,
          marketPrice: number,
          marketValue: number,
          averageCost?: number,
          unrealizedPnl?: number,
          realizedPnl?: number,
          accountName?: string,
        ) => {
          if (amount === 0) {
            return;
          }

          const position = toPortfolioPosition(
            integration,
            contract,
            amount,
            marketPrice,
            marketValue,
            averageCost,
            unrealizedPnl,
            realizedPnl,
            accountName,
          );
          positions.set(`${position.account}:${position.ticker}`, position);
        };
        const onAccountDownloadEnd = () => {
          cleanup();
          resolve();
        };
        const onError = (error: unknown) => {
          cleanup();
          reject(normalizeError(error));
        };

        api.on(EventName.updatePortfolio, onUpdatePortfolio);
        api.once(EventName.accountDownloadEnd, onAccountDownloadEnd);
        api.once(EventName.error, onError);
        api.reqAccountUpdates(true, accountId);
      }),
      config.timeoutMs,
      `Timed out waiting for IBKR account portfolio for ${accountId}`,
    );
  } finally {
    api.reqAccountUpdates(false, accountId);
  }

  return [...positions.values()].sort((a, b) =>
    a.ticker.localeCompare(b.ticker)
  );
}

function getConnectionConfig(integration: Integration) {
  const credentials = parseIbkrCredentials(integration.credentials);
  const { host, port } = getIbkrHostPort(credentials.instanceUrl);
  return {
    credentials,
    config: {
      host,
      port,
      accountId: credentials.accountId,
      clientId: credentials.clientId,
      timeoutMs: credentials.timeoutMs,
    },
  };
}

export const ibkrAdapter: IntegrationAdapter = {
  async fetchPortfolio(database: Database, integration: Integration) {
    const { config } = getConnectionConfig(integration);
    const api = await connect(config);

    try {
      const accountId = await getManagedAccount(api, config);
      const positions = await getAccountPortfolio(
        api,
        integration,
        accountId,
        config,
      );
      return enrichPortfolioWithOrders(
        positions,
        readFlexOrders(database, integration),
      );
    } finally {
      api.disconnect();
    }
  },

  async fetchOrderHistory(database: Database, integration: Integration) {
    return readFlexOrders(database, integration);
  },

  async probe(integration: Integration) {
    const { config } = getConnectionConfig(integration);
    const api = await connect(config);

    try {
      await getManagedAccount(api, config);
    } finally {
      api.disconnect();
    }
  },
};
