/** Adds every value in `list`. */
export function total(list) {
  let sum = 0;
  for (const value of list) sum += value;
  return sum;
}
