import type { Database } from "../database/setup.ts";
import type { Integration } from "../database/integration.ts";

// Every monetary field uses the instrument's currency. Preserve native prices
// and costs through calculations; USD conversion belongs to reporting.
export type IntegrationPortfolioPosition = {
  integrationId: number;
  integrationKind: string;
  account: string;
  ticker: string;
  assetCategory?: string | null;
  amount: number;
  averageUnitPrice: number | null;
  currentPrice: number | null;
  currentPriceSource?: string;
  currentPriceAsOf?: string;
  currency: string;
  // Account-currency valuations supplied by the broker, including historical FX.
  // Keep components separate when merging accounts with different currencies.
  brokerValuations?: {
    currency: string;
    totalInput: number | null;
    totalNow: number | null;
    unrealizedPnl: number | null;
  }[];
  totalInput: number | null;
  totalNow: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  dailyPnl: number | null;
  dailyPnlPercentage: number | null;
  dailyPnlBaseline: number | null;
  // Some brokers use current value for the portfolio-level daily percentage.
  dailyPnlTotalBaseline?: number | null;
  openedAt: Date | null;
  yahooSymbol?: string;
  isin?: string;
  historicalPriceMultiplier?: number;
};

export type IntegrationOrder = {
  executionId?: string;
  walletImpact?: {
    currency: string;
    netValue: number;
    fxRate: number;
    realisedProfitLoss?: number;
    taxes: { name: string; quantity: number; currency: string }[];
  };
  // Synthesized history entries keep their bucket identity across refreshes.
  transactionKey?: string;
  integrationId: number;
  integrationKind: string;
  account: string;
  ticker: string;
  date: Date;
  quantity: number;
  price: number | null;
  currency: string;
  assetCategory: string | null;
  yahooSymbol?: string;
  isin?: string;
  historicalPriceMultiplier?: number;
};

export type IntegrationAdapter = {
  fetchAccountPerformance?: (
    database: Database,
    integration: Integration,
    positions: IntegrationPortfolioPosition[],
    orders: IntegrationOrder[],
  ) => Promise<IntegrationAccountPerformance>;
  fetchCashHistory?: (
    database: Database,
    integration: Integration,
  ) => Promise<IntegrationCashTransaction[]>;
  fetchPortfolio: (
    database: Database,
    integration: Integration,
  ) => Promise<IntegrationPortfolioPosition[]>;
  fetchOrderHistory: (
    database: Database,
    integration: Integration,
  ) => Promise<IntegrationOrder[]>;
  probe?: (integration: Integration) => Promise<void>;
};

export type IntegrationAccountPerformance = {
  integrationId: number;
  currency: string;
  totalValue: number;
  netContributions: number;
  pnl: number;
  deposits: number;
  withdrawals: number;
  cash: number;
  ledgerCash: Record<string, number>;
  openedAt: Date;
  historyThrough: Date;
  positionValue: number;
  investmentValue: number;
  // The matching snapshot, kept in each component's currency until reporting.
  reportedComponents?: { currency: string; cost: number; pnl: number }[];
};

export type IntegrationCashTransaction = {
  integrationId: number;
  reference: string;
  date: Date;
  amount: number;
  currency: string;
  type: string;
};
