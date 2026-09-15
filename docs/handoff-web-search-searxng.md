# Handoff: `web_search` v2 — SearXNG backend + inline content enrichment

Status: **Phase 1 shipped 2026-08-11, Phase 2 shipped 2026-08-14.** See the
phase sections for implementation notes.
Owner approved the two anti-drift reversals below in the 2026-08-11 design
conversation (search quality via keyless Bing RSS was flagged as the hard
blocker; SearXNG chosen over paid APIs and over building an index).

## Problem

`web_search` (Bing `format=rss`, see web-search-spec.md Tier 3) returns ~10
thin, geo-drifting, snippet-only results. The model must then call
`web_fetch` per link, serially. Result quality is the user's top complaint.

## Decision

Two changes, shipped as two independent phases (phase 1 is useful alone):

1. **SearXNG backend (opt-in, user-hosted).** When the user configures a
   SearXNG instance URL, `web_search` queries its JSON API instead of Bing
   RSS. Bing RSS remains the keyless default and the automatic fallback when
   SearXNG is unreachable. Nib still ships no scraper, no key, no
   backend — the user runs SearXNG themselves (Docker, one container).
2. **Inline content enrichment.** After a successful search (either backend),
   fetch the top N result pages concurrently, extract readable text via the
   existing `web_fetch` pipeline, and include a bounded excerpt per result in
   the tool output. This collapses search→fetch→fetch round trips into one
   tool call — the main quality lever (it's what makes Anthropic's server-side
   `web_search` tool feel good).

### Anti-drift amendments (edit web-search-spec.md + security-spec.md FIRST)

These are deliberate, approved reversals in the established style — record
them in web-search-spec.md as dated status notes and update the rules section:

- **Rule 2 (pinned hosts):** carve-out — the user-configured SearXNG base URL
  (from settings.json, same trust boundary as `mcpServers`) is an approved
  search host. It is user-authored config, not a shipped endpoint. Add the
  same note to security-spec.md's host list.
- **Rule 4 (never fetch result bodies):** carve-out for enrichment only —
  result URLs returned by the search backend may be fetched through the
  **same SSRF guard and pipeline as `web_fetch`** (https-only, per-hop DNS
  checks, body caps). Arbitrary model-supplied URLs still go through
  `web_fetch` only.
- Rules 1 (no new deps), 5 (no API keys), 7 (no LLM query prep), 8
  (guarded-tier permission, headless-deny) are **unchanged and binding**.
- Rule 3 note: SearXNG is not a SERP scrape by Nib — it is a JSON API of
  a service the user operates. No change to "no HTML scraping in core."

## Phase 1 — SearXNG backend

### Config

`settings.json` (strict loader — add the field to the known-keys validation
in `src/config/loader.ts`, and document in docs/config-spec.md):

```json
{ "webSearch": { "searxngUrl": "http://localhost:8888" } }
```

- Absent (default): Bing RSS, exactly today's behavior. Zero-setup story intact.
- Present: SearXNG is primary; Bing RSS is the fallback on *transient* failure
  (network error, 5xx, timeout) — surfaced in the output as a one-line status
  (`web_search: SearXNG unreachable, fell back to Bing.`) so failures are
  visible, per the spec's "tool failure must not read as empty web" principle.
- `http://` is allowed **only** for localhost/127.0.0.1/[::1]; any other host
  must be https. Validate at config load, warn + ignore the key otherwise.

### Backend client

New file `src/tools/web-search-searxng.ts` (keep `web-search.ts` as the tool;
don't create a directory or an abstraction layer beyond one function):

- `GET {searxngUrl}/search?q=<query>&format=json` with the existing
  `USER_AGENT`, `TIMEOUT_MS` (10s), and body cap (512 KB) conventions from
  `web-search.ts`. `AbortSignal.any([ctx.signal, timeout])` like `fetchRss`.
- Parse JSON: `results[]` → `{ title, url, content }` maps onto the existing
  `WebResult { title, url, snippet }`. Drop items without title or url.
  Unrecognized JSON shape → same "tool failure, not an empty result" message
  pattern as `looksLikeRssFeed`.
- Note: many SearXNG instances return 403 for `format=json` unless the
  instance config enables the json format — treat 403 from SearXNG as a
  *permanent* config problem: no retry, no Bing fallback suppression; return
  actionable text telling the user to add `json` to their instance's
  `search.formats`.

### Wiring in `web-search.ts`

- Backend selection at handler entry: config present → try SearXNG →
  fallback path above. All existing behavior is backend-agnostic and stays:
  domain filtering (client-side, on parsed results), 60s cache (extend the
  cache key with the backend that produced the results), `limit` clamp 1–8,
  untrusted-content wrapper, 8k output cap (until phase 2), guarded-tier
  permission (unchanged).
- Retry policy: keep the existing `fetchRssWithRetry` semantics for Bing.
  For SearXNG: retry 5xx/network twice (reuse `TransientError` + delays),
  no retry on 403/429/abort — then fall back to Bing.

### Tests (`web-search.test.ts` + new fixture)

- SearXNG JSON fixture parses into `WebResult[]`; malformed JSON → failure
  message, not "No results found."
- Config absent → Bing path untouched (existing tests keep passing unmodified).
- SearXNG network error → Bing fallback + status line present.
- SearXNG 403 → actionable format=json message, no Bing suppression of it.
- Cache key includes backend; domain filters still apply to SearXNG results.

## Phase 2 — inline content enrichment

> **Shipped 2026-08-14.** Implementation notes:
> - `webSearch.enrich` (boolean, default **true**) parsed in
>   `src/config/loader.ts`; `enrichCount` fixed at 3 (not configurable).
>   `webSearch.enrich: false` restores snippet-only output + the 8 000-char cap.
> - `fetchAndProcess`/`htmlToText` exported from `src/tools/web-fetch.ts`
>   (export keyword only, no behavior change). Per result, web-search.ts calls
>   `fetchAndProcess` and applies `sanitizeControlChars` afterwards, exactly as
>   `webFetchHandler` does; the 3 fetches run concurrently via
>   `Promise.allSettled`, and a failing fetch (SSRF-blocked, non-HTML,
>   timeout, HTTP error) degrades that result to snippet-only silently.
> - The 60s result cache stores the **enriched** results (extracted text
>   attached to the top 3), so repeat queries don't re-fetch pages; the cache
>   key now includes the enrich mode so a config flip doesn't serve
>   stale-mode entries. Nothing is written into web_fetch's module cache —
>   the modules stay decoupled.
> - Output cap: 20 000 chars when any content block is present, 8 000 for
>   snippet-only output (same `… (truncated)` overflow marker); per-result
>   content cap 2 000 chars with a `…` marker. Enriched output stays inside
>   the existing single untrusted-content wrapper pair.
> - Permission subject and guarded-tier behavior unchanged — enrichment
>   happens after the (already-approved) search, reusing web_fetch's own SSRF
>   guards per result.

### Behavior

- After search (both backends), take the top **3** results post-domain-filter,
  fetch each concurrently (`Promise.allSettled`), extract text, and emit:

```
- [web] Title — https://url/
  <snippet>
  ---
  <extracted content, ≤2 000 chars, ends with … if truncated>
```

- A result whose fetch fails (SSRF-blocked, non-HTML, timeout, HTTP error)
  degrades to snippet-only silently — enrichment is best-effort, never a
  reason to fail the search.
- Total output cap rises from 8 000 to **20 000 chars** for enriched output
  (snippet-only output keeps the 8 000 cap). Everything stays inside the
  existing untrusted-content wrapper. Update the spec's Output format section.

### Reuse, don't duplicate

- Export `htmlToText` and `fetchAndProcess` from `src/tools/web-fetch.ts`
  (add `export`, no behavior change) and call `fetchAndProcess` per result —
  it already does https-only, per-hop SSRF checks, redirects, content-type
  dispatch, body caps, and `sanitizeControlChars` is applied afterwards as in
  `webFetchHandler`. Per-result timeout: reuse its 15s; overall the 3 fetches
  run concurrently so worst case adds ~15s to a search call.
- Write fetched text into `web_fetch`'s module cache is NOT required — skip
  cross-tool cache sharing (keep the modules decoupled); the `web_search` 60s
  result cache should store the *enriched* formatted results so repeat
  queries don't re-fetch.

### Config

`webSearch.enrich: boolean`, default **true**. `webSearch.enrichCount`:
not configurable — fixed at 3 (simplicity; revisit on demand).

### Tests

- Fetch failure of one result → that result degrades to snippet, others
  enriched.
- Per-result 2k cap and 20k total cap enforced; truncation marker present.
- SSRF-blocked URL (use `web-fetch-guard` blocked address) degrades silently.
- Enriched output remains inside one wrapper pair (no nested wrappers).

## Out of scope (explicitly)

- Provider-billed server-side search (Anthropic `web_search_*` tool types via
  AI SDK) — separate future task; different seam (request build, not tool
  handler).
- Local docs index (FTS5) — separate future task.
- Paid search APIs, DDG, any new scraping — still rejected per spec.
- LLM reranking / query rewriting (anti-drift rule 7).

## Verification (definition of done, per phase)

1. `npm test` green; `npx tsc --noEmit` clean.
2. Live smoke: with a local SearXNG running, one real query returns SearXNG
   results (check the `[web]` lines cite non-Bing ranking); stop SearXNG,
   same query falls back to Bing with the status line.
3. Phase 2 smoke: a query like "node AbortSignal.any docs" returns enriched
   content blocks under at least 2 results.
4. web-search-spec.md and security-spec.md updated in the same commit as the
   code they authorize (spec-first ordering within the branch is fine).
5. No new npm dependencies (`git diff package.json` empty).
