import { equal, ok } from "node:assert/strict";
import { splitMessageLines } from "./message.ts";

Deno.test("long portfolio messages preserve HTML and bucket shortcuts across Telegram chunks", () => {
  const lines = Array.from(
    { length: 140 },
    (_, index) =>
      `<a href="https://example.com/stock">STOCK</a> 1.0000 x $100.00 /move_Core_${
        index + 1
      }`,
  );
  const text = lines.join("\n");
  const chunks = splitMessageLines(text);
  ok(chunks.length > 1);
  equal(chunks.join("\n"), text);
  ok(chunks.every((chunk) => chunk.length <= 3500));
  for (const line of lines) {
    ok(chunks.some((chunk) => chunk.split("\n").includes(line)));
  }
});
