/**
 * End-to-end checks of a deployed MCP server that searches the store. A probe
 * file (format version 1) holds one producer's checks as data; the runner sends
 * each one to the endpoint over HTTP and asserts on the text the tool returns.
 */

export const PROBE_FORMAT_VERSION = 1;

export interface Probe {
  /** Heading the result is printed under. */
  group?: string;
  label: string;
  tool: string;
  args?: Record<string, unknown>;
  /** Each regex must match the tool's text. */
  match?: string | string[];
  /** The regex must not match the tool's text. */
  notMatch?: string;
  /** The result must be an MCP error result (`isError: true`). */
  isError?: boolean;
  /** A hit must link to a file at or under `path` in `repo` (`github.com/<repo>/blob/<ref>/<path>/`). */
  path?: { repo: string; path: string };
  /** The first anchored URL in the text must resolve through `get_section`. */
  roundTrip?: boolean;
  /** A failure is printed as a note and does not fail the run. */
  advisory?: boolean;
}

/** What a producer writes to the store, for the store checks (store-checks.ts). */
export interface StoreDeclaration {
  /** The `repo` of its shards, for example `nym`. */
  repo: string;
  /** The GitHub repository the shards are built from, `owner/name`. */
  github: string;
  /** The commit the shards must be built from: a branch's head, or the newest release. */
  tracks: { branch: string } | { release: 'latest' };
  /** The code roots the write walks. Each must hold chunks, and no chunk may be outside them. */
  roots: string[];
}

export interface ProbeFile {
  version: typeof PROBE_FORMAT_VERSION;
  /** The producer, for example `nym`. */
  name: string;
  /** The exact tool set that `tools/list` must return. */
  tools?: string[];
  store?: StoreDeclaration;
  probes: Probe[];
}

export type CheckStatus = 'pass' | 'fail' | 'note';

export interface CheckResult {
  source: string;
  group: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface McpClient {
  /** Sends one JSON-RPC request and returns its `result`. */
  rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Sends a raw request and returns the HTTP status. */
  status(init: { method: 'GET' | 'POST'; accept: string; body?: string }): Promise<number>;
}

const ASSERTIONS = ['match', 'notMatch', 'isError', 'path', 'roundTrip'] as const;
const MIN_DESCRIPTION = 20;
const SECTION_MISS = 'No section found';

export function parseProbeFile(text: string, source: string): ProbeFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source}: not JSON (${(e as Error).message})`);
  }
  const file = data as Partial<ProbeFile>;
  if (file.version !== PROBE_FORMAT_VERSION) throw new Error(`${source}: probe format version ${String(file.version)}, this runner reads version ${PROBE_FORMAT_VERSION}`);
  if (typeof file.name !== 'string' || !file.name) throw new Error(`${source}: "name" must be a non-empty string`);
  if (file.tools !== undefined && !(Array.isArray(file.tools) && file.tools.every((t) => typeof t === 'string'))) throw new Error(`${source}: "tools" must be a list of names`);
  if (file.store !== undefined) parseStore(file.store, source);
  if (!Array.isArray(file.probes) || file.probes.length === 0) throw new Error(`${source}: "probes" must be a non-empty list`);
  file.probes.forEach((p, i) => {
    const at = `${source}: probe ${i + 1}`;
    if (typeof p?.label !== 'string' || !p.label) throw new Error(`${at}: "label" must be a non-empty string`);
    if (typeof p.tool !== 'string' || !p.tool) throw new Error(`${at} (${p.label}): "tool" must be a non-empty string`);
    if (!ASSERTIONS.some((a) => p[a] !== undefined)) throw new Error(`${at} (${p.label}): give at least one of ${ASSERTIONS.join(', ')}`);
    for (const re of [p.match ?? [], p.notMatch ?? []].flat()) {
      try {
        new RegExp(re);
      } catch {
        throw new Error(`${at} (${p.label}): /${re}/ is not a valid regex`);
      }
    }
    if (p.path && (typeof p.path.repo !== 'string' || typeof p.path.path !== 'string')) throw new Error(`${at} (${p.label}): "path" needs "repo" and "path"`);
  });
  return file as ProbeFile;
}

function parseStore(store: Partial<StoreDeclaration>, source: string): void {
  const at = `${source}: "store"`;
  const text = (v: unknown) => typeof v === 'string' && v.length > 0;
  if (!text(store.repo)) throw new Error(`${at}: "repo" must be a non-empty string`);
  if (typeof store.github !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(store.github)) throw new Error(`${at}: "github" must be owner/name`);
  const tracks = store.tracks as Record<string, unknown> | undefined;
  const branch = tracks && Object.keys(tracks).length === 1 && text(tracks.branch);
  const release = tracks && Object.keys(tracks).length === 1 && tracks.release === 'latest';
  if (!branch && !release) throw new Error(`${at}: "tracks" must be {"branch": "<name>"} or {"release": "latest"}`);
  if (!Array.isArray(store.roots) || store.roots.length === 0 || !store.roots.every(text)) throw new Error(`${at}: "roots" must be a non-empty list of paths`);
}

/** The text of the first content block in an MCP SSE or JSON response body. */
export function parseRpcBody(body: string): Record<string, unknown> {
  const dataLines = body.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  const payload = dataLines.length ? dataLines[dataLines.length - 1] : body;
  let message: { result?: Record<string, unknown>; error?: { message?: string } };
  try {
    message = JSON.parse(payload);
  } catch {
    throw new Error(`the response is not JSON-RPC: ${body.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  if (message.error) throw new Error(`JSON-RPC error: ${message.error.message ?? 'no message'}`);
  if (!message.result) throw new Error('the JSON-RPC response has no result');
  return message.result;
}

export function mcpClient(url: string, { bypass, fetchImpl = fetch }: { bypass?: string; fetchImpl?: typeof fetch } = {}): McpClient {
  const headers = (accept: string): Record<string, string> => ({
    'Content-Type': 'application/json',
    Accept: accept,
    ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}),
  });
  let id = 0;
  return {
    async rpc(method, params) {
      id += 1;
      const res = await fetchImpl(url, { method: 'POST', headers: headers('application/json, text/event-stream'), body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 120).replace(/\s+/g, ' ')}`);
      return parseRpcBody(body);
    },
    async status({ method, accept, body }) {
      const res = await fetchImpl(url, { method, headers: headers(accept), ...(body ? { body } : {}) });
      await res.body?.cancel();
      return res.status;
    },
  };
}

async function callTool(client: McpClient, tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const result = await client.rpc('tools/call', { name: tool, arguments: args });
  const content = result.content as { type?: string; text?: string }[] | undefined;
  return { text: content?.[0]?.text ?? '', isError: result.isError === true };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 180);
}

/** The reason the probe fails on this result, or null when it passes. */
async function judge(client: McpClient, probe: Probe, result: ToolResult): Promise<string | null> {
  if (probe.isError !== undefined && result.isError !== probe.isError) return `isError is ${result.isError}, wanted ${probe.isError}`;
  for (const re of [probe.match ?? []].flat()) {
    if (!new RegExp(re).test(result.text)) return `wanted /${re}/, got: ${excerpt(result.text)}`;
  }
  if (probe.notMatch !== undefined && new RegExp(probe.notMatch).test(result.text)) return `matched /${probe.notMatch}/: ${excerpt(result.text)}`;
  if (probe.path) {
    const { repo, path } = probe.path;
    const under = new RegExp(`github\\.com/${escapeRegex(repo)}/blob/[^/\\s]+/${escapeRegex(path.replace(/\/$/, ''))}/`);
    if (!under.test(result.text)) {
      const seen = [...result.text.matchAll(/github\.com\/[^\s)]+/g)].slice(0, 4).map((m) => m[0].replace(/^github\.com\//, ''));
      return `no hit under ${repo}/${path}; links returned: ${seen.join(' ') || 'none'}`;
    }
  }
  if (probe.roundTrip) {
    const ref = result.text.match(/https:\/\/\S*#\S*/)?.[0];
    if (!ref) return 'no anchored URL in the output to round-trip';
    const section = await callTool(client, 'get_section', { ref });
    if (section.text.includes(SECTION_MISS)) return `get_section did not resolve ${ref}`;
  }
  return null;
}

async function protocolChecks(client: McpClient): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const add = (label: string, ok: boolean, detail?: string) => out.push({ source: 'server', group: 'Protocol', label, status: ok ? 'pass' : 'fail', ...(ok ? {} : { detail }) });
  const listBody = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' });
  try {
    const single = await client.status({ method: 'POST', accept: 'application/json', body: listBody });
    add('a single Accept header is rejected (406)', single === 406, `got ${single}`);
    const get = await client.status({ method: 'GET', accept: 'application/json, text/event-stream' });
    add('GET is rejected (405, a stateless server has no sessions)', get === 405, `got ${get}`);
  } catch (e) {
    add('the endpoint answers', false, (e as Error).message);
  }
  return out;
}

async function toolListChecks(client: McpClient, file: ProbeFile): Promise<CheckResult[]> {
  if (!file.tools) return [];
  const base = { source: file.name, group: 'Protocol' };
  let tools: { name: string; description?: string }[];
  try {
    tools = ((await client.rpc('tools/list')).tools ?? []) as typeof tools;
  } catch (e) {
    return [{ ...base, label: 'tools/list answers', status: 'fail', detail: (e as Error).message }];
  }
  const got = tools.map((t) => t.name).sort().join(',');
  const want = [...file.tools].sort().join(',');
  const thin = tools.filter((t) => (t.description ?? '').length < MIN_DESCRIPTION).map((t) => t.name);
  return [
    { ...base, label: `tools/list returns the ${file.tools.length} expected tools`, status: got === want ? 'pass' : 'fail', ...(got === want ? {} : { detail: `expected ${want}; got ${got || 'none'}` }) },
    { ...base, label: 'every tool has a description an agent can choose by', status: thin.length ? 'fail' : 'pass', ...(thin.length ? { detail: `thin: ${thin.join(', ')}` } : {}) },
  ];
}

/** Runs the protocol checks once, then each file's tool list and probes in order. */
export async function runChecks(client: McpClient, files: ProbeFile[]): Promise<CheckResult[]> {
  const results = await protocolChecks(client);
  for (const file of files) {
    results.push(...(await toolListChecks(client, file)));
    for (const probe of file.probes) {
      const base = { source: file.name, group: probe.group ?? 'Probes', label: probe.label };
      let reason: string | null;
      try {
        reason = await judge(client, probe, await callTool(client, probe.tool, probe.args));
      } catch (e) {
        reason = (e as Error).message;
      }
      results.push({ ...base, status: reason === null ? 'pass' : probe.advisory ? 'note' : 'fail', ...(reason === null ? {} : { detail: reason }) });
    }
  }
  return results;
}

export function tally(results: CheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, note: 0 };
  for (const r of results) counts[r.status] += 1;
  return counts;
}

function groups(results: CheckResult[]): Map<string, CheckResult[]> {
  const by = new Map<string, CheckResult[]>();
  for (const r of results) {
    const key = `${r.source}: ${r.group}`;
    by.set(key, [...(by.get(key) ?? []), r]);
  }
  return by;
}

export function formatText(results: CheckResult[]): string {
  const lines: string[] = [];
  for (const [heading, rs] of groups(results)) {
    lines.push('', heading);
    for (const r of rs) {
      lines.push(`  ${r.status.toUpperCase().padEnd(4)}  ${r.label}`);
      if (r.detail) lines.push(`        ${r.detail}`);
    }
  }
  const c = tally(results);
  lines.push('', `${c.pass} passed, ${c.fail} failed${c.note ? `, ${c.note} notes` : ''}`);
  return lines.join('\n');
}

export function formatMarkdown(results: CheckResult[], endpoint: string): string {
  const c = tally(results);
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const lines = [`### MCP checks: ${c.fail ? 'failing' : 'passing'}`, '', `Endpoint: \`${endpoint}\`. ${c.pass} passed, ${c.fail} failed${c.note ? `, ${c.note} notes` : ''}.`, ''];
  const shown = results.filter((r) => r.status !== 'pass');
  if (shown.length) {
    lines.push('| Source | Group | Check | Status | Detail |', '|---|---|---|---|---|');
    for (const r of shown) lines.push(`| ${cell(r.source)} | ${cell(r.group)} | ${cell(r.label)} | ${r.status} | ${cell(r.detail ?? '')} |`);
  }
  return lines.join('\n');
}
