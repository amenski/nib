import { total } from "./math.js";

export function average(list) {
  return list.length === 0 ? 0 : total(list) / list.length;
}

export function max(list) {
  return list.reduce((best, value) => (value > best ? value : best), -Infinity);
}
