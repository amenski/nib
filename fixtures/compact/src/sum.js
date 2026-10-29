/** Adds every value in `list`. */
export function sum(list) {
  let total = 0;
  for (const value of list) total += value;
  return total;
}
