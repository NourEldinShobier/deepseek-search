import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFailures } from '../src/deepseek';
import { decide, FETCH_TOOL, SEARCH_TOOL } from '../src/redirect';
import { handle } from '../src/server';
import { formatPage, formatResults, tools, unescapeMarkdown } from '../src/tools';

const realFetch = globalThis.fetch;
let dir: string;
let calls: { url: string; body: unknown; auth: string | null }[];

/** Fake DeepSeek: answers with `responses` in order. */
function serve(...responses: Response[]) {
  calls = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') });
    return responses.shift() ?? new Response('{}', { status: 500 });
  }) as unknown as typeof fetch;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const call = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.handler(args);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ds-'));
  process.env.DEEPSEEK_SEARCH_CACHE = dir;
  process.env.DEEPSEEK_API_KEY = 'sk-test';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe('search', () => {
  test('sends the documented request and lists results', async () => {
    serve(json({ results: [{ title: 'DeepSeek V4', url: 'https://a.example/v4', summary: 'Released  in\nJune.', site_name: 'A', date: '2026-06-01T00:00:00+00:00', rerank_score: 2.4, authority: 3 }] }));
    const out = await call('search', { query: 'DeepSeek V4 release', count: 5, question: 'when did V4 ship?' });
    expect(calls[0]).toEqual({
      url: 'https://api.deepseek.com/v1/tools/search',
      body: { query: 'DeepSeek V4 release', count: 5, need_content: false, ori_question: 'when did V4 ship?' },
      auth: 'Bearer sk-test',
    });
    expect(out).toStartWith('1. [DeepSeek V4](https://a.example/v4) — A · 2026-06-01 · score 2.4 · authority 3\n   Released in June.');
  });

  test('a failed search unlocks the built-in WebSearch, and a later success locks it again', async () => {
    serve(json({ error: { message: 'Insufficient Balance' } }, 402));
    await expect(call('search', { query: 'x' })).rejects.toThrow('Search failed (HTTP 402: Insufficient Balance). The built-in WebSearch tool is unlocked');
    expect(decide({ tool_name: 'WebSearch' })).toBeNull();
    serve(json({ results: [] }));
    expect(await call('search', { query: 'x' })).toStartWith('No results.');
    expect(decide({ tool_name: 'WebSearch' })).toContain(SEARCH_TOOL);
  });

  test('retries once on 429 before giving up', async () => {
    serve(new Response('', { status: 429, headers: { 'retry-after': '0' } }), json({ results: [] }));
    await call('search', { query: 'x' });
    expect(calls.length).toBe(2);
  });

  test('more_queries run in parallel and merge best-first without duplicate URLs', async () => {
    serve(
      json({ results: [{ title: 'A', url: 'https://a.example', rerank_score: 1.0 }, { title: 'B', url: 'https://b.example', rerank_score: 2.0 }] }),
      json({ results: [{ title: 'A again', url: 'https://a.example', rerank_score: 2.9 }, { title: 'C', url: 'https://c.example', rerank_score: 0.5 }] }),
    );
    const out = await call('search', { query: 'one', more_queries: ['two', 'one'] });
    expect(calls.map((c) => (c.body as { query: string }).query)).toEqual(['one', 'two']);
    expect(out.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.slice(0, l.indexOf('('))) ).toEqual(['1. [A again]', '2. [B]', '3. [C]']);
  });

  test('a network error is retried once, then unlocks the fallback', async () => {
    calls = [];
    globalThis.fetch = mock(async () => {
      calls.push({ url: '', body: null, auth: null });
      throw new TypeError('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(call('search', { query: 'x' })).rejects.toThrow('Search failed (network error: connect ECONNREFUSED)');
    expect(calls.length).toBe(2);
    expect(decide({ tool_name: 'WebSearch' })).toBeNull();
  });

  test('a response that is not the documented shape is reported, not crashed on', async () => {
    serve(json({ results: [{ title: 42 }] }));
    await expect(call('search', { query: 'x' })).rejects.toThrow('unexpected response');
  });

  test('a non-JSON error page is reported with its status', async () => {
    serve(new Response('<html>bad gateway</html>', { status: 502 }), new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(call('search', { query: 'x' })).rejects.toThrow('HTTP 502: response is not JSON');
  });

  test('an empty query is refused without a request', async () => {
    serve();
    await expect(call('search', { query: '   ' })).rejects.toThrow('query is empty');
    expect(calls.length).toBe(0);
  });

  test('long queries are cut to the 128-character API limit and count is clamped', async () => {
    serve(json({ results: [] }));
    await call('search', { query: 'q'.repeat(300), count: 500 });
    expect(calls[0]!.body).toEqual({ query: 'q'.repeat(128), count: 50, need_content: false });
  });

  test('a bad query does not unlock the fallback', async () => {
    serve(json({ error: { message: 'query too long' } }, 400));
    await expect(call('search', { query: 'x' })).rejects.toThrow('DeepSeek rejected the query');
    expect(readFailures().search).toBeUndefined();
  });
});

describe('fetch', () => {
  test('returns the page in pieces with an offset to continue', () => {
    expect(formatPage('https://a.example', { title: 'T', content: 'abcdef' }, 0, 4)).toBe(
      '# T\nhttps://a.example\n\nabcd\n\n[characters 0–4 of 6; call fetch again with offset 4 for the rest]',
    );
    expect(formatPage('https://a.example', { title: 'T', content: 'abcdef' }, 4, 4)).toBe('# T\nhttps://a.example\n\nef');
  });

  test('a URL DeepSeek cannot fetch unlocks WebFetch for that URL only', async () => {
    serve(json({ error: { message: 'blocked' } }, 403));
    await expect(call('fetch', { url: 'https://hard.example/p' })).rejects.toThrow('Fetch failed for https://hard.example/p');
    expect(decide({ tool_name: 'WebFetch', tool_input: { url: 'https://hard.example/p' } })).toBeNull();
    expect(decide({ tool_name: 'WebFetch', tool_input: { url: 'https://other.example' } })).toContain(FETCH_TOOL);
    expect(decide({ tool_name: 'WebSearch' })).toContain(SEARCH_TOOL);
  });

  test('rejects URLs with credentials before calling DeepSeek', async () => {
    serve();
    await expect(call('fetch', { url: 'https://user:pw@a.example' })).rejects.toThrow('no credentials');
    expect(calls.length).toBe(0);
  });
});

describe('redirect hook', () => {
  test('lets the built-in tools run when there is no DeepSeek key', () => {
    expect(decide({ tool_name: 'WebSearch' }, Date.now(), false)).toBeNull();
  });

  test('a failure older than 15 minutes no longer unlocks the fallback', () => {
    const now = Date.now();
    expect(decide({ tool_name: 'WebSearch' }, now, true, { search: now - 16 * 60_000 })).toContain(SEARCH_TOOL);
  });
});

describe('MCP protocol', () => {
  test('initialize, list and an error result', async () => {
    expect(await handle({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).toMatchObject({ result: { serverInfo: { name: 'deepseek-search' } } });
    const list = (await handle({ id: 2, method: 'tools/list' })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['search', 'fetch']);
    expect(await handle({ id: 3, method: 'tools/call', params: { name: 'nope' } })).toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'unknown tool nope' }], isError: true } });
    expect(await handle({ method: 'notifications/initialized' })).toBeNull();
  });

  test('missing key gives an actionable error', async () => {
    process.env.DEEPSEEK_API_KEY = '';
    serve();
    await expect(call('search', { query: 'x' })).rejects.toThrow('DEEPSEEK_API_KEY is not set');
  });
});

test("DeepSeek's escaped punctuation is unescaped, real backslashes in words are kept", () => {
  expect(unescapeMarkdown('\\# Node\\.js \\(v24\\) \\| LTS \\- C:\\Users')).toBe('# Node.js (v24) | LTS - C:\\Users');
});

test('content is capped per result and says how to get the rest', () => {
  const out = formatResults([{ title: 'T', url: 'https://a.example', summary: 's', content: 'x'.repeat(4005) }], true);
  expect(out).toContain('[… 5 more characters; use fetch on this URL for the full page]');
});
