import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { Bot } from "grammy";
import type { Update } from "grammy_types";
import { runBot, setupBotRuntime } from "./runtime.ts";
import type { CustomContext } from "./types.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function within(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Update was blocked")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function command(updateId: number, text: string, userId = 1): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: userId, type: "private", first_name: "User" },
      from: { id: userId, is_bot: false, first_name: "User" },
      text,
      entities: [
        {
          type: "bot_command",
          offset: 0,
          length: text.split(/\s/)[0].length,
        },
      ],
    },
  };
}

function harness(updates: Update[]) {
  const bot = new Bot<CustomContext>("123:test", {
    botInfo: {
      id: 123,
      is_bot: true,
      first_name: "Eyri",
      username: "eyri_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    },
  });
  let fetched = false;
  bot.api.config.use((_previous, method, _payload, signal) => {
    equal(method, "getUpdates");
    if (!fetched) {
      fetched = true;
      return Promise.resolve({ ok: true, result: updates }) as never;
    }
    return new Promise((resolve) => {
      const finish = () => resolve({ ok: true, result: [] });
      if (signal?.aborted) finish();
      else signal?.addEventListener("abort", finish, { once: true });
    }) as never;
  });
  setupBotRuntime(bot);
  return bot;
}

Deno.test("slow portfolio reports do not block same-chat commands in the runner", async () => {
  const release = deferred();
  const responsive = deferred();
  const completed = deferred();
  const started: string[] = [];
  let remaining = 5;
  const bot = harness([
    command(1, "/portfolio"),
    command(2, "/options"),
    command(3, "/chart"),
    command(4, "/number"),
    command(5, "/allnumber"),
    command(6, "/start"),
  ]);
  bot.command(
    ["portfolio", "options", "chart", "number", "allnumber"],
    async (ctx) => {
      ok(ctx.message?.text);
      started.push(ctx.message.text);
      await release.promise;
      if (--remaining === 0) completed.resolve();
    },
  );
  bot.command("start", () => responsive.resolve());
  const runner = runBot(bot);
  try {
    await within(responsive.promise);
    deepStrictEqual(started, [
      "/portfolio",
      "/options",
      "/chart",
      "/number",
      "/allnumber",
    ]);
  } finally {
    release.resolve();
    await within(completed.promise);
    await runner.stop();
  }
});

Deno.test("state changes stay ordered per user while other users and reports proceed", async () => {
  const release = deferred();
  const responsive = deferred();
  const completed = deferred();
  const mutations: number[] = [];
  const bot = harness([
    command(1, "/cancel"),
    command(2, "/t212"),
    command(3, "/cancel", 2),
    command(4, "/start"),
  ]);
  let fastUpdates = 0;
  bot.command(["cancel", "t212"], async (ctx) => {
    mutations.push(ctx.update.update_id);
    if (ctx.update.update_id === 1) await release.promise;
    else if (ctx.update.update_id === 2) completed.resolve();
    else if (++fastUpdates === 2) responsive.resolve();
  });
  bot.command("start", () => {
    if (++fastUpdates === 2) responsive.resolve();
  });
  const runner = runBot(bot);
  try {
    await within(responsive.promise);
    deepStrictEqual(mutations, [1, 3]);
  } finally {
    release.resolve();
    await within(completed.promise);
    await runner.stop();
  }
  deepStrictEqual(mutations, [1, 3, 2]);
});

Deno.test("a failed handler is logged without stopping subsequent updates", async () => {
  const responsive = deferred();
  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  const bot = harness([command(1, "/portfolio"), command(2, "/start")]);
  bot.command("portfolio", () => {
    throw new Error("Broker unavailable");
  });
  bot.command("start", () => responsive.resolve());
  const runner = runBot(bot);
  try {
    await within(responsive.promise);
    await runner.stop();
    equal(logged.length, 1);
    equal(logged[0][1], "Broker unavailable");
  } finally {
    console.error = originalError;
    await runner.stop();
  }
});

Deno.test("fatal polling errors reject the runner task", async () => {
  const bot = harness([]);
  bot.api.config.use(() => {
    throw { error_code: 409, description: "Another poller is running" };
  });
  const originalError = console.error;
  console.error = () => {};
  const runner = runBot(bot);
  try {
    const task = runner.task();
    ok(task);
    await rejects(
      task,
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "error_code" in error &&
        error.error_code === 409,
    );
  } finally {
    console.error = originalError;
  }
});
