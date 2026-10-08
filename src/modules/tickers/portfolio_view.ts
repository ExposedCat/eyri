import type { Database } from "../database/setup.ts";
import {
  getUserBucket,
  getUserBuckets,
  readBucketAssignments,
} from "../database/bucket.ts";
import { hasUserIntegrations } from "../database/integration.ts";
import {
  fetchIntegratedAccountPerformances,
  fetchIntegratedHistoryOrders,
  fetchIntegratedOrderHistory,
  fetchIntegratedPortfolio,
  mergePositions,
} from "../integrations/service.ts";
import {
  buildBucketedPortfolioPositions,
  buildIntegratedSoldPerformances,
  filterHistoryOrdersByBucket,
  getOrderTransactionKey,
} from "./portfolio.ts";
import { portfolioValuations } from "../integrations/usd.ts";
import { adjustOrderForCorporateActions } from "../market_data/corporate_actions.ts";

function portfolioSources(
  db: Database,
  userId: number,
  bucketName: string | null,
) {
  const sources = new Map<number, Set<string | null>>();
  const add = (ownerId: number, name: string | null) => {
    const names = sources.get(ownerId) ?? new Set();
    names.add(name);
    sources.set(ownerId, names);
  };
  if (bucketName !== null) {
    const bucket = getUserBucket(db, userId, bucketName);
    if (!bucket) throw new Error(`Bucket not found: ${bucketName}`);
    add(bucket.ownerUserId, bucket.name);
  } else {
    add(userId, null);
    for (const bucket of getUserBuckets(db, userId)) {
      if (bucket.included) add(bucket.ownerUserId, bucket.name);
    }
  }
  return sources;
}

export function hasPortfolioViewIntegrations(
  db: Database,
  userId: number,
  bucketName: string | null = null,
) {
  return [...portfolioSources(db, userId, bucketName).keys()].some((ownerId) =>
    hasUserIntegrations(db, ownerId)
  );
}

type Options = {
  positions?: boolean;
  history?: boolean;
  displayHistory?: boolean;
  accountPerformance?: boolean;
};
type Runtime = {
  portfolio: typeof fetchIntegratedPortfolio;
  orders: typeof fetchIntegratedOrderHistory;
  history: typeof fetchIntegratedHistoryOrders;
  accounts?: typeof fetchIntegratedAccountPerformances;
};
const runtime: Runtime = {
  portfolio: fetchIntegratedPortfolio,
  orders: fetchIntegratedOrderHistory,
  history: fetchIntegratedHistoryOrders,
  accounts: fetchIntegratedAccountPerformances,
};

export async function fetchPortfolioView(
  db: Database,
  userId: number,
  bucketName: string | null = null,
  options: Options = {},
  fetchers: Runtime = runtime,
) {
  const results = await Promise.all(
    [...portfolioSources(db, userId, bucketName)].map(
      async ([ownerId, names]) => {
        if (
          [...names].some((name) => name !== null) &&
          !hasUserIntegrations(db, ownerId)
        ) {
          throw new Error("The bucket owner's integration is not configured.");
        }
        const transactionBuckets = new Map<string, string>();
        let assignments = readBucketAssignments(db, ownerId);
        const needsOrders = options.history || options.displayHistory ||
          assignments.size > 0 || !names.has(null);
        const [livePositions, sourceOrders] = await Promise.all([
          options.positions === false
            ? []
            : fetchers.portfolio(db, ownerId, false),
          needsOrders
            ? (options.displayHistory ? fetchers.history : fetchers.orders)(
              db,
              ownerId,
            )
            : [],
        ]);
        // Broker imports can migrate legacy CFD assignments to purchase keys.
        assignments = readBucketAssignments(db, ownerId);
        const wholeAccount = bucketName === null && names.has(null) &&
          [...assignments.values()].every((name) => names.has(name));
        const positions = options.positions === false
          ? []
          : wholeAccount
          ? livePositions
          : [...names].flatMap((name) =>
            buildBucketedPortfolioPositions({
              orders: sourceOrders,
              livePositions: mergePositions(livePositions),
              transactionBuckets: assignments,
              bucketName: name,
            })
          );
        const orders = sourceOrders.map((order) => {
          const originalKey = getOrderTransactionKey(order);
          // Preserve each owner's FIFO history without cross-owner bucket collisions.
          const transactionKey = JSON.stringify([ownerId, originalKey]);
          const selected = names.has(assignments.get(originalKey) ?? null);
          if (!selected || bucketName !== null) {
            transactionBuckets.set(
              transactionKey,
              selected ? bucketName! : "__excluded",
            );
          }
          return { ...order, transactionKey };
        });
        // A bucket does not own an account's cash or external contributions.
        // Apply the funding reconciliation only when the complete owner's
        // account is included, never to an excluded or transferred subset.
        const accountPerformances =
          options.accountPerformance && wholeAccount && fetchers.accounts
            ? await fetchers.accounts(db, ownerId, livePositions, sourceOrders)
            : [];
        for (const account of accountPerformances) {
          const valuations = livePositions.filter((p) =>
            p.integrationId === account.integrationId
          ).flatMap(portfolioValuations);
          account.reportedComponents = valuations.map((v) => {
            if (v.totalInput === null || v.unrealizedPnl === null) {
              throw new Error(
                "Cannot reconcile incomplete position valuations",
              );
            }
            return {
              currency: v.currency,
              cost: v.totalInput,
              pnl: v.unrealizedPnl,
            };
          });
          const sold = buildIntegratedSoldPerformances(
            sourceOrders.filter((o) =>
              o.integrationId === account.integrationId
            )
              .map((o) =>
                adjustOrderForCorporateActions(
                  o,
                  new Date().toISOString().slice(0, 10),
                )
              ),
          );
          account.reportedComponents.push(
            ...sold.map((s) => ({
              currency: s.currency,
              cost: s.cost,
              pnl: s.realizedPnl,
            })),
          );
        }
        return { positions, orders, transactionBuckets, accountPerformances };
      },
    ),
  );
  const orders = results.flatMap((result) => result.orders).sort((a, b) =>
    +a.date - +b.date
  );
  const transactionBuckets = new Map(
    results.flatMap((result) => [...result.transactionBuckets]),
  );
  return {
    positions: mergePositions(results.flatMap((result) => result.positions)),
    orders,
    transactionBuckets,
    bucketName,
    accountPerformances: results.flatMap((result) =>
      result.accountPerformances
    ),
    historyOrders: filterHistoryOrdersByBucket(
      orders,
      transactionBuckets,
      bucketName,
    ),
  };
}
