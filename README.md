# deepseek-search

Web search and page reading for Claude Code through [DeepSeek's Search and Fetch APIs](https://api-docs.deepseek.com/guides/search/), used by default instead of the built-in WebSearch and WebFetch. The built-in tools stay available as a fallback.

## Install

```sh
claude plugin marketplace add NourEldinShobier/deepseek-search
claude plugin install deepseek-search@deepseek-search
```

Set your key ([platform.deepseek.com](https://platform.deepseek.com/api_keys)) and restart Claude Code:

| Shell | Command |
|---|---|
| Windows (persists) | `setx DEEPSEEK_API_KEY "sk-…"` |
| macOS / Linux | add `export DEEPSEEK_API_KEY="sk-…"` to `~/.zshrc` or `~/.bashrc` |

Needs [Bun](https://bun.sh) 1.2+.

## What you get

| Tool | Does |
|---|---|
| `search` | Ranked results, each with a ~700-character summary, score (0–3) and source authority (0–4). Supports `site:`, `-site:`, `"phrase"`, `-term`, `lang:`, `after:`, `before:`. `more_queries` runs up to 4 more queries in parallel and merges them without duplicates. `need_content` adds page text. |
| `fetch` | One page as Markdown, in 20,000-character pieces (`offset` continues). |

A `PreToolUse` hook turns WebSearch and WebFetch away and points Claude at these tools. It lets the built-in tool run when:

- `DEEPSEEK_API_KEY` is not set,
- a DeepSeek call failed with a key, balance, rate-limit or server error in the last 15 minutes (the error message says so), or
- DeepSeek could not fetch that particular URL.

Any cut is marked in the output with how to get the rest. DeepSeek's backslash-escaped punctuation (`\#`, `\.`) is unescaped to save tokens.

## Cost

$0.75 per 1,000 successful searches and the same per 1,000 fetches. Empty results and failures are not billed ([pricing](https://api-docs.deepseek.com/guides/search/)). `more_queries` is one request per query.

## Configuration

| Variable | Default | |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | Required |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | For a proxy or a test server |
| `DEEPSEEK_SEARCH_CACHE` | `~/.cache/deepseek-search` | Where the fallback marker lives |

## Develop

```sh
bun install
bun test                          # unit + end-to-end against a local fake API
DEEPSEEK_LIVE_KEY=sk-… bun test   # also one call against the real API
bunx tsc --noEmit
```

Built with [Effect 4](https://effect.website) (typed errors, retry, timeout, Schema-checked responses). No other runtime dependencies.

## License

MIT
