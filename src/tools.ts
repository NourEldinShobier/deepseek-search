/** The two MCP tools and how their output is laid out for the model. */
import { Effect } from 'effect';
import { clearSearchFailure, DeepSeekError, fetchPage, isOutage, noteFetchFailure, noteSearchFailure, search, type Result } from './deepseek';

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

const PER_RESULT_CONTENT = 4000;
const FETCH_CHARS = 20_000;
const MAX_EXTRA_QUERIES = 4;

/** DeepSeek's Markdown backslash-escapes most punctuation (`\#`, `\.`, `\(`); the escapes only cost tokens. */
export const unescapeMarkdown = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');

export function formatResults(results: readonly Result[], withContent: boolean): string {
  if (!results.length) return 'No results. Try fewer or different words, or drop operators like site: or after:.';
  const lines = results.map((r, i) => {
    const meta = [
      r.site_name,
      r.date?.slice(0, 10),
      typeof r.rerank_score === 'number' && `score ${r.rerank_score.toFixed(1)}`,
      typeof r.authority === 'number' && r.authority >= 0 && `authority ${r.authority}`,
    ]
      .filter(Boolean)
      .join(' · ');
    let s = `${i + 1}. [${r.title || r.url}](${r.url})${meta ? ` — ${meta}` : ''}\n   ${unescapeMarkdown(r.summary ?? '').replace(/\s+/g, ' ').trim()}`;
    if (withContent && r.content) {
      const content = unescapeMarkdown(r.content);
      const cut = content.length > PER_RESULT_CONTENT;
      s += `\n\n${content.slice(0, PER_RESULT_CONTENT)}${cut ? `\n[… ${content.length - PER_RESULT_CONTENT} more characters; use fetch on this URL for the full page]` : ''}\n`;
    }
    return s;
  });
  return `${lines.join('\n')}\n\n${results.length} results. Scores run 0–3 (1.5+ is high quality); authority 0–4 (3+ is a highly authoritative source).`;
}

export function formatPage(url: string, page: { title?: string | null; content?: string | null }, offset: number, max: number): string {
  const content = unescapeMarkdown(page.content ?? '');
  if (!content.trim()) return `DeepSeek returned no content for ${url}. The built-in WebFetch is unlocked for this URL; use it instead.`;
  const end = Math.min(content.length, offset + max);
  const more = end < content.length ? `\n\n[characters ${offset}–${end} of ${content.length}; call fetch again with offset ${end} for the rest]` : '';
  return `# ${page.title || url}\n${url}\n\n${content.slice(offset, end)}${more}`;
}

/** Tool-level failure: its message is what the model reads. */
class ToolError extends Error {}

const searchProgram = (a: Record<string, unknown>) =>
  Effect.gen(function* () {
    const query = String(a.query ?? '').trim().slice(0, 128);
    if (!query) return yield* Effect.fail(new ToolError('query is empty'));
    const needContent = a.need_content === true;
    const count = Math.min(50, Math.max(1, Number(a.count) || 8));
    const question = a.question ? { ori_question: String(a.question).slice(0, 128) } : {};
    const extra = (Array.isArray(a.more_queries) ? a.more_queries : []).map((q) => String(q).trim().slice(0, 128)).filter(Boolean);
    const queries = [...new Set([query, ...extra])].slice(0, 1 + MAX_EXTRA_QUERIES);

    const runs = yield* Effect.all(
      queries.map((q) => search({ query: q, count, need_content: needContent, ...question })),
      { concurrency: 'unbounded' },
    );
    clearSearchFailure();
    // Merge best-first; the first time a URL appears wins.
    const seen = new Set<string>();
    const merged = runs
      .flat()
      .sort((x, y) => (y.rerank_score ?? 0) - (x.rerank_score ?? 0))
      .filter((r) => r.url && !seen.has(r.url) && seen.add(r.url));
    return formatResults(merged, needContent);
  }).pipe(
    Effect.catchTag('DeepSeekError', (e: DeepSeekError) => {
      if (isOutage(e)) noteSearchFailure();
      return Effect.fail(
        new ToolError(
          isOutage(e)
            ? `Search failed (${e.message}). The built-in WebSearch tool is unlocked for the next 15 minutes; use it instead.`
            : `DeepSeek rejected the query (${e.message}). Rephrase it.`,
        ),
      );
    }),
  );

const fetchProgram = (a: Record<string, unknown>) =>
  Effect.gen(function* () {
    const url = String(a.url ?? '').trim();
    const u = URL.parse(url);
    if (!u || !/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password)
      return yield* Effect.fail(new ToolError('url must be an http(s) URL with a host and no credentials'));
    const page = yield* fetchPage(url);
    if (!page.content?.trim()) noteFetchFailure(url);
    return formatPage(url, page, Math.max(0, Number(a.offset) || 0), Math.min(100_000, Math.max(1000, Number(a.max_chars) || FETCH_CHARS)));
  }).pipe(
    Effect.catchTag('DeepSeekError', (e: DeepSeekError) => {
      noteFetchFailure(String(a.url));
      if (isOutage(e)) noteSearchFailure();
      return Effect.fail(new ToolError(`Fetch failed for ${String(a.url)} (${e.message}). The built-in WebFetch tool is unlocked for this URL; use it instead.`));
    }),
  );

const run = (program: Effect.Effect<string, ToolError>) => Effect.runPromise(program);

export const tools: Tool[] = [
  {
    name: 'search',
    description:
      'Search the web with DeepSeek. Use this for any online lookup instead of the built-in WebSearch. Returns ranked results with a ~700-character summary each. ' +
      'Query operators: site:example.com, -site:, "exact phrase", -term, lang:en, after:2026-01-01, before:2026. Keep each query under 128 characters. ' +
      'For broad research pass more_queries (other phrasings, languages or site: variants) to search them in one call. Read the 1–3 best results with fetch.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, 1–128 characters; operators allowed' },
        more_queries: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_EXTRA_QUERIES,
          description: `Up to ${MAX_EXTRA_QUERIES} extra queries run in parallel; results are merged best-first and duplicate URLs removed`,
        },
        count: { type: 'integer', minimum: 1, maximum: 50, description: 'Results per query (default 8)' },
        question: { type: 'string', description: "The user's original question, if it differs from the query (helps ranking)" },
        need_content: { type: 'boolean', description: `Include each page's text (first ${PER_RESULT_CONTENT} characters). Default false` },
      },
      required: ['query'],
    },
    handler: (a) => run(searchProgram(a)),
  },
  {
    name: 'fetch',
    description:
      'Read one web page as Markdown with DeepSeek. Use this instead of the built-in WebFetch. Long pages come back in pieces: pass offset to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset to start from (default 0)' },
        max_chars: { type: 'integer', minimum: 1000, maximum: 100000, description: `Characters to return (default ${FETCH_CHARS})` },
      },
      required: ['url'],
    },
    handler: (a) => run(fetchProgram(a)),
  },
];
