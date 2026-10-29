import { scale } from "./big.js";
import { sum } from "./sum.js";

// Bug: the tally base is dropped, so every total is short by BASE.
export function tally(values) {
  return scale(sum(values), 1);
}
