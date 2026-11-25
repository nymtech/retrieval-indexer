import { describe, expect, it } from 'vitest';
import { mcpClient, parseProbeFile, parseRpcBody, runChecks, tally, type McpClient, type Probe, type ProbeFile, type ToolResult } from './checks.js';

const NYM = 'https://github.com/nymtech/nym/blob/develop';

function fakeClient({ tools = [], answers = {}, statuses = { POST: 406, GET: 405 } }: {
  tools?: { name: string; description?: string }[];
  answers?: Record<string, (args: Record<string, unknown>) => ToolResult>;
  statuses?: { POST: number; GET: number };
}): McpClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async rpc(method, params) {
      if (method === 'tools/list') return { tools };
      const name = params?.name as string;
      calls.push(name);
      const answer = answers[name];
      if (!answer) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      const r = answer((params?.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: r.text }], isError: r.isError };
    },
    async status({ method }) {
      return statuses[method];
    },
  };
}

const text = (t: string): ToolResult => ({ text: t, isError: false });
const file = (probes: Probe[], extra: Partial<ProbeFile> = {}): ProbeFile => ({ version: 1, name: 'nym', probes, ...extra });

describe('parseProbeFile', () => {
  const valid = { version: 1, name: 'nym', probes: [{ label: 'l', tool: 'search_docs', match: 'x' }] };

  it('reads a valid file', () => {
    expect(parseProbeFile(JSON.stringify(valid), 'f').name).toBe('nym');
  });

  it('refuses another format version', () => {
    expect(() => parseProbeFile(JSON.stringify({ ...valid, version: 2 }), 'f')).toThrow(/version 2/);
  });

  it('refuses a probe with no assertion', () => {
    expect(() => parseProbeFile(JSON.stringify({ ...valid, probes: [{ label: 'l', tool: 't' }] }), 'f')).toThrow(/at least one of/);
  });

  it('refuses an invalid regex', () => {
    expect(() => parseProbeFile(JSON.stringify({ ...valid, probes: [{ label: 'l', tool: 't', match: '(' }] }), 'f')).toThrow(/not a valid regex/);
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseProbeFile('nope', 'f')).toThrow(/not JSON/);
  });
});

describe('parseRpcBody', () => {
  it('reads the last data line of an SSE body', () => {
    expect(parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\n')).toEqual({ ok: 1 });
  });

  it('reads a plain JSON body', () => {
    expect(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{"ok":2}}')).toEqual({ ok: 2 });
  });

  it('throws on a JSON-RPC error', () => {
    expect(() => parseRpcBody('{"jsonrpc":"2.0","id":1,"error":{"message":"bad"}}')).toThrow(/bad/);
  });

  it('throws on an HTML page', () => {
    expect(() => parseRpcBody('<html>login</html>')).toThrow(/not JSON-RPC/);
  });
});

describe('runChecks', () => {
  it('passes the protocol checks on 406 and 405, and fails on other statuses', async () => {
    const good = tally(await runChecks(fakeClient({}), []));
    const bad = tally(await runChecks(fakeClient({ statuses: { POST: 200, GET: 200 } }), []));
    expect(good).toEqual({ pass: 2, fail: 0, note: 0 });
    expect(bad).toEqual({ pass: 0, fail: 2, note: 0 });
  });

  it('compares the tool set exactly and flags thin descriptions', async () => {
    const client = fakeClient({ tools: [{ name: 'search_docs', description: 'Search the Nym documentation' }, { name: 'get_section', description: 'short' }] });
    const results = await runChecks(client, [file([{ label: 'x', tool: 'search_docs', notMatch: 'never' }], { tools: ['get_section', 'search_docs'] })]);
    expect(results.find((r) => r.label.startsWith('tools/list'))?.status).toBe('pass');
    expect(results.find((r) => r.label.startsWith('every tool'))?.detail).toBe('thin: get_section');
  });

  it('judges match, notMatch and isError', async () => {
    const client = fakeClient({ answers: { search_docs: () => text('SOCKS5 client setup'), no_such: () => ({ text: 'x', isError: true }) } });
    const results = await runChecks(client, [file([
      { label: 'match', tool: 'search_docs', match: ['SOCKS5', 'setup'] },
      { label: 'match fails', tool: 'search_docs', match: 'wireguard' },
      { label: 'notMatch', tool: 'search_docs', notMatch: 'undefined|NaN' },
      { label: 'isError', tool: 'no_such', isError: true },
      { label: 'unknown tool is an error', tool: 'missing', isError: true },
    ])]);
    const status = Object.fromEntries(results.map((r) => [r.label, r.status]));
    expect(status).toMatchObject({ match: 'pass', 'match fails': 'fail', notMatch: 'pass', isError: 'pass', 'unknown tool is an error': 'pass' });
  });

  it('anchors a path check at the repository root', async () => {
    const client = fakeClient({ answers: { search_code: () => text(`hit ${NYM}/wasm/smolmix/src/lib.rs#L1`) } });
    const results = await runChecks(client, [file([
      { label: 'nested', tool: 'search_code', path: { repo: 'nymtech/nym', path: 'wasm/smolmix' } },
      { label: 'top level', tool: 'search_code', path: { repo: 'nymtech/nym', path: 'smolmix' } },
      { label: 'other repo', tool: 'search_code', path: { repo: 'nymtech/nym-vpn-client', path: 'wasm/smolmix' } },
    ])]);
    expect(results.filter((r) => r.source === 'nym').map((r) => r.status)).toEqual(['pass', 'fail', 'fail']);
    expect(results.find((r) => r.label === 'top level')?.detail).toContain('nymtech/nym/blob/develop/wasm/smolmix');
  });

  it('round-trips the first anchored URL through get_section', async () => {
    const client = fakeClient({
      answers: {
        search_docs: () => text('## Page - Heading\nhttps://nym.com/docs/network/x#anchor\nbody'),
        get_section: (args) => text(args.ref === 'https://nym.com/docs/network/x#anchor' ? 'the section' : 'No section found'),
      },
    });
    const [result] = (await runChecks(client, [file([{ label: 'rt', tool: 'search_docs', roundTrip: true }])])).filter((r) => r.label === 'rt');
    expect(result.status).toBe('pass');
    expect(client.calls).toEqual(['search_docs', 'get_section']);
  });

  it('prints an advisory failure as a note', async () => {
    const client = fakeClient({ answers: { search_docs: () => text('No documentation matched') } });
    const results = await runChecks(client, [file([{ label: 'floor', tool: 'search_docs', notMatch: 'No documentation matched', advisory: true }])]);
    expect(tally(results)).toEqual({ pass: 2, fail: 0, note: 1 });
  });

  it('fails a probe whose call throws, and runs the next one', async () => {
    const client = fakeClient({ answers: { search_docs: () => { throw new Error('HTTP 500'); }, chain_status: () => text('Connected nyxd: https://x') } });
    const results = await runChecks(client, [file([
      { label: 'throws', tool: 'search_docs', match: 'x' },
      { label: 'next', tool: 'chain_status', match: 'Connected nyxd' },
    ])]);
    expect(results.find((r) => r.label === 'throws')).toMatchObject({ status: 'fail', detail: 'HTTP 500' });
    expect(results.find((r) => r.label === 'next')?.status).toBe('pass');
  });
});

describe('mcpClient', () => {
  it('sends both Accept types and the bypass header, and reads the SSE result', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response('data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await mcpClient('https://x/api/mcp', { bypass: 'tok', fetchImpl }).rpc('tools/list');
    expect(result).toEqual({ tools: [] });
    expect(seen?.headers).toMatchObject({ Accept: 'application/json, text/event-stream', 'x-vercel-protection-bypass': 'tok' });
  });

  it('throws on an HTTP error with the start of the body', async () => {
    const fetchImpl = (async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch;
    await expect(mcpClient('https://x', { fetchImpl }).rpc('tools/list')).rejects.toThrow(/HTTP 403: Forbidden/);
  });
});
