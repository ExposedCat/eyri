import type { Database } from "../database/setup.ts";
import {
  getUserBucket,
  getUserBuckets,
  readBucketAllocations,
  readBucketAssignments,
} from "../database/bucket.ts";
import { applyBucketAllocations, scaleOrder } from "./bucket_allocations.ts";
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
import type { AccountPerformanceOptions, IntegrationPortfolioPosition } from "../integrations/types.ts";
import { adjustOrderForCorporateActions } from "../market_data/corporate_actions.ts";
import { buildBucketCashAccounts, excludeBucketCapital } from "./bucket_funding.ts";

type PortfolioSource = {
  ownerId: number;
  share: number;
  // 0 for an owner's first share in this view; later shares of the same owner
  // are separate copies of that owner's history.
  copy: number;
  names: Set<string | null>;
};

// Sources are grouped per owner and share: a partial grant scales all of the
// owner's orders and holdings, so FIFO and bucket allocation stay consistent.
function portfolioSources(
  db: Database,
  userId: number,
  bucketName: string | null,
) {
  const sources = new Map<string, PortfolioSource>();
  const add = (ownerId: number, share: number, name: string | null) => {
    const key = `${ownerId}:${share}`;
    const copy = [...sources.values()].filter((item) => item.ownerId === ownerId)
      .length;
    const source = sources.get(key) ?? { ownerId, share, copy, names: new Set() };
    source.names.add(name);
    sources.set(key, source);
  };
  if (bucketName !== null) {
    const bucket = getUserBucket(db, userId, bucketName);
    if (!bucket) throw new Error(`Bucket not found: ${bucketName}`);
    add(bucket.ownerUserId, bucket.share, bucket.name);
  } else {
    add(userId, 1, null);
    for (const bucket of getUserBuckets(db, userId)) {
      if (bucket.included) add(bucket.ownerUserId, bucket.share, bucket.name);
    }
  }
  return [...sources.values()];
}

const scaleNullable = <T extends number | null | undefined>(
  value: T,
  share: number,
) => (typeof value === "number" ? value * share : value) as T;

export function scalePosition(
  position: IntegrationPortfolioPosition,
  share: number,
): IntegrationPortfolioPosition {
  if (share === 1) return position;
  // Unit prices and percentages are unchanged; quantities and money scale.
  return {
    ...position,
    amount: position.amount * share,
    totalInput: scaleNullable(position.totalInput, share),
    totalNow: scaleNullable(position.totalNow, share),
    unrealizedPnl: scaleNullable(position.unrealizedPnl, share),
    realizedPnl: scaleNullable(position.realizedPnl, share),
    dailyPnl: scaleNullable(position.dailyPnl, share),
    dailyPnlBaseline: scaleNullable(position.dailyPnlBaseline, share),
    dailyPnlTotalBaseline: scaleNullable(position.dailyPnlTotalBaseline, share),
    brokerValuations: position.brokerValuations?.map((valuation) => ({
      ...valuation,
      totalInput: scaleNullable(valuation.totalInput, share),
      totalNow: scaleNullable(valuation.totalNow, share),
      unrealizedPnl: scaleNullable(valuation.unrealizedPnl, share),
    })),
  };
}


export function hasPortfolioViewIntegrations(
  db: Database,
  userId: number,
  bucketName: string | null = null,
) {
  return portfolioSources(db, userId, bucketName).some(({ ownerId }) =>
    hasUserIntegrations(db, ownerId)
  );
}

type Options = {
  positions?: boolean;
  history?: boolean;
  displayHistory?: boolean;
  accountPerformance?: boolean;
  accountPerformanceOptions?: AccountPerformanceOptions;
  // Stock-only reports still need broker holdings for bucket/funding calculations,
  // but must not depend on issuer quotes for excluded warrants.
  warrantQuotes?: boolean;
};
type Runtime = {
  request?: typeof fetch;
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
    portfolioSources(db, userId, bucketName).map(
      async ({ ownerId, share, copy, names }) => {
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
        const [ownerPositions, ownerOrders] = await Promise.all([
          options.positions === false
            ? []
            : fetchers.portfolio(db, ownerId, false, options.warrantQuotes),
          needsOrders
            ? (options.displayHistory ? fetchers.history : fetchers.orders)(
              db,
              ownerId,
            )
            : [],
        ]);
        const livePositions = ownerPositions.map((p) => scalePosition(p, share));
        const sourceOrders = applyBucketAllocations(
          ownerOrders,
          readBucketAllocations(db, ownerId),
        ).map((o) => scaleOrder(o, share));
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
        // Buckets of one owner at different shares (e.g. one at 100%, another at
        // 50%) each scale a copy of the owner's history. Give later copies their
        // own account identity and keys so FIFO matching and bucket labels never
        // mix copies. Real integration IDs are positive.
        const integrationId = (id: number) =>
          copy === 0 ? id : -(copy * 1_000_000_000 + id);
        const orders = sourceOrders.map((order) => {
          const originalKey = getOrderTransactionKey(order);
          // Preserve each owner's FIFO history without cross-owner bucket collisions.
          const transactionKey = JSON.stringify(
            copy === 0 ? [ownerId, originalKey] : [ownerId, copy, originalKey],
          );
          const selected = names.has(assignments.get(originalKey) ?? null);
          if (!selected || bucketName !== null) {
            transactionBuckets.set(
              transactionKey,
              selected ? bucketName! : "__excluded",
            );
          }
          return {
            ...order,
            integrationId: integrationId(order.integrationId),
            transactionKey,
          };
        });
        let accountPerformances =
          options.accountPerformance && names.has(null) && fetchers.accounts
            ? await fetchers.accounts(db, ownerId, livePositions, sourceOrders, options.accountPerformanceOptions)
            : [];
        if (options.accountPerformance && names.has(null) && !wholeAccount && accountPerformances.length) {
          const excludedPositions = [...new Set(assignments.values())].filter(name => !names.has(name)).flatMap(name =>
            buildBucketedPortfolioPositions({ orders: sourceOrders, livePositions: mergePositions(livePositions), transactionBuckets: assignments, bucketName: name }));
          const excluded = await buildBucketCashAccounts({
            positions: excludedPositions, orders, transactionBuckets, bucketName: "__excluded",
          }, fetchers.request);
          accountPerformances = await excludeBucketCapital(accountPerformances, excluded, fetchers.request);
        }
        for (const account of accountPerformances) {
          const valuations = positions.filter((p) =>
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
            orders.filter((o) =>
              o.integrationId === account.integrationId
            )
              .map((o) =>
                adjustOrderForCorporateActions(
                  o,
                  new Date().toISOString().slice(0, 10),
                )
              ), transactionBuckets, bucketName,
          );
          account.reportedComponents.push(
            ...sold.map((s) => ({
              currency: s.currency,
              cost: s.cost,
              pnl: s.realizedPnl,
            })),
          );
        }
        const selectedPositions = positions.map((position) => ({
          ...position,
          integrationId: integrationId(position.integrationId),
        }));
        if (options.accountPerformance && !names.has(null)) {
          accountPerformances.push(...await buildBucketCashAccounts({
            positions: selectedPositions, orders, transactionBuckets, bucketName,
          }, fetchers.request));
        }
        return {
          positions: selectedPositions,
          orders,
          transactionBuckets,
          accountPerformances,
        };
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
