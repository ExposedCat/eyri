import { equal, ok } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { ensureSchema } from "./setup.ts";
import {
  createBucket,
  deleteBucket,
  getUserBucket,
  getUserBuckets,
  moveTransactionToBucket,
  readBucketAssignments,
  removeTransactionFromBucket,
  setBucketIncluded,
  transferBucketAccess,
} from "./bucket.ts";

Deno.test("bucket grants use Telegram IDs, reject name collisions and remain read-only", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (123456789), (987654321)");
    const owner = 123456789, recipient = 987654321;
    ok(
      (await createBucket({ database: db, userId: owner, name: "Core" }))
        .success,
    );
    ok(
      (await createBucket({ database: db, userId: recipient, name: "Core" }))
        .success,
    );
    equal(
      transferBucketAccess({
        database: db,
        userId: owner,
        name: "Core",
        recipientId: recipient,
      }).success,
      false,
    );
    await deleteBucket({ database: db, userId: recipient, name: "Core" });
    ok(
      transferBucketAccess({
        database: db,
        userId: owner,
        name: "Core",
        recipientId: recipient,
      }).success,
    );
    equal(getUserBucket(db, recipient, "Core")?.ownerUserId, owner);
    equal(getUserBucket(db, recipient, "Core")?.included, false);
    equal(
      transferBucketAccess({
        database: db,
        userId: owner,
        name: "Core",
        recipientId: recipient,
      }).success,
      false,
    );
    equal(
      (await createBucket({ database: db, userId: recipient, name: "Core" }))
        .success,
      false,
    );
    equal(
      transferBucketAccess({
        database: db,
        userId: recipient,
        name: "Core",
        recipientId: 3,
      }).success,
      false,
    );
    equal(
      (await moveTransactionToBucket({
        database: db,
        userId: recipient,
        bucketName: "Core",
        transactionKey: "trade",
      })).success,
      false,
    );
    equal(
      (await removeTransactionFromBucket({
        database: db,
        userId: recipient,
        bucketName: "Core",
        transactionKey: "trade",
      })).success,
      false,
    );
    ok(
      (await moveTransactionToBucket({
        database: db,
        userId: owner,
        bucketName: "Core",
        transactionKey: "trade",
      })).success,
    );
    ok(
      setBucketIncluded({
        database: db,
        userId: recipient,
        name: "Core",
        included: true,
      }).success,
    );
    ok(
      setBucketIncluded({
        database: db,
        userId: recipient,
        name: "Core",
        included: true,
      }).success,
    );
    equal(getUserBucket(db, owner, "Core")?.included, false);
    equal(getUserBuckets(db, recipient).length, 1);
    await deleteBucket({ database: db, userId: recipient, name: "Core" });
    equal(getUserBucket(db, recipient, "Core"), null);
    equal(readBucketAssignments(db, owner).get("trade"), "Core");
    ok(getUserBucket(db, owner, "Core"));
    // A grant can precede the recipient's first /start.
    ok(
      transferBucketAccess({
        database: db,
        userId: owner,
        name: "Core",
        recipientId: 1122334455,
      }).success,
    );
    ok(db.prepare("SELECT user_id FROM users WHERE user_id=?").get(1122334455));
    setBucketIncluded({
      database: db,
      userId: 1122334455,
      name: "Core",
      included: true,
    });
    await deleteBucket({ database: db, userId: owner, name: "Core" });
    equal(getUserBucket(db, 1122334455, "Core"), null);
    equal(
      db.prepare("SELECT COUNT(*) AS n FROM portfolio_bucket_inclusions").get()
        ?.n,
      0,
    );
    await createBucket({ database: db, userId: owner, name: "Core" });
    equal(getUserBucket(db, 1122334455, "Core"), null);
  } finally {
    db.close();
  }
});
