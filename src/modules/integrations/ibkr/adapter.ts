import {
  type Contract,
  EventName,
  type Execution,
  type ExecutionFilter,
  IBApi,
} from "@stoqey/ib";
import { getAllIntegrations } from "../../database/integration.ts";
import type { Integration } from "../../database/integration.ts";
import type { Database } from "../../database/setup.ts";
import type {
  IntegrationAdapter,
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../types.ts";
import { getIbkrHostPort, parseIbkrCredentials } from "./credentials.ts";
import { readFlexOrders } from "./flex.ts";

const EXECUTION_SYNC_INTERVAL_MS = 15 * 1000;
const EXECUTION_CLIENT_ID_OFFSET = 1000;
const EXECUTION_SYNC_REQUEST_ID = 90_000;

type IbkrConnectionConfig = {
  host: string;
  port: number;
  accountId?: string;
  clientId: number;
  timeoutMs: number;
};

type IbkrPortfolioPosition = IntegrationPortfolioPosition & {
  conId?: number;
};

type IbkrExecutionRow = {
  integration_id: number;
  account: string | null;
  ticker: string;
  date: string;
  quantity: number;
  price: number | null;
  currency: string | null;
  asset_category: string | null;
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

function normalizeIbkrCallbackError(args: unknown[]) {
  const message = args.find((arg): arg is string => typeof arg === "string");
  if (message) {
    return new Error(message);
  }

  const error = args.find((arg): arg is Error => arg instanceof Error);
  return error ?? new Error(args.map(String).join(" "));
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

function formatDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getTodayUtc() {
  const today = new Date();
  return new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
}

function normalizeNumber(value: number | undefined) {
  return value === undefined || value === Number.MAX_VALUE ? null : value;
}

function normalizePnlNumber(value: number | undefined) {
  return value === undefined ||
    !Number.isFinite(value) ||
    value === Number.MAX_VALUE
    ? null
    : value;
}

function normalizeExecutionNumber(value: number | undefined) {
  return value === undefined ||
    !Number.isFinite(value) ||
    value === Number.MAX_VALUE
    ? null
    : value;
}

function getSignedExecutionQuantity(execution: Execution) {
  const shares = normalizeExecutionNumber(execution.shares);
  if (shares === null || shares === 0) {
    return null;
  }

  const side = execution.side?.toUpperCase();
  if (side === "SLD" || side === "SELL" || side === "S") {
    return -Math.abs(shares);
  }
  if (side === "BOT" || side === "BUY" || side === "B") {
    return Math.abs(shares);
  }

  return shares;
}

function parseExecutionDate(value: string | undefined) {
  if (!value) {
    return getTodayUtc();
  }

  const datePart = value.match(/\d{4}-?\d{2}-?\d{2}/)?.[0];
  if (!datePart) {
    return getTodayUtc();
  }

  const normalized = datePart.replaceAll("-", "");
  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(4, 6));
  const day = Number(normalized.slice(6, 8));
  if ([year, month, day].some(Number.isNaN)) {
    return getTodayUtc();
  }

  return new Date(Date.UTC(year, month - 1, day));
}

function ensureExecutionSchema(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ibkr_executions (
      integration_id INTEGER NOT NULL,
      exec_id TEXT NOT NULL,
      account TEXT,
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL,
      currency TEXT,
      asset_category TEXT,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (integration_id, exec_id)
    );

    CREATE INDEX IF NOT EXISTS ibkr_executions_integration_date_idx
      ON ibkr_executions(integration_id, date);
  `);
}

function toExecutionOrder(
  integration: Integration,
  contract: Contract,
  execution: Execution,
) {
  const execId = execution.execId;
  const quantity = getSignedExecutionQuantity(execution);
  if (!execId || quantity === null) {
    return null;
  }

  return {
    execId,
    order: {
      integrationId: integration.id,
      integrationKind: integration.kind,
      account: execution.acctNumber ?? "",
      ticker: getTicker(contract),
      date: parseExecutionDate(execution.time),
      quantity,
      price: normalizeExecutionNumber(execution.price),
      currency: contract.currency ?? "USD",
      assetCategory: contract.secType ?? null,
    },
  };
}

function writeExecutionOrders(
  database: Database,
  integration: Integration,
  orders: { execId: string; order: IntegrationOrder }[],
) {
  ensureExecutionSchema(database);
  const syncedAt = new Date().toISOString();
  const insertExecution = database.prepare(`
    INSERT INTO ibkr_executions (
      integration_id,
      exec_id,
      account,
      ticker,
      date,
      quantity,
      price,
      currency,
      asset_category,
      synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(integration_id, exec_id) DO UPDATE SET
      account = excluded.account,
      ticker = excluded.ticker,
      date = excluded.date,
      quantity = excluded.quantity,
      price = excluded.price,
      currency = excluded.currency,
      asset_category = excluded.asset_category,
      synced_at = excluded.synced_at
  `);

  for (const { execId, order } of orders) {
    insertExecution.run(
      integration.id,
      execId,
      order.account,
      order.ticker,
      formatDateKey(order.date),
      order.quantity,
      order.price,
      order.currency,
      order.assetCategory,
      syncedAt,
    );
  }
}

async function fetchTodayExecutions(
  api: IBApi,
  integration: Integration,
  accountId: string,
  config: IbkrConnectionConfig,
) {
  const orders: { execId: string; order: IntegrationOrder }[] = [];
  const filter: ExecutionFilter = { acctCode: accountId };

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        api.off(EventName.execDetails, onExecDetails);
        api.off(EventName.execDetailsEnd, onExecDetailsEnd);
        api.off(EventName.error, onError);
      };
      const onExecDetails = (
        reqId: number,
        contract: Contract,
        execution: Execution,
      ) => {
        if (reqId !== EXECUTION_SYNC_REQUEST_ID) {
          return;
        }

        const order = toExecutionOrder(integration, contract, execution);
        if (order) {
          orders.push(order);
        }
      };
      const onExecDetailsEnd = (reqId: number) => {
        if (reqId !== EXECUTION_SYNC_REQUEST_ID) {
          return;
        }

        cleanup();
        resolve();
      };
      const onError = (...args: unknown[]) => {
        cleanup();
        reject(normalizeIbkrCallbackError(args));
      };

      api.on(EventName.execDetails, onExecDetails);
      api.once(EventName.execDetailsEnd, onExecDetailsEnd);
      api.once(EventName.error, onError);
      api.reqExecutions(EXECUTION_SYNC_REQUEST_ID, filter);
    }),
    config.timeoutMs,
    `Timed out waiting for IBKR executions for ${accountId}`,
  );

  return orders;
}

async function syncIntegrationExecutions(
  database: Database,
  integration: Integration,
) {
  const { config } = getConnectionConfig(integration);
  const executionConfig = {
    ...config,
    clientId: config.clientId + EXECUTION_CLIENT_ID_OFFSET,
  };
  const api = await connect(executionConfig);

  try {
    const accountId = await getManagedAccount(api, executionConfig);
    const orders = await fetchTodayExecutions(
      api,
      integration,
      accountId,
      executionConfig,
    );
    writeExecutionOrders(database, integration, orders);
  } finally {
    api.disconnect();
  }
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
): IbkrPortfolioPosition {
  const currentPrice = normalizeNumber(marketPrice);
  const totalNow = normalizeNumber(marketValue);
  const averageUnitPrice = normalizeNumber(averageCost);
  const resolvedCurrentPrice =
    currentPrice ??
    (totalNow !== null && amount !== 0 ? totalNow / amount : null);
  const resolvedTotalNow =
    totalNow ??
    (resolvedCurrentPrice !== null ? resolvedCurrentPrice * amount : null);
  const totalInput =
    averageUnitPrice === null ? null : averageUnitPrice * amount;

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
    dailyPnl: null,
    dailyPnlPercentage: null,
    dailyPnlBaseline: null,
    openedAt: null,
    conId: contract.conId,
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
    .filter(
      (order) =>
        getPositionOrderKey(order.ticker, order.currency) ===
          getPositionOrderKey(position.ticker, position.currency) &&
        order.price !== null,
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
  positions: IbkrPortfolioPosition[],
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

async function readDailyPnl(
  api: IBApi,
  positions: IbkrPortfolioPosition[],
  accountId: string,
  config: IbkrConnectionConfig,
) {
  const requestIdByConId = new Map<number, number>();
  const dailyPnlByConId = new Map<
    number,
    { dailyPnl: number | null; marketValue: number | null }
  >();

  positions.forEach((position, index) => {
    if (position.conId === undefined) {
      return;
    }
    requestIdByConId.set(position.conId, 50_000 + index);
  });

  if (requestIdByConId.size === 0) {
    return dailyPnlByConId;
  }

  await new Promise<void>((resolve) => {
    let timeoutId: number | undefined;
    const onPnlSingle = (
      reqId: number,
      _position: number,
      dailyPnL: number,
      _unrealizedPnL: number | undefined,
      _realizedPnL: number | undefined,
      value: number,
    ) => {
      const conId = [...requestIdByConId.entries()].find(
        ([, requestId]) => requestId === reqId,
      )?.[0];
      if (conId === undefined) {
        return;
      }

      dailyPnlByConId.set(conId, {
        dailyPnl: normalizePnlNumber(dailyPnL),
        marketValue: normalizePnlNumber(value),
      });

      if (dailyPnlByConId.size === requestIdByConId.size) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      api.off(EventName.pnlSingle, onPnlSingle);
      for (const reqId of requestIdByConId.values()) {
        try {
          api.cancelPnLSingle(reqId);
        } catch {
          // Ignore cancellation failures; PnL enrichment is best-effort.
        }
      }
    };

    api.on(EventName.pnlSingle, onPnlSingle);
    for (const [conId, reqId] of requestIdByConId.entries()) {
      api.reqPnLSingle(reqId, accountId, "", conId);
    }
    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, config.timeoutMs);
  });

  return dailyPnlByConId;
}

async function enrichPortfolioWithDailyPnl(
  api: IBApi,
  positions: IbkrPortfolioPosition[],
  accountId: string,
  config: IbkrConnectionConfig,
): Promise<IbkrPortfolioPosition[]> {
  const dailyPnlByConId = await readDailyPnl(api, positions, accountId, config);

  return positions.map((position) => {
    const dailyPnl = position.conId
      ? (dailyPnlByConId.get(position.conId)?.dailyPnl ?? null)
      : null;
    const marketValue = position.conId
      ? (dailyPnlByConId.get(position.conId)?.marketValue ?? null)
      : null;
    const baseline =
      dailyPnl === null || marketValue === null ? null : marketValue - dailyPnl;

    return {
      ...position,
      dailyPnl,
      dailyPnlBaseline: baseline,
      dailyPnlPercentage:
        dailyPnl === null || baseline === null || baseline === 0
          ? null
          : (dailyPnl / baseline) * 100,
    };
  });
}

async function getAccountPortfolio(
  api: IBApi,
  integration: Integration,
  accountId: string,
  config: IbkrConnectionConfig,
) {
  const positions = new Map<string, IbkrPortfolioPosition>();

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
    a.ticker.localeCompare(b.ticker),
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

export async function syncIbkrExecutions(database: Database) {
  const integrations = getAllIntegrations(database).filter(
    (integration) => integration.kind === "ibkr",
  );

  for (const integration of integrations) {
    try {
      await syncIntegrationExecutions(database, integration);
    } catch (error) {
      console.error(
        `Failed to sync IBKR executions integration=${integration.id}:`,
        error,
      );
    }
  }
}

let isExecutionSyncRunning = false;
let executionSyncTimer: number | null = null;

export function startIbkrExecutionSyncLoop(database: Database) {
  ensureExecutionSchema(database);
  if (executionSyncTimer !== null) {
    return;
  }

  const run = async () => {
    if (isExecutionSyncRunning) {
      return;
    }

    isExecutionSyncRunning = true;
    try {
      await syncIbkrExecutions(database);
    } finally {
      isExecutionSyncRunning = false;
    }
  };

  executionSyncTimer = setInterval(run, EXECUTION_SYNC_INTERVAL_MS);
  run();
}

export function readExecutionOrders(
  database: Database,
  integration: Integration,
): IntegrationOrder[] {
  ensureExecutionSchema(database);
  const rows = database
    .prepare(`
      SELECT
        integration_id,
        account,
        ticker,
        date,
        quantity,
        price,
        currency,
        asset_category
      FROM ibkr_executions
      WHERE integration_id = ?
      ORDER BY date
    `)
    .all(integration.id) as IbkrExecutionRow[];

  return rows.map((row) => ({
    integrationId: row.integration_id,
    integrationKind: integration.kind,
    account: row.account ?? "",
    ticker: row.ticker,
    date: new Date(row.date),
    quantity: row.quantity,
    price: row.price,
    currency: row.currency ?? "USD",
    assetCategory: row.asset_category,
  }));
}

function getOrderMergeKey(order: IntegrationOrder) {
  return [
    formatDateKey(order.date),
    order.ticker,
    order.quantity,
    order.price ?? "",
    order.currency,
    order.assetCategory ?? "",
  ].join(":");
}

function readIbkrOrders(database: Database, integration: Integration) {
  const merged = new Map<string, IntegrationOrder>();
  const flexOrders = readFlexOrders(database, integration);
  const latestFlexDate = flexOrders.reduce(
    (latest, order) =>
      latest === null || order.date > latest ? order.date : latest,
    null as Date | null,
  );

  for (const order of flexOrders) {
    merged.set(getOrderMergeKey(order), order);
  }
  for (const order of readExecutionOrders(database, integration)) {
    if (latestFlexDate && order.date <= latestFlexDate) {
      continue;
    }

    merged.set(getOrderMergeKey(order), order);
  }

  return [...merged.values()].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
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
      const positionsWithDailyPnl = await enrichPortfolioWithDailyPnl(
        api,
        positions,
        accountId,
        config,
      );
      return enrichPortfolioWithOrders(
        positionsWithDailyPnl,
        readIbkrOrders(database, integration),
      );
    } finally {
      api.disconnect();
    }
  },

  async fetchOrderHistory(database: Database, integration: Integration) {
    return readIbkrOrders(database, integration);
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
