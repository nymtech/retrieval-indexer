#!/usr/bin/env node
/**
 * retrieval-mcp-check <mcp-url> <probe file or URL>...
 *
 * Runs the probe files against a deployed MCP endpoint and exits 1 if a check
 * fails. A Vercel preview needs its bypass token in $BYPASS. With
 * $GITHUB_STEP_SUMMARY set, it also writes a Markdown summary there.
 */
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { formatMarkdown, formatText, mcpClient, parseProbeFile, runChecks, tally, type ProbeFile } from './checks.js';

async function loadProbeFile(source: string): Promise<ProbeFile> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    return parseProbeFile(await res.text(), source);
  }
  return parseProbeFile(readFileSync(source, 'utf-8'), source);
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
  console.log(formatText(results));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${formatMarkdown(results, endpoint)}\n`);
  return tally(results).fail ? 1 : 0;
}

// The bin is a symlink in node_modules/.bin, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
