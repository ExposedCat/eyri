import type { ServiceResult } from "../../utils/service.ts";
import type { Database } from "./setup.ts";

export type PortfolioBucket = {
  userId: number;
  ownerUserId: number;
  name: string;
  included: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type PortfolioBucketRow = {
  user_id: number;
  owner_user_id: number;
  name: string;
  included: number;
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
    ownerUserId: row.owner_user_id,
    name: row.name,
    included: Boolean(row.included),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

const ACCESSIBLE_BUCKETS = `
  SELECT user_id, user_id AS owner_user_id, name, created_at, updated_at
  FROM portfolio_buckets WHERE user_id = ?
  UNION ALL
  SELECT a.user_id, a.owner_user_id, a.bucket_name AS name,
    a.created_at, b.updated_at
  FROM portfolio_bucket_access a JOIN portfolio_buckets b
    ON b.user_id = a.owner_user_id AND b.name = a.bucket_name
  WHERE a.user_id = ?
`;

export function getUserBuckets(database: Database, userId: number) {
  const rows = database
    .prepare(`
      SELECT b.*, EXISTS (
        SELECT 1 FROM portfolio_bucket_inclusions i
        WHERE i.user_id = b.user_id AND i.bucket_name = b.name
          AND i.owner_user_id = b.owner_user_id
      ) AS included FROM (${ACCESSIBLE_BUCKETS}) b ORDER BY name
    `)
    .all(userId, userId) as PortfolioBucketRow[];

  return rows.map(toPortfolioBucket);
}

export function getUserBucket(
  database: Database,
  userId: number,
  name: string,
) {
  return getUserBuckets(database, userId).find((bucket) =>
    bucket.name === name
  ) ??
    null;
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
    if (getUserBucket(database, userId, name)) {
      return { success: false, error: "Bucket already exists" };
    }
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

    database.transaction(() => {
      if (bucket.ownerUserId !== userId) {
        database.prepare(
          "DELETE FROM portfolio_bucket_access WHERE user_id = ? AND bucket_name = ?",
        ).run(userId, name);
        database.prepare(
          "DELETE FROM portfolio_bucket_inclusions WHERE user_id = ? AND bucket_name = ?",
        ).run(userId, name);
        return;
      }
      database.prepare(
        "DELETE FROM portfolio_bucket_access WHERE owner_user_id = ? AND bucket_name = ?",
      ).run(userId, name);
      database.prepare(
        "DELETE FROM portfolio_bucket_inclusions WHERE owner_user_id = ? AND bucket_name = ?",
      ).run(userId, name);
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
    })();

    return { success: true, data: null };
  } catch {
    return { success: false, error: "Failed to remove bucket" };
  }
}

export function transferBucketAccess({
  database,
  userId,
  name,
  recipientId,
}: CreateBucketArgs & { recipientId: number }): ServiceResult<PortfolioBucket> {
  const bucket = getUserBucket(database, userId, name);
  if (!bucket) return { success: false, error: "Bucket not found" };
  if (bucket.ownerUserId !== userId) {
    return {
      success: false,
      error: "Only the bucket owner can transfer access",
    };
  }
  if (!Number.isSafeInteger(recipientId) || recipientId <= 0) {
    return { success: false, error: "Use a valid Telegram user ID" };
  }
  if (getUserBucket(database, recipientId, name)) {
    return {
      success: false,
      error: "Recipient already has a bucket with this name",
    };
  }
  database.transaction(() => {
    // users.user_id is the Telegram user ID, including recipients new to Eyri.
    database.prepare("INSERT OR IGNORE INTO users (user_id) VALUES (?)")
      .run(recipientId);
    database.prepare(`
      INSERT INTO portfolio_bucket_access (user_id, bucket_name, owner_user_id)
      VALUES (?, ?, ?)
    `).run(recipientId, name, userId);
  })();
  return { success: true, data: getUserBucket(database, recipientId, name)! };
}

export function setBucketIncluded({
  database,
  userId,
  name,
  included,
}: CreateBucketArgs & { included: boolean }): ServiceResult<PortfolioBucket> {
  const bucket = getUserBucket(database, userId, name);
  if (!bucket) return { success: false, error: "Bucket not found" };
  if (included) {
    database.prepare(`
      INSERT OR REPLACE INTO portfolio_bucket_inclusions
        (user_id, bucket_name, owner_user_id) VALUES (?, ?, ?)
    `).run(userId, name, bucket.ownerUserId);
  } else {
    database.prepare(
      "DELETE FROM portfolio_bucket_inclusions WHERE user_id = ? AND bucket_name = ?",
    ).run(userId, name);
  }
  return { success: true, data: { ...bucket, included } };
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
    if (bucket.ownerUserId !== userId) {
      return {
        success: false,
        error: "Only the bucket owner can change its trades",
      };
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
    const bucket = getUserBucket(database, userId, bucketName);
    if (!bucket) return { success: false, error: "Bucket not found" };
    if (bucket.ownerUserId !== userId) {
      return {
        success: false,
        error: "Only the bucket owner can change its trades",
      };
    }
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
