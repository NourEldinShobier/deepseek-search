/** DeepSeek Search and Fetch APIs (https://api-docs.deepseek.com/guides/search/), plus the failure marker the hook reads. */
import { Data, Effect, Schedule, Schema } from 'effect';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BASE = () => (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
export const apiKey = () => (process.env.DEEPSEEK_API_KEY ?? '').trim();
export const cacheDir = () => process.env.DEEPSEEK_SEARCH_CACHE || join(homedir(), '.cache', 'deepseek-search');
const markerPath = () => join(cacheDir(), 'failures.json');

/** `status` is the HTTP status; 0 means no response (network error or timeout). */
export class DeepSeekError extends Data.TaggedError('DeepSeekError')<{ readonly status: number; readonly message: string; readonly retry?: false }> {}

const Nullable = <S extends Schema.Top>(s: S) => Schema.optional(Schema.NullOr(s));

const Result = Schema.Struct({
  rerank_score: Nullable(Schema.Number),
  title: Nullable(Schema.String),
  url: Nullable(Schema.String),
  summary: Nullable(Schema.String),
  content: Nullable(Schema.String),
  site_name: Nullable(Schema.String),
  date: Nullable(Schema.String),
  authority: Nullable(Schema.Number),
});
export type Result = typeof Result.Type;

const SearchResponse = Schema.Struct({ results: Nullable(Schema.Array(Result)) });
const FetchResponse = Schema.Struct({ title: Nullable(Schema.String), content: Nullable(Schema.String) });
const ErrorBody = Schema.Struct({ error: Schema.optional(Schema.Struct({ message: Nullable(Schema.String) })) });

/** DeepSeek's docs: wait and retry on 408, 429 and 5xx (and here on no response at all). */
const retryable = (e: DeepSeekError) => e.retry !== false && (e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500);

function post<A>(path: string, body: unknown, schema: Schema.Codec<A, unknown>): Effect.Effect<A, DeepSeekError> {
  return Effect.gen(function* () {
    const key = apiKey();
    if (!key) return yield* new DeepSeekError({ status: 401, message: 'DEEPSEEK_API_KEY is not set' });
    const res = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${BASE()}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        }),
      catch: (e) => new DeepSeekError({ status: 0, message: `network error: ${(e as Error).message}` }),
    });
    const json = yield* Effect.tryPromise({
      try: () => res.json() as Promise<unknown>,
      catch: () => new DeepSeekError({ status: res.ok ? 502 : res.status, message: `HTTP ${res.status}: response is not JSON` }),
    });
    if (!res.ok) {
      const detail = Schema.decodeUnknownOption(ErrorBody)(json).pipe((o) => (o._tag === 'Some' ? o.value.error?.message : undefined));
      return yield* new DeepSeekError({ status: res.status, message: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` });
    }
    return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError((e) => new DeepSeekError({ status: 502, message: `unexpected response: ${e.message}`, retry: false })),
    );
  }).pipe(
    Effect.timeout('30 seconds'),
    Effect.mapError((e) => (e instanceof DeepSeekError ? e : new DeepSeekError({ status: 0, message: 'timed out after 30 s' }))),
    Effect.retry({ times: 1, while: retryable, schedule: Schedule.spaced('1500 millis') }),
  );
}

export const search = (args: { query: string; count?: number; need_content?: boolean; ori_question?: string }) =>
  post('/v1/tools/search', args, SearchResponse as Schema.Codec<typeof SearchResponse.Type, unknown>).pipe(Effect.map((r) => r.results ?? []));

export const fetchPage = (url: string) => post('/v1/tools/fetch', { url }, FetchResponse as Schema.Codec<typeof FetchResponse.Type, unknown>);

// ---------------------------------------------------------------- failure marker for the hook

interface Failures {
  /** Last time DeepSeek as a whole failed (key, balance, outage), ms since epoch. */
  search?: number;
  /** URLs DeepSeek could not fetch, with the time it failed. */
  urls?: Record<string, number>;
}

export const FALLBACK_WINDOW_MS = 15 * 60_000;

export function readFailures(): Failures {
  try {
    return existsSync(markerPath()) ? (JSON.parse(readFileSync(markerPath(), 'utf8')) as Failures) : {};
  } catch {
    return {};
  }
}

function writeFailures(f: Failures): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify(f));
  } catch {
    // The marker only unlocks the fallback sooner; losing it is harmless.
  }
}

/** Failures that mean DeepSeek is unusable right now (not a bad request). */
export const isOutage = (e: DeepSeekError) => e.status === 0 || e.status === 401 || e.status === 402 || e.status === 429 || e.status >= 500;

export function noteSearchFailure(now = Date.now()): void {
  writeFailures({ ...readFailures(), search: now });
}

export function noteFetchFailure(url: string, now = Date.now()): void {
  const f = readFailures();
  const urls = Object.fromEntries(Object.entries(f.urls ?? {}).filter(([, t]) => now - t < FALLBACK_WINDOW_MS));
  urls[url] = now;
  writeFailures({ ...f, urls });
}

export function clearSearchFailure(): void {
  const f = readFailures();
  if (f.search) writeFailures({ ...f, search: undefined });
}
