import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "./sum.js";

test("sums every value", () => {
  assert.equal(sum([1, 2, 3]), 6);
});

test("sums an empty list", () => {
  assert.equal(sum([]), 0);
});

test("sums negative values", () => {
  assert.equal(sum([-1, -2]), -3);
});
