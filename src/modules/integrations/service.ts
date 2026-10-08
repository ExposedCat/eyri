import {
  getUserIntegrations,
  type Integration,
} from "../database/integration.ts";
import type { Database } from "../database/setup.ts";
import { logFetch } from "../../utils/fetch_logging.ts";
import { freedom24Adapter } from "./freedom24/adapter.ts";
import { ibkrAdapter } from "./ibkr/adapter.ts";
import { trading212Adapter } from "./trading212/adapter.ts";
import { enrichPortfolioWithVontobelQuotes } from "../market_data/vontobel.ts";
import { portfolioValuations } from "./usd.ts";
import type {
  IntegrationAdapter,
  IntegrationPortfolioPosition,
  IntegrationOrder,
} from "./types.ts";

const adapters: Record<Integration["kind"], IntegrationAdapter> = {
  f24: freedom24Adapter,
  ibkr: ibkrAdapter,
  t212: trading212Adapter,
};

const pendingPortfolios = new WeakMap<
  Database,
  Map<string, Promise<IntegrationPortfolioPosition[]>>
>();

function getAdapter(integration: Integration) {
  return adapters[integration.kind];
}

function getPositionKey(position: IntegrationPortfolioPosition) {
  return [
    position.ticker.trim().toUpperCase(),
    position.currency.trim().toUpperCase(),
  ].join(":");
}

function mergePosition(
  current: IntegrationPortfolioPosition,
  next: IntegrationPortfolioPosition,
): IntegrationPortfolioPosition {
  const amount = current.amount + next.amount;
  const totalInput = current.totalInput === null || next.totalInput === null
    ? null
    : current.totalInput + next.totalInput;
  const totalNow = current.totalNow === null || next.totalNow === null
    ? null
    : current.totalNow + next.totalNow;
  const dailyPnl = current.dailyPnl === null || next.dailyPnl === null
    ? null
    : current.dailyPnl + next.dailyPnl;
  const dailyPnlBaseline =
    current.dailyPnlBaseline === null || next.dailyPnlBaseline === null
      ? null
      : current.dailyPnlBaseline + next.dailyPnlBaseline;

  const currentTotalBaseline = current.dailyPnlTotalBaseline ??
    current.dailyPnlBaseline;
  const nextTotalBaseline = next.dailyPnlTotalBaseline ?? next.dailyPnlBaseline;
  const dailyPnlTotalBaseline =
    currentTotalBaseline === null || nextTotalBaseline === null
      ? null
      : currentTotalBaseline + nextTotalBaseline;

  return {
    ...current,
    ...(current.brokerValuations || next.brokerValuations ? {
      brokerValuations: [...portfolioValuations(current), ...portfolioValuations(next)],
    } : {}),
    ...(current.assetCategory == null && next.assetCategory != null
      ? { assetCategory: next.assetCategory }
      : {}),
    account: [current.account, next.account]
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index)
      .join(", "),
    amount,
    averageUnitPrice: totalInput === null || amount === 0
      ? null
      : totalInput / amount,
    currentPrice: totalNow === null || amount === 0 ? null : totalNow / amount,
    totalInput,
    totalNow,
    unrealizedPnl: current.unrealizedPnl === null || next.unrealizedPnl === null
      ? null
      : current.unrealizedPnl + next.unrealizedPnl,
    realizedPnl: current.realizedPnl === null || next.realizedPnl === null
      ? null
      : current.realizedPnl + next.realizedPnl,
    dailyPnl,
    dailyPnlPercentage:
      dailyPnl === null || dailyPnlBaseline === null || dailyPnlBaseline === 0
        ? null
        : (dailyPnl / dailyPnlBaseline) * 100,
    dailyPnlBaseline,
    dailyPnlTotalBaseline,
    openedAt: current.openedAt && next.openedAt
      ? current.openedAt < next.openedAt ? current.openedAt : next.openedAt
      : (current.openedAt ?? next.openedAt),
  };
}

export function mergePositions(positions: IntegrationPortfolioPosition[]) {
  const merged = new Map<string, IntegrationPortfolioPosition>();

  for (const position of positions) {
    const key = getPositionKey(position);
    const current = merged.get(key);
    merged.set(key, current ? mergePosition(current, position) : position);
  }

  return [...merged.values()].sort((a, b) => {
    const totalInputA = a.totalInput ?? 0;
    const totalInputB = b.totalInput ?? 0;
    return totalInputB - totalInputA || a.ticker.localeCompare(b.ticker);
  });
}

async function mapIntegrationData<T>(
  database: Database,
  integrations: Integration[],
  fetcher: (
    adapter: IntegrationAdapter,
    database: Database,
    integration: Integration,
  ) => Promise<T[]>,
) {
  const results = await Promise.allSettled(
    integrations.map((integration) => {
      const adapter = getAdapter(integration);
      return fetcher(adapter, database, integration);
    }),
  );

  const data: T[] = [];
  const errors: Error[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      data.push(...result.value);
    } else {
      const integration = integrations[index];
      const reason = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
      errors.push(
        new Error(
          `${integration.kind} integration #${index + 1}: ${reason}`,
        ),
      );
    }
  }

  if (errors.length > 0) {
    // A partial portfolio would present incomplete balances as a full total.
    throw new Error(
      `Failed to fetch integration data:\n${
        errors.map((error) => error.message).join("\n")
      }`,
    );
  }
  return data;
}

export async function fetchIntegratedPortfolio(
  database: Database,
  userId: number,
  merge = true,
) {
  const integrations = getUserIntegrations(database, userId);
  const positions = await mapIntegrationData(
    database,
    integrations,
    (_adapter, db, integration) => fetchIntegrationPortfolio(db, integration),
  );

  return merge ? mergePositions(positions) : positions;
}

export function fetchIntegratedAccountPerformances(
  database: Database, userId: number,
  positions: IntegrationPortfolioPosition[], orders: IntegrationOrder[],
) {
  return mapIntegrationData(database, getUserIntegrations(database, userId), async (adapter, db, integration) => {
    if (!adapter.fetchAccountPerformance) return [];
    return [await adapter.fetchAccountPerformance(db, integration,
      positions.filter(p => p.integrationId === integration.id),
      orders.filter(o => o.integrationId === integration.id))];
  });
}

export function fetchIntegrationPortfolio(
  database: Database,
  integration: Integration,
) {
  let pending = pendingPortfolios.get(database);
  if (!pending) {
    pending = new Map();
    pendingPortfolios.set(database, pending);
  }
  const key = JSON.stringify([
    integration.id, integration.kind, integration.credentials,
  ]);
  const existing = pending.get(key);
  if (existing) {
    console.log(`Reusing pending ${integration.kind} portfolio fetch integration=${integration.id}`);
    return existing;
  }
  const request = Promise.resolve().then(() =>
    logFetch(
      `${integration.kind} portfolio integration=${integration.id}`,
      async () => enrichPortfolioWithVontobelQuotes(
        await getAdapter(integration).fetchPortfolio(database, integration),
      ),
    )
  ).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export async function fetchIntegrationOrderHistory(
  database: Database,
  integration: Integration,
) {
  const adapter = getAdapter(integration);
  return await adapter.fetchOrderHistory(database, integration);
}

export async function fetchIntegratedOrderHistory(
  database: Database,
  userId: number,
) {
  const integrations = getUserIntegrations(database, userId);
  const orders = await mapIntegrationData(
    database,
    integrations,
    (adapter, db, integration) => adapter.fetchOrderHistory(db, integration),
  );

  return orders.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export async function probeIntegration(integration: Integration) {
  const adapter = getAdapter(integration);
  await adapter.probe?.(integration);
}

export async function fetchIntegratedCfdTransfers(
  database: Database,
  userId: number,
) {
  const integrations = getUserIntegrations(database, userId).filter(
    (integration) => integration.kind === "t212",
  );
  const transactions = await mapIntegrationData(
    database,
    integrations,
    (adapter, db, integration) => adapter.fetchCashHistory!(db, integration),
  );
  return transactions.filter((transaction) => transaction.type === "TRANSFER");
}

// Display history and performance use the same purchases and sales.
export async function fetchIntegratedHistoryOrders(
  database: Database,
  userId: number,
) {
  return fetchIntegratedOrderHistory(database, userId);
}
