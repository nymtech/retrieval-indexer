#!/usr/bin/env node
/**
 * retrieval-mcp-check <mcp-url> <probe file or URL>...
 *
 * Runs the probe files against a deployed MCP endpoint and exits 1 if a check
 * fails. A Vercel preview needs its bypass token in $BYPASS. With
 * $GITHUB_STEP_SUMMARY set, it also writes a Markdown summary there.
 *
 * With $RETRIEVAL_STORE_READ_URL (a read-only role) and $RETRIEVAL_STORE_CA_CERT,
 * it also runs the store checks for each probe file with a `store` block, and
 * looks up the tracked commits on GitHub with $GITHUB_TOKEN when it is set.
 */
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { formatMarkdown, formatText, mcpClient, parseProbeFile, runChecks, tally, type CheckResult, type ProbeFile } from './checks.js';
import { storeConnection } from './store.js';
import { formatCoverage, githubCommits, storeChecks, storeError, type CoverageRow } from './store-checks.js';

async function loadProbeFile(source: string): Promise<ProbeFile> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    return parseProbeFile(await res.text(), source);
  }
  return parseProbeFile(readFileSync(source, 'utf-8'), source);
}

async function runStoreChecks(files: ProbeFile[]): Promise<{ results: CheckResult[]; rows: CoverageRow[] }> {
  const url = process.env.RETRIEVAL_STORE_READ_URL;
  if (!url || !files.some((f) => f.store)) return { results: [], rows: [] };
  const failed = (detail: string) => ({ results: [{ source: 'store', group: 'Store', label: 'connect to the store', status: 'fail' as const, detail }], rows: [] });
  let config;
  try {
    config = storeConnection(url, process.env.RETRIEVAL_STORE_CA_CERT || undefined);
  } catch (e) {
    return failed((e as Error).message);
  }
  const client = new pg.Client({ ...config, connectionTimeoutMillis: 10_000, statement_timeout: 15_000, query_timeout: 20_000 });
  // An idle-connection error would otherwise crash the process with a message that can name the host.
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (e) {
    return failed(storeError(e, 'could not connect'));
  }
  try {
    return await storeChecks(client, files, githubCommits({ token: process.env.GITHUB_TOKEN }));
  } finally {
    await client.end().catch(() => {});
  }
}

export async function main(argv: string[]): Promise<number> {
  const [endpoint, ...sources] = argv;
  if (!endpoint || sources.length === 0) {
    console.error('usage: retrieval-mcp-check <mcp-url> <probe file or URL>...');
    return 2;
  }
  let files: ProbeFile[];
  try {
    files = await Promise.all(sources.map(loadProbeFile));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  console.log(`MCP endpoint: ${endpoint}`);
  const results = await runChecks(mcpClient(endpoint, { bypass: process.env.BYPASS }), files);
  const store = await runStoreChecks(files);
  results.push(...store.results);
  console.log(formatText(results));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${formatMarkdown(results, endpoint)}\n\n${formatCoverage(store.rows)}\n`);
  return tally(results).fail ? 1 : 0;
}

// The bin is a symlink in node_modules/.bin, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
