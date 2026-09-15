import type { ToolContext } from "./types.js";
import { pkg } from "../version.js";

const USER_AGENT = `nib/${pkg.version} (+cli)`;
const TIMEOUT_MS = 10_000;
const BODY_CAP_BYTES = 512 * 1024;

export interface WebResult {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * Thrown for a SearXNG 403 — treated as a permanent instance-config problem
 * (the instance's `search.formats` config doesn't include `json`), not a
 * transient failure. Never retried; callers must not fall back to Bing
 * silently for this case — the message tells the user how to fix it.
 */
export class SearxngConfigError extends Error {
  constructor() {
    super(
      'SearXNG returned 403 for the JSON API — the instance likely needs "json" added to search.formats in its settings.yml.',
    );
  }
}

/** 5xx responses and network-level failures — retried by fetchSearxngWithRetry, then fall back to Bing. */
export class SearxngTransientError extends Error {}

/**
 * True when `body` parses as the SearXNG JSON API's expected shape (an
 * object with a `results` array). Distinguishes a genuine zero-result
 * response from one whose shape we no longer understand.
 */
export function looksLikeSearxngJson(body: unknown): body is { results: unknown[] } {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as Record<string, unknown>).results)
  );
}

/** Parses the SearXNG JSON API's `results[]` into flat results, dropping items without a usable title or url. */
export function parseSearxngResults(body: { results: unknown[] }): WebResult[] {
  const results: WebResult[] = [];
  for (const item of body.results) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const url = typeof r.url === "string" ? r.url.trim() : "";
    if (!title || !url) continue;
    const content = typeof r.content === "string" ? r.content.trim() : "";
    results.push({ title, url, snippet: content || undefined });
  }
  return results;
}

/**
 * GETs {searxngUrl}/search?q=<query>&format=json and returns the parsed JSON
 * body (unvalidated shape — callers check with looksLikeSearxngJson).
 * Mirrors fetchRss's conventions: fixed User-Agent, 10s timeout via
 * AbortSignal.any, redirect: manual, streamed body read capped at 512 KB.
 */
async function fetchSearxng(searxngUrl: string, query: string, ctx: ToolContext): Promise<unknown> {
  const url = `${searxngUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), TIMEOUT_MS);
  try {
    const signal = AbortSignal.any([ctx.signal, timeoutController.signal]);
    let res: Response;
    try {
      res = await fetch(url, {
        signal,
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new SearxngTransientError(message);
    }

    if (res.status === 403) {
      throw new SearxngConfigError();
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new SearxngTransientError(`unexpected redirect (status ${res.status})`);
    }
    if (res.status >= 500) {
      throw new SearxngTransientError(`request failed (status ${res.status})`);
    }
    if (res.status === 429) {
      throw new SearxngTransientError(`rate-limited (status ${res.status})`);
    }
    if (!res.ok) {
      throw new SearxngTransientError(`request failed (status ${res.status})`);
    }

    const text = await readBodyCapped(res);
    try {
      return JSON.parse(text);
    } catch {
      // Malformed JSON is the same "unrecognized shape" bucket as a body
      // that parses but doesn't look like the expected results structure.
      return null;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readBodyCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > BODY_CAP_BYTES) {
        await reader.cancel();
        throw new SearxngTransientError("response body exceeded size cap");
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

const RETRY_DELAYS_MS = [250, 750];

/**
 * Retries fetchSearxng on transient (5xx/network) failures only, with short
 * fixed backoff — same policy as fetchRssWithRetry. SearxngConfigError
 * (403), aborts, and other errors propagate immediately.
 */
async function fetchSearxngWithRetry(searxngUrl: string, query: string, ctx: ToolContext): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchSearxng(searxngUrl, query, ctx);
    } catch (err) {
      if (!(err instanceof SearxngTransientError) || attempt >= RETRY_DELAYS_MS.length) throw err;
      await delay(RETRY_DELAYS_MS[attempt], ctx.signal);
    }
  }
}

/**
 * Queries a SearXNG instance's JSON API and returns parsed results.
 * Throws SearxngConfigError for 403 (permanent, no fallback), or
 * SearxngTransientError / AbortError for anything the caller should treat
 * as transient (retry exhausted, network failure, timeout) and fall back to
 * Bing for. Throws a plain Error for an unrecognized JSON shape — also
 * caller's call whether that's transient, but per the handoff doc this is
 * treated as a tool failure like looksLikeRssFeed's unrecognized-XML case,
 * not silently retried into Bing.
 */
export async function searchSearxng(searxngUrl: string, query: string, ctx: ToolContext): Promise<WebResult[]> {
  const body = await fetchSearxngWithRetry(searxngUrl, query, ctx);
  if (!looksLikeSearxngJson(body)) {
    throw new Error("SearXNG returned an unrecognized response format");
  }
  return parseSearxngResults(body);
}
