/** Which built-in web tools the hook should let through, written by the MCP server. No Effect here: the hook loads this. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const apiKey = () => (process.env.DEEPSEEK_API_KEY ?? '').trim();
export const cacheDir = () => process.env.DEEPSEEK_SEARCH_CACHE || join(homedir(), '.cache', 'deepseek-search');
const markerPath = () => join(cacheDir(), 'failures.json');

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
