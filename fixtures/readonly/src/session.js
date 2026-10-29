// A small module to explain: two exported helpers and one private one.
const sessions = new Map();

/** Registers a session under its id, replacing any previous record. */
export function save(id, record) {
  sessions.set(id, { ...record, savedAt: Date.now() });
  return id;
}

/** Returns the stored record, or undefined when the id was never saved. */
export function load(id) {
  return sessions.get(id);
}

function expired(record, ttlMs) {
  return Date.now() - record.savedAt > ttlMs;
}

/** Drops the record once it is older than ttlMs; returns true when it did. */
export function prune(id, ttlMs) {
  const record = load(id);
  if (!record || !expired(record, ttlMs)) return false;
  sessions.delete(id);
  return true;
}
