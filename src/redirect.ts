/**
 * PreToolUse hook on WebSearch|WebFetch: sends Claude to DeepSeek first. The built-in tool is allowed when there is no
 * DeepSeek key, when DeepSeek search failed in the last 15 minutes, or (for WebFetch) when DeepSeek could not fetch that URL.
 */
import { apiKey, FALLBACK_WINDOW_MS, readFailures } from './failures';

export const SEARCH_TOOL = 'mcp__plugin_deepseek-search_deepseek__search';
export const FETCH_TOOL = 'mcp__plugin_deepseek-search_deepseek__fetch';

export function decide(input: { tool_name?: string; tool_input?: { url?: string } }, now = Date.now(), hasKey = apiKey() !== '', failures = readFailures()): string | null {
  if (!hasKey) return null;
  if (failures.search && now - failures.search < FALLBACK_WINDOW_MS) return null;
  if (input.tool_name === 'WebFetch') {
    const url = input.tool_input?.url ?? '';
    const t = failures.urls?.[url];
    if (t && now - t < FALLBACK_WINDOW_MS) return null;
    return `Use ${FETCH_TOOL} (DeepSeek) to read ${url || 'this page'}. If it fails, WebFetch is unlocked for that URL.`;
  }
  if (input.tool_name === 'WebSearch') return `Use ${SEARCH_TOOL} (DeepSeek) for web searches. If it fails, WebSearch is unlocked for 15 minutes.`;
  return null;
}

if (import.meta.main) {
  let input: Parameters<typeof decide>[0] = {};
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0);
  }
  const reason = decide(input);
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}
