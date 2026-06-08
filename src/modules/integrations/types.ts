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
  openedAt: Date | null;
};

export type IntegrationOrder = {
  integrationId: number;
  integrationKind: string;
  account: string;
  ticker: string;
  date: Date;
  quantity: number;
  price: number | null;
  currency: string;
  assetCategory: string | null;
};

export type IntegrationAdapter = {
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
