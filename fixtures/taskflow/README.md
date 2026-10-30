# taskflow — G8: add a cross-file feature

A tiny task-list CLI. Tasks live in `data/tasks.json`; `src/store.js` loads
them, `src/filter.js` selects them, `src/index.js` prints them.

Today it only supports `--status <status>`, defaulting to `open`.

**Run:** `node src/index.js`

Every task has `id`, `title`, `status`. Some also have `due` (an ISO date,
`YYYY-MM-DD`); the older ones do not.
