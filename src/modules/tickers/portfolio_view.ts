import type { Database } from "../database/setup.ts";
import {
  getUserBucket,
  getUserBuckets,
  readBucketAssignments,
} from "../database/bucket.ts";
import { hasUserIntegrations } from "../database/integration.ts";
import {
  fetchIntegratedHistoryOrders,
  fetchIntegratedOrderHistory,
  fetchIntegratedPortfolio,
  mergePositions,
} from "../integrations/service.ts";
import {
  buildBucketedPortfolioPositions,
  filterHistoryOrdersByBucket,
  getOrderTransactionKey,
} from "./portfolio.ts";

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
};
type Runtime = {
  portfolio: typeof fetchIntegratedPortfolio;
  orders: typeof fetchIntegratedOrderHistory;
  history: typeof fetchIntegratedHistoryOrders;
};
const runtime: Runtime = {
  portfolio: fetchIntegratedPortfolio,
  orders: fetchIntegratedOrderHistory,
  history: fetchIntegratedHistoryOrders,
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
          options.positions === false ? [] : fetchers.portfolio(db, ownerId),
          needsOrders
            ? (options.displayHistory ? fetchers.history : fetchers.orders)(
              db,
              ownerId,
            )
            : [],
        ]);
        // Broker imports can migrate legacy CFD assignments to purchase keys.
        assignments = readBucketAssignments(db, ownerId);
        const positions = options.positions === false
          ? []
          : assignments.size === 0 && names.has(null)
          ? livePositions
          : [...names].flatMap((name) =>
            buildBucketedPortfolioPositions({
              orders: sourceOrders,
              livePositions,
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
        return { positions, orders, transactionBuckets };
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
    historyOrders: filterHistoryOrdersByBucket(
      orders,
      transactionBuckets,
      bucketName,
    ),
  };
}
