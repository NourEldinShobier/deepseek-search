/** deepseek-search: an MCP server (stdio, newline-delimited JSON-RPC 2.0) over DeepSeek's Search and Fetch APIs. */
import { tools } from './tools';

type Id = string | number | null;
interface Message { jsonrpc?: string; id?: Id; method?: string; params?: Record<string, unknown> }

const VERSION = '0.1.0';
const INSTRUCTIONS =
  'Web access goes through this server: use search to find pages and fetch to read one. They replace the built-in WebSearch and WebFetch, ' +
  'which are only for when a call here fails (the error says so).';

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');

export async function handle(msg: Message): Promise<unknown | null> {
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notification
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'deepseek-search', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name);
      try {
        if (!tool) throw new Error(`unknown tool ${String(params.name)}`);
        return ok({ content: [{ type: 'text', text: await tool.handler((params.arguments ?? {}) as Record<string, unknown>) }] });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

if (import.meta.main) {
  const dispatch = async (line: string) => {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const reply = await handle(msg).catch((e) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: (e as Error).message } }));
    if (reply) send(reply);
  };
  const decoder = new TextDecoder();
  let buf = '';
  for await (const piece of Bun.stdin.stream()) {
    buf += decoder.decode(piece, { stream: true });
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) void dispatch(line);
    }
  }
  if (buf.trim()) void dispatch(buf.trim());
}
