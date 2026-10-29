import { test } from "node:test";
import assert from "node:assert/strict";
import { tally } from "./task.js";

test("totals the list and adds the base", () => {
  assert.equal(tally([1, 2, 3]), 13);
});

test("handles an empty list", () => {
  assert.equal(tally([]), 7);
});
