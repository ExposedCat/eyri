import type { ServiceResult } from "../../utils/service.ts";
import type { Database } from "./setup.ts";

export type PortfolioBucket = {
  userId: number;
  ownerUserId: number;
  name: string;
  // Fraction of the owner's bucket shown to this user: 1 for owned buckets and
  // full grants, e.g. 0.5 for a 50% grant.
  share: number;
  included: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type PortfolioBucketRow = {
  user_id: number;
  owner_user_id: number;
  name: string;
  share: number;
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
    share: row.share,
    included: Boolean(row.included),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

const ACCESSIBLE_BUCKETS = `
  SELECT user_id, user_id AS owner_user_id, name, 1 AS share, created_at,
    updated_at
  FROM portfolio_buckets WHERE user_id = ?
  UNION ALL
  SELECT a.user_id, a.owner_user_id, a.bucket_name AS name, a.share,
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
      database.prepare(
        "DELETE FROM portfolio_bucket_allocations WHERE user_id = ? AND bucket_name = ?",
      ).run(userId, name);

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

// One owner's orders feed a view once per share, and FIFO lots are keyed by
// integration, so a view cannot mix different shares of the same owner.
function findShareConflict(
  database: Database,
  userId: number,
  bucket: Pick<PortfolioBucket, "name" | "ownerUserId" | "share">,
) {
  return getUserBuckets(database, userId).find((other) =>
    other.included && other.name !== bucket.name &&
    other.ownerUserId === bucket.ownerUserId && other.share !== bucket.share
  ) ?? null;
}

export function formatBucketShare(share: number) {
  return `${Number((share * 100).toFixed(4))}%`;
}

// Total share of an owner's bucket granted to other users.
export function getTransferredBucketShare(
  database: Database,
  ownerUserId: number,
  name: string,
) {
  const row = database.prepare(`
    SELECT COALESCE(SUM(share), 0) AS share FROM portfolio_bucket_access
    WHERE owner_user_id = ? AND bucket_name = ?
  `).get(ownerUserId, name) as { share: number };
  return row.share;
}

export function transferBucketAccess({
  database,
  userId,
  name,
  recipientId,
  share = 1,
}: CreateBucketArgs & {
  recipientId: number;
  share?: number;
}): ServiceResult<PortfolioBucket> {
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
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    return { success: false, error: "Use a share above 0% and up to 100%" };
  }
  const existing = getUserBucket(database, recipientId, name);
  if (existing && (existing.ownerUserId !== userId || existing.share === share)) {
    return {
      success: false,
      error: "Recipient already has a bucket with this name",
    };
  }
  // Grants split the bucket: together they may cover at most 100% of it.
  // A re-grant replaces the recipient's current share.
  const granted = getTransferredBucketShare(database, userId, name) -
    (existing?.share ?? 0);
  if (granted + share > 1 + 1e-9) {
    return {
      success: false,
      error: `Only ${formatBucketShare(Math.max(0, 1 - granted))} of ${name} is left to transfer`,
    };
  }
  if (existing) {
    // Granting the same bucket with another share changes the recipient's share.
    const conflict = existing.included &&
      findShareConflict(database, recipientId, { ...existing, share });
    if (conflict) {
      return {
        success: false,
        error:
          `Recipient includes ${conflict.name} from you at ${formatBucketShare(conflict.share)}; included buckets from one owner must use the same share`,
      };
    }
    database.prepare(`
      UPDATE portfolio_bucket_access SET share = ?
      WHERE user_id = ? AND bucket_name = ? AND owner_user_id = ?
    `).run(share, recipientId, name, userId);
    return { success: true, data: getUserBucket(database, recipientId, name)! };
  }
  database.transaction(() => {
    // users.user_id is the Telegram user ID, including recipients new to Eyri.
    database.prepare("INSERT OR IGNORE INTO users (user_id) VALUES (?)")
      .run(recipientId);
    database.prepare(`
      INSERT INTO portfolio_bucket_access
        (user_id, bucket_name, owner_user_id, share)
      VALUES (?, ?, ?, ?)
    `).run(recipientId, name, userId, share);
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
  const conflict = included && findShareConflict(database, userId, bucket);
  if (conflict) {
    return {
      success: false,
      error:
        `${conflict.name} from the same owner is already included at ${formatBucketShare(conflict.share)}; exclude it first or ask the owner for the same share`,
    };
  }
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

// Partial moves keep a quantity of one purchase in a bucket. Reports split the
// purchase and give each part this key, distinct from any broker key.
export function partialTransactionKey(transactionKey: string, bucketName: string) {
  return JSON.stringify(["partial", transactionKey, bucketName]);
}

function parsePartialTransactionKey(key: string) {
  if (!key.startsWith('["partial",')) return null;
  const [, transactionKey, bucketName] = JSON.parse(key) as string[];
  return { transactionKey, bucketName };
}

export type BucketAllocations = Map<
  string,
  { bucketName: string; quantity: number }[]
>;

export function readBucketAllocations(
  database: Database,
  userId: number,
): BucketAllocations {
  const rows = database.prepare(`
    SELECT transaction_key, bucket_name, quantity
    FROM portfolio_bucket_allocations WHERE user_id = ?
    ORDER BY transaction_key, bucket_name
  `).all(userId) as (BucketTransactionRow & { quantity: number })[];
  const allocations: BucketAllocations = new Map();
  for (const row of rows) {
    allocations.set(row.transaction_key, [
      ...(allocations.get(row.transaction_key) ?? []),
      { bucketName: row.bucket_name, quantity: row.quantity },
    ]);
  }
  return allocations;
}

export function readBucketAssignments(database: Database, userId: number) {
  const rows = database
    .prepare(`
      SELECT transaction_key, bucket_name
      FROM portfolio_bucket_transactions
      WHERE user_id = ?
    `)
    .all(userId) as BucketTransactionRow[];

  const assignments = new Map(
    rows.map((row) => [row.transaction_key, row.bucket_name]),
  );
  for (const [transactionKey, parts] of readBucketAllocations(database, userId)) {
    for (const { bucketName } of parts) {
      assignments.set(partialTransactionKey(transactionKey, bucketName), bucketName);
    }
  }
  return assignments;
}

function addBucketAllocation(
  database: Database,
  userId: number,
  transactionKey: string,
  bucketName: string,
  quantity: number,
) {
  database.prepare(`
    INSERT INTO portfolio_bucket_allocations
      (user_id, transaction_key, bucket_name, quantity)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, transaction_key, bucket_name) DO UPDATE SET
      quantity = quantity + excluded.quantity,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, transactionKey, bucketName, quantity);
}

function ownedBucketError(database: Database, userId: number, bucketName: string) {
  const bucket = getUserBucket(database, userId, bucketName);
  if (!bucket) return "Bucket not found";
  return bucket.ownerUserId === userId
    ? null
    : "Only the bucket owner can change its trades";
}

// Moves quantities of open portfolio purchases into a bucket.
export function allocateToBucket({
  database,
  userId,
  bucketName,
  parts,
}: {
  database: Database;
  userId: number;
  bucketName: string;
  parts: { transactionKey: string; quantity: number }[];
}): ServiceResult<null> {
  const error = ownedBucketError(database, userId, bucketName);
  if (error) return { success: false, error };
  try {
    database.transaction(() => {
      for (const part of parts) {
        addBucketAllocation(
          database,
          userId,
          part.transactionKey,
          bucketName,
          part.quantity,
        );
      }
    })();
    return { success: true, data: null };
  } catch {
    return { success: false, error: "Failed to move stocks" };
  }
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

    const partial = parsePartialTransactionKey(transactionKey);
    if (partial) {
      // Move a partial part to another bucket, merging with any part there.
      if (partial.bucketName === bucketName) return { success: true, data: null };
      const row = database.prepare(`
        SELECT quantity FROM portfolio_bucket_allocations
        WHERE user_id = ? AND transaction_key = ? AND bucket_name = ?
      `).get(userId, partial.transactionKey, partial.bucketName) as
        | { quantity: number }
        | undefined;
      if (!row) return { success: false, error: "Transaction not found" };
      database.transaction(() => {
        database.prepare(`
          DELETE FROM portfolio_bucket_allocations
          WHERE user_id = ? AND transaction_key = ? AND bucket_name = ?
        `).run(userId, partial.transactionKey, partial.bucketName);
        addBucketAllocation(
          database,
          userId,
          partial.transactionKey,
          bucketName,
          row.quantity,
        );
      })();
      return { success: true, data: null };
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
    const partial = parsePartialTransactionKey(transactionKey);
    if (partial) {
      // Returning a partial part puts its quantity back in the portfolio.
      if (partial.bucketName === bucketName) {
        database.prepare(`
          DELETE FROM portfolio_bucket_allocations
          WHERE user_id = ? AND transaction_key = ? AND bucket_name = ?
        `).run(userId, partial.transactionKey, bucketName);
      }
      return { success: true, data: null };
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
