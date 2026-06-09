import {
  getUserIntegrations,
  type Integration,
} from "../database/integration.ts";
import type { Database } from "../database/setup.ts";
import { ibkrAdapter } from "./ibkr/adapter.ts";
import type {
  IntegrationAdapter,
  IntegrationPortfolioPosition,
} from "./types.ts";

const adapters: Record<Integration["kind"], IntegrationAdapter> = {
  ibkr: ibkrAdapter,
};

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
  const totalInput =
    current.totalInput === null || next.totalInput === null
      ? null
      : current.totalInput + next.totalInput;
  const totalNow =
    current.totalNow === null || next.totalNow === null
      ? null
      : current.totalNow + next.totalNow;

  return {
    ...current,
    account: [current.account, next.account]
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index)
      .join(", "),
    amount,
    averageUnitPrice:
      totalInput === null || amount === 0 ? null : totalInput / amount,
    currentPrice: totalNow === null || amount === 0 ? null : totalNow / amount,
    totalInput,
    totalNow,
    unrealizedPnl:
      current.unrealizedPnl === null || next.unrealizedPnl === null
        ? null
        : current.unrealizedPnl + next.unrealizedPnl,
    realizedPnl:
      current.realizedPnl === null || next.realizedPnl === null
        ? null
        : current.realizedPnl + next.realizedPnl,
    openedAt:
      current.openedAt && next.openedAt
        ? current.openedAt < next.openedAt
          ? current.openedAt
          : next.openedAt
        : (current.openedAt ?? next.openedAt),
  };
}

function mergePositions(positions: IntegrationPortfolioPosition[]) {
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
  for (const result of results) {
    if (result.status === "fulfilled") {
      data.push(...result.value);
    } else {
      errors.push(
        result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason)),
      );
    }
  }

  if (data.length === 0 && errors.length > 0) {
    throw errors[0];
  }

  errors.forEach((error) => {
    console.error("Failed to fetch integration data:", error);
  });
  return data;
}

export async function fetchIntegratedPortfolio(
  database: Database,
  userId: number,
) {
  const integrations = getUserIntegrations(database, userId);
  const positions = await mapIntegrationData(
    database,
    integrations,
    (adapter, db, integration) => adapter.fetchPortfolio(db, integration),
  );

  return mergePositions(positions);
}

export async function fetchIntegrationPortfolio(
  database: Database,
  integration: Integration,
) {
  const adapter = getAdapter(integration);
  return await adapter.fetchPortfolio(database, integration);
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
