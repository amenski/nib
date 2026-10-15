// Deliberately buggy: the loop stops one short, so the last value is dropped.
export function sum(values) {
  let total = 0;
  for (let i = 0; i < values.length - 1; i++) total += values[i];
  return total;
}
