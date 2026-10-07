import { equal, rejects } from "node:assert/strict";
import { makeTradernetApiRequest } from "./api.ts";

Deno.test("Tradernet paginated requests match SDK recursive signing and nested form encoding", async () => {
  const original = globalThis.fetch, now = Date.now;
  Date.now = () => 1700000000000;
  globalThis.fetch = (input, init) => {
    equal(String(input), "https://tradernet.com/api/v2/cmd/getOrdersHistory");
    const body = new URLSearchParams(String(init?.body));
    equal(body.get("params[page][skip]"), "1000");
    equal(body.get("params[page][take]"), "1000");
    equal(body.get("params[order]"), null);
    equal(body.get("params[page]"), null);
    // Reference vector from the SDK's StringUtils.str_from_dict + HMAC-SHA256.
    equal(
      new Headers(init?.headers).get("X-NtApi-Sig"),
      "a5f7df90cb587e384620829b3e506f732c05b8c7bb998f7045a0b63e08b5a20c",
    );
    return Promise.resolve(Response.json({ orders: { order: [] } }));
  };
  try {
    await makeTradernetApiRequest("test", "test", "getOrdersHistory", {
      till: "2024-04-01T00:00:00Z",
      page: { take: 1000, skip: 1000 },
      from: "2024-01-01T00:00:00Z",
    });
  } finally {
    globalThis.fetch = original;
    Date.now = now;
  }
});

Deno.test("Tradernet HTTP 200 API errors cannot masquerade as an empty history", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(Response.json({ errMsg: "Bad signature", code: 4 }));
  try {
    await rejects(
      makeTradernetApiRequest("test", "test", "getOrdersHistory"),
      /Bad signature/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
