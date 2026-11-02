// A stale build. Nothing imports it; it is here so the task has real cleanup.
export function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}
