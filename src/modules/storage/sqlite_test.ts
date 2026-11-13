import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { getDatabase, openDatabase } from "./sqlite.ts";

for (const operation of ["read", "write"]) {
  Deno.test(`${operation} waits for a lock held by another process`, async () => {
    const dir = Deno.makeTempDirSync();
    const path = `${dir}/test.sqlite`;
    const db = openDatabase(path);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
    // A separate process must release the lock: SQLite's busy wait blocks this
    // thread, so a same-thread timer could never release it.
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `
      import { openDatabase } from ${
          JSON.stringify(new URL("./sqlite.ts", import.meta.url).href)
        };
      const db = openDatabase(${JSON.stringify(path)});
      try {
        db.exec("BEGIN ${
          operation === "read" ? "EXCLUSIVE" : "IMMEDIATE"
        }; INSERT INTO items VALUES (1)");
        await Deno.stdout.write(new Uint8Array([1]));
        await Deno.stdin.read(new Uint8Array(1));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        db.exec("COMMIT");
      } finally { db.close(); }
    `,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    try {
      const ready = child.stdout.getReader();
      try {
        equal((await ready.read()).value?.[0], 1);
      } finally {
        ready.releaseLock();
      }
      const signal = child.stdin.getWriter();
      await signal.write(new Uint8Array([1]));
      await signal.close();
      if (operation === "write") db.exec("INSERT INTO items VALUES (2)");
      else {deepStrictEqual(db.prepare("SELECT id FROM items").all(), [{
          id: 1,
        }]);}
      const result = await child.output();
      equal(result.code, 0, new TextDecoder().decode(result.stderr));
      deepStrictEqual(
        db.prepare("SELECT id FROM items ORDER BY id").all(),
        operation === "write" ? [{ id: 1 }, { id: 2 }] : [{ id: 1 }],
      );
    } finally {
      // Also reap the child if an assertion or the contested write fails.
      try {
        child.kill();
      } catch { /* Already exited. */ }
      await child.status;
      db.close();
      Deno.removeSync(dir, { recursive: true });
    }
  });
}

Deno.test("database initialization retries failures and shares concurrent opens", async () => {
  const dir = await Deno.makeTempDir();
  const previous = Deno.env.get("EYRI_DATABASE_PATH");
  try {
    await Deno.writeTextFile(`${dir}/file`, "not a directory");
    Deno.env.set("EYRI_DATABASE_PATH", `${dir}/file/test.sqlite`);
    await rejects(getDatabase());
    Deno.env.set("EYRI_DATABASE_PATH", `${dir}/nested/test.sqlite`);
    const connections = await Promise.all(
      Array.from({ length: 16 }, () => getDatabase()),
    );
    try {
      for (const connection of connections) equal(connection, connections[0]);
      deepStrictEqual(connections[0].prepare("PRAGMA busy_timeout").get(), {
        timeout: 5000,
      });
    } finally {
      connections[0].close();
    }
  } finally {
    if (previous === undefined) Deno.env.delete("EYRI_DATABASE_PATH");
    else Deno.env.set("EYRI_DATABASE_PATH", previous);
    await Deno.remove(dir, { recursive: true });
  }
});
