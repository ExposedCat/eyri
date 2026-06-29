import type { ServiceResult } from "../../utils/service.ts";
import type { Database } from "./setup.ts";

export type PortfolioBucket = {
  userId: number;
  name: string;
  createdAt: Date;
  updatedAt: Date;
};

type PortfolioBucketRow = {
  user_id: number;
  name: string;
  created_at: string;
  updated_at: string;
};

type BucketTransactionRow = {
  transaction_key: string;
  bucket_name: string;
};

function toPortfolioBucket(row: PortfolioBucketRow): PortfolioBucket {
  return {
    userId: row.user_id,
    name: row.name,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function getUserBuckets(database: Database, userId: number) {
  const rows = database
    .prepare(`
      SELECT user_id, name, created_at, updated_at
      FROM portfolio_buckets
      WHERE user_id = ?
      ORDER BY name
    `)
    .all(userId) as PortfolioBucketRow[];

  return rows.map(toPortfolioBucket);
}

export function getUserBucket(
  database: Database,
  userId: number,
  name: string,
) {
  const row = database
    .prepare(`
      SELECT user_id, name, created_at, updated_at
      FROM portfolio_buckets
      WHERE user_id = ? AND name = ?
    `)
    .get(userId, name) as PortfolioBucketRow | undefined;

  return row ? toPortfolioBucket(row) : null;
}

type CreateBucketArgs = {
  database: Database;
  userId: number;
  name: string;
};

export async function createBucket({
  database,
  userId,
  name,
}: CreateBucketArgs): Promise<ServiceResult<PortfolioBucket>> {
  try {
    database
      .prepare(`
        INSERT INTO portfolio_buckets (user_id, name)
        VALUES (?, ?)
      `)
      .run(userId, name);

    const bucket = getUserBucket(database, userId, name);
    if (!bucket) {
      return { success: false, error: "Failed to create bucket" };
    }

    return { success: true, data: bucket };
  } catch {
    return { success: false, error: "Bucket already exists" };
  }
}

type DeleteBucketArgs = {
  database: Database;
  userId: number;
  name: string;
};

export async function deleteBucket({
  database,
  userId,
  name,
}: DeleteBucketArgs): Promise<ServiceResult<null>> {
  try {
    const bucket = getUserBucket(database, userId, name);
    if (!bucket) {
      return { success: false, error: "Bucket not found" };
    }

    database
      .prepare(`
        DELETE FROM portfolio_bucket_transactions
        WHERE user_id = ? AND bucket_name = ?
      `)
      .run(userId, name);

    database
      .prepare(`
        DELETE FROM portfolio_buckets
        WHERE user_id = ? AND name = ?
      `)
      .run(userId, name);

    return { success: true, data: null };
  } catch {
    return { success: false, error: "Failed to remove bucket" };
  }
}

export function readBucketAssignments(database: Database, userId: number) {
  const rows = database
    .prepare(`
      SELECT transaction_key, bucket_name
      FROM portfolio_bucket_transactions
      WHERE user_id = ?
    `)
    .all(userId) as BucketTransactionRow[];

  return new Map(rows.map((row) => [row.transaction_key, row.bucket_name]));
}

type MoveTransactionToBucketArgs = {
  database: Database;
  userId: number;
  bucketName: string;
  transactionKey: string;
};

export async function moveTransactionToBucket({
  database,
  userId,
  bucketName,
  transactionKey,
}: MoveTransactionToBucketArgs): Promise<ServiceResult<null>> {
  try {
    const bucket = getUserBucket(database, userId, bucketName);
    if (!bucket) {
      return { success: false, error: "Bucket not found" };
    }

    database
      .prepare(`
        INSERT INTO portfolio_bucket_transactions (
          user_id,
          transaction_key,
          bucket_name
        )
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, transaction_key) DO UPDATE SET
          bucket_name = excluded.bucket_name,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(userId, transactionKey, bucketName);

    return { success: true, data: null };
  } catch {
    return { success: false, error: "Failed to move transaction" };
  }
}

type RemoveTransactionFromBucketArgs = {
  database: Database;
  userId: number;
  bucketName: string;
  transactionKey: string;
};

export async function removeTransactionFromBucket({
  database,
  userId,
  bucketName,
  transactionKey,
}: RemoveTransactionFromBucketArgs): Promise<ServiceResult<null>> {
  try {
    database
      .prepare(`
        DELETE FROM portfolio_bucket_transactions
        WHERE user_id = ? AND transaction_key = ? AND bucket_name = ?
      `)
      .run(userId, transactionKey, bucketName);

    return { success: true, data: null };
  } catch {
    return { success: false, error: "Failed to remove transaction" };
  }
}
