/**
 * End to end: the real MCP server and hook processes, talking to a local fake of DeepSeek's API
 * (DEEPSEEK_BASE_URL). `DEEPSEEK_LIVE_KEY=sk-… bun test` also runs one call against the real API.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const cache = mkdtempSync(join(tmpdir(), 'ds-e2e-'));
let fake: ReturnType<typeof Bun.serve>;
const seen: { path: string; body: Record<string, unknown> }[] = [];

beforeAll(() => {
  fake = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ path, body });
      if (req.headers.get('authorization') !== 'Bearer sk-e2e') return Response.json({ error: { message: 'Authentication Fails' } }, { status: 401 });
      if (path === '/v1/tools/search')
        return Response.json({ results: [{ title: `Hit for ${body.query}`, url: `https://hit.example/${encodeURIComponent(String(body.query))}`, summary: 'Summary\\.', rerank_score: 2 }] });
      if (path === '/v1/tools/fetch')
        return body.url === 'https://blocked.example/' ? Response.json({ error: { message: 'policy' } }, { status: 403 }) : Response.json({ title: 'Page', content: '\\# Heading\n\nBody\\.' });
      return new Response('not found', { status: 404 });
    },
  });
});
afterAll(() => {
  fake.stop(true);
  rmSync(cache, { recursive: true, force: true });
});

const env = (key = 'sk-e2e') => ({ ...process.env, DEEPSEEK_API_KEY: key, DEEPSEEK_BASE_URL: `http://localhost:${fake.port}`, DEEPSEEK_SEARCH_CACHE: cache });

/** Sends JSON-RPC lines to the MCP server and returns the replies by id. */
async function mcp(requests: (object | string)[], key?: string): Promise<Map<unknown, any>> {
  const proc = Bun.spawn(['bun', join(root, 'src/server.ts')], { stdin: 'pipe', stdout: 'pipe', env: env(key) });
  // A raw string is sent as is and answered with a parse error (id null).
  const want = requests.filter((r) => typeof r === 'string' || 'id' in r).length;
  for (const r of requests) proc.stdin.write(`${typeof r === 'string' ? r : JSON.stringify(r)}\n`);
  proc.stdin.flush();
  const replies = new Map<unknown, any>();
  const reader = proc.stdout.getReader();
  let buf = '';
  while (replies.size < want) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.set(m.id, m);
    }
  }
  proc.stdin.end();
  proc.kill();
  return replies;
}

const toolCall = (id: number, name: string, args: object) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

async function hook(input: object, key = 'sk-e2e'): Promise<string> {
  const proc = Bun.spawn(['bun', join(root, 'src/redirect.ts')], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', env: env(key) });
  return new Response(proc.stdout).text();
}

describe('MCP server over stdio', () => {
  test('handshake, then search and fetch through the server process', async () => {
    const r = await mcp([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      toolCall(3, 'search', { query: 'bun test', more_queries: ['bun runtime'] }),
      toolCall(4, 'fetch', { url: 'https://docs.example/' }),
    ]);
    expect(r.get(1).result.protocolVersion).toBe('2025-06-18');
    expect(r.get(2).result.tools.map((t: { name: string }) => t.name)).toEqual(['search', 'fetch']);
    const results = r.get(3).result.content[0].text as string;
    expect(results).toContain('[Hit for bun test](https://hit.example/bun%20test)');
    expect(results).toContain('[Hit for bun runtime](https://hit.example/bun%20runtime)');
    expect(results).toContain('   Summary.');
    expect(r.get(4).result).toEqual({ content: [{ type: 'text', text: '# Page\nhttps://docs.example/\n\n# Heading\n\nBody.' }] });
  });

  test('requests are answered concurrently and a bad line does not kill the server', async () => {
    const r = await mcp(['not json', { jsonrpc: '2.0', id: 9, method: 'ping' }]);
    expect(r.get(null)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    expect(r.get(9)).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
  });

  test('a rejected key comes back as a tool error that unlocks the built-in tools', async () => {
    const r = await mcp([toolCall(1, 'search', { query: 'x' })], 'sk-wrong');
    expect(r.get(1).result.isError).toBe(true);
    expect(r.get(1).result.content[0].text).toBe(
      'Search failed (HTTP 401: Authentication Fails). The built-in WebSearch tool is unlocked for the next 15 minutes; use it instead.',
    );
    expect(await hook({ tool_name: 'WebSearch', tool_input: { query: 'x' } })).toBe('');
    // A good search locks the built-in tool again.
    await mcp([toolCall(2, 'search', { query: 'x' })]);
    expect(JSON.parse(await hook({ tool_name: 'WebSearch', tool_input: { query: 'x' } })).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('redirect hook process', () => {
  test('denies WebSearch and WebFetch with a pointer to the DeepSeek tools', async () => {
    const out = JSON.parse(await hook({ tool_name: 'WebFetch', tool_input: { url: 'https://docs.example/' } }));
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Use mcp__plugin_deepseek-search_deepseek__fetch (DeepSeek) to read https://docs.example/. If it fails, WebFetch is unlocked for that URL.',
      },
    });
  });

  test('a page DeepSeek refuses is handed to the built-in WebFetch', async () => {
    const r = await mcp([toolCall(1, 'fetch', { url: 'https://blocked.example/' })]);
    expect(r.get(1).result.isError).toBe(true);
    expect(await hook({ tool_name: 'WebFetch', tool_input: { url: 'https://blocked.example/' } })).toBe('');
  });

  test('stays out of the way without a key, and on input it cannot parse', async () => {
    expect(await hook({ tool_name: 'WebSearch' }, '')).toBe('');
    const proc = Bun.spawn(['bun', join(root, 'src/redirect.ts')], { stdin: new Blob(['garbage']), stdout: 'pipe', env: env() });
    expect(await new Response(proc.stdout).text()).toBe('');
    expect(await proc.exited).toBe(0);
  });
});

describe('published bundles (what the plugin runs)', () => {
  test('dist/server.js answers a search and dist/redirect.js redirects, with no node_modules needed', async () => {
    const proc = Bun.spawn(['bun', join(root, 'dist/server.js')], { stdin: 'pipe', stdout: 'pipe', env: env(), cwd: tmpdir() });
    proc.stdin.write(`${JSON.stringify(toolCall(1, 'search', { query: 'bundle' }))}\n`);
    proc.stdin.flush();
    const { value } = await proc.stdout.getReader().read();
    proc.kill();
    expect(JSON.parse(new TextDecoder().decode(value)).result.content[0].text).toStartWith('1. [Hit for bundle]');
    const hookProc = Bun.spawn(['bun', join(root, 'dist/redirect.js')], { stdin: new Blob([JSON.stringify({ tool_name: 'WebSearch' })]), stdout: 'pipe', env: env() });
    expect(JSON.parse(await new Response(hookProc.stdout).text()).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe.if(Boolean(process.env.DEEPSEEK_LIVE_KEY))('live DeepSeek API', () => {
  test('search returns ranked results with summaries', async () => {
    const proc = Bun.spawn(['bun', join(root, 'src/server.ts')], {
      stdin: 'pipe',
      stdout: 'pipe',
      env: { ...process.env, DEEPSEEK_API_KEY: process.env.DEEPSEEK_LIVE_KEY, DEEPSEEK_BASE_URL: '', DEEPSEEK_SEARCH_CACHE: cache },
    });
    proc.stdin.write(`${JSON.stringify(toolCall(1, 'search', { query: 'site:nodejs.org Node.js LTS', count: 3 }))}\n`);
    proc.stdin.flush();
    const { value } = await proc.stdout.getReader().read();
    proc.kill();
    const text = JSON.parse(new TextDecoder().decode(value)).result.content[0].text as string;
    expect(text).toMatch(/^1\. \[.+\]\(https:\/\/nodejs\.org/);
  }, 30_000);
});
