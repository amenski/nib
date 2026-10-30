/** The tasks whose status is exactly `status`. */
export function byStatus(tasks, status) {
  return tasks.filter((task) => task.status === status);
}
