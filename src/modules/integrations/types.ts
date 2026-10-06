import type { Database } from "../database/setup.ts";
import type { Integration } from "../database/integration.ts";

export type IntegrationPortfolioPosition = {
  integrationId: number;
  integrationKind: string;
  account: string;
  ticker: string;
  amount: number;
  averageUnitPrice: number | null;
  currentPrice: number | null;
  currency: string;
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
};

export type IntegrationOrder = {
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
};

export type IntegrationAdapter = {
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

export type IntegrationCashTransaction = {
  integrationId: number;
  reference: string;
  date: Date;
  amount: number;
  currency: string;
  type: string;
};
