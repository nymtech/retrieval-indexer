import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { EmbedProvider } from './embed.js';
import { parseProbeFile, type ProbeFile, type StoreDeclaration } from './checks.js';
import { ensureSchema, indexShard, type StoreChunk } from './store.js';
import { formatCoverage, githubCommits, storeChecks, OUTSIDE, WRITE_GRACE_MS, type CommitLookup } from './store-checks.js';

const provider: EmbedProvider = { name: 'fixed', model: 'fixed', dim: 2, embed: async (texts) => texts.map(() => [1, 0]) };
const code = (path: string, n = 0): StoreChunk => ({ id: `${path}#${n}`, source: 'nym-code', title: path, heading: path, url: `https://github.com/nymtech/nym/blob/develop/${path}#L1`, text: `${path} ${n}` });
const doc = (id: string): StoreChunk => ({ id, source: 'nym-docs', title: 'Page', heading: id, url: `https://nym.com/docs/${id}`, text: id });

const NOW = Date.parse('2026-11-26T12:00:00Z');
const HEAD = 'a'.repeat(40);
const commits = (since = new Date(NOW - 2 * WRITE_GRACE_MS)): CommitLookup => ({
  branchHead: async (_github, branch) => ({ ref: branch, sha: HEAD, since }),
  latestRelease: async () => ({ ref: 'nym-vpn-v2026.16.1', sha: HEAD, since }),
});
const store: StoreDeclaration = { repo: 'nym', github: 'nymtech/nym', tracks: { branch: 'develop' }, roots: ['sdk/rust', 'clients/native'] };
const file = (s: Partial<StoreDeclaration> = {}): ProbeFile => ({ version: 1, name: 'nym', store: { ...store, ...s }, probes: [] });

let db: PGlite;
beforeEach(async () => {
  db = new PGlite({ extensions: { vector } });
  await ensureSchema(db);
});
afterEach(() => db.close());

async function write(sourceRev: string, codeChunks: StoreChunk[], docsChunks: StoreChunk[] = [doc('intro')]) {
  await indexShard(db, { repo: 'nym', modality: 'docs', chunks: docsChunks, provider, sourceRev });
  await indexShard(db, { repo: 'nym', modality: 'code', chunks: codeChunks, provider, sourceRev });
}

const byLabel = (results: { label: string; status: string; detail?: string }[]) => Object.fromEntries(results.map((r) => [r.label, r]));

describe('storeChecks: freshness', () => {
  it('passes each shard built from the tracked commit', async () => {
    await write(HEAD, [code('sdk/rust/lib.rs'), code('clients/native/main.rs')]);
    const { results } = await storeChecks(db, [file()], commits(), NOW);
    const fresh = results.filter((r) => r.group === 'Store freshness');
    expect(fresh.map((r) => [r.label, r.status])).toEqual([['nym/code is built from develop', 'pass'], ['nym/docs is built from develop', 'pass']]);
  });

  it('fails a shard built from another commit once the write has had time to run', async () => {
    await write('b'.repeat(40), [code('sdk/rust/lib.rs'), code('clients/native/main.rs')]);
    const r = byLabel((await storeChecks(db, [file()], commits(), NOW)).results)['nym/code is built from develop'];
    expect(r?.status).toBe('fail');
    expect(r?.detail).toContain('built from bbbbbbbbbb, develop is at aaaaaaaaaa');
  });

  it('only notes the mismatch while the write for a new commit may still run', async () => {
    await write('b'.repeat(40), [code('sdk/rust/lib.rs'), code('clients/native/main.rs')]);
    const r = byLabel((await storeChecks(db, [file()], commits(new Date(NOW - 60_000)), NOW)).results)['nym/code is built from develop'];
    expect(r?.status).toBe('note');
  });

  it('checks a release-tracking producer against the newest release', async () => {
    await write(HEAD, [code('sdk/rust/lib.rs'), code('clients/native/main.rs')]);
    const r = byLabel((await storeChecks(db, [file({ tracks: { release: 'latest' } })], commits(), NOW)).results)['nym/code is built from nym-vpn-v2026.16.1'];
    expect(r?.status).toBe('pass');
  });

  it('fails when the store holds no shard for the repo', async () => {
    const { results } = await storeChecks(db, [file({ repo: 'nym-vpn-client' })], commits(), NOW);
    expect(byLabel(results)['the store holds nym-vpn-client shards']?.status).toBe('fail');
  });

  it('fails when the tracked commit cannot be looked up', async () => {
    const broken: CommitLookup = { ...commits(), branchHead: async () => { throw new Error('GitHub /repos/nymtech/nym/commits/develop: HTTP 404'); } };
    const { results } = await storeChecks(db, [file()], broken, NOW);
    expect(results[0]).toMatchObject({ status: 'fail', detail: 'GitHub /repos/nymtech/nym/commits/develop: HTTP 404' });
  });
});

describe('storeChecks: coverage', () => {
  it('counts the chunks under each root and gives a docs shard one row', async () => {
    await write(HEAD, [code('sdk/rust/lib.rs', 0), code('sdk/rust/lib.rs', 1), code('clients/native/main.rs')]);
    const { results, rows } = await storeChecks(db, [file()], commits(), NOW);
    expect(rows).toEqual([
      { shard: 'nym/code', root: 'sdk/rust', chunks: 2 },
      { shard: 'nym/code', root: 'clients/native', chunks: 1 },
      { shard: 'nym/code', root: OUTSIDE, chunks: 0 },
      { shard: 'nym/docs', root: '(all)', chunks: 1 },
    ]);
    expect(results.filter((r) => r.status !== 'pass')).toEqual([]);
  });

  it('fails a declared root with no chunks', async () => {
    await write(HEAD, [code('sdk/rust/lib.rs')]);
    const r = byLabel((await storeChecks(db, [file()], commits(), NOW)).results)['nym/code clients/native: 0 chunks'];
    expect(r?.status).toBe('fail');
  });

  it('fails chunks outside every declared root, and does not count a root by its prefix alone', async () => {
    await write(HEAD, [code('sdk/rust/lib.rs'), code('clients/native/main.rs'), code('clients/native-extra/main.rs')]);
    const r = byLabel((await storeChecks(db, [file()], commits(), NOW)).results)['nym/code: every chunk is under a declared root'];
    expect(r?.status).toBe('fail');
    expect(r?.detail).toContain('1 chunks under no root, for example clients/native-extra/main.rs');
  });

  it('skips a probe file with no store block', async () => {
    expect(await storeChecks(db, [{ version: 1, name: 'nym', probes: [] }], commits(), NOW)).toEqual({ results: [], rows: [] });
  });
});

describe('storeChecks: errors', () => {
  it('reports a store error by its code, never its message', async () => {
    const failing = { query: async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:21699'), { code: 'ECONNREFUSED' }); } };
    const { results } = await storeChecks(failing, [file()], commits(), NOW);
    expect(results.map((r) => r.detail).join(' ')).not.toContain('10.1.2.3');
    expect(results[0]).toMatchObject({ status: 'fail', detail: 'the store query failed (ECONNREFUSED)' });
  });
});

describe('parseProbeFile: store', () => {
  const parse = (s: unknown) => parseProbeFile(JSON.stringify({ version: 1, name: 'nym', store: s, probes: [{ label: 'x', tool: 't', isError: false }] }), 'f.json');

  it('reads a valid block', () => {
    expect(parse(store).store).toEqual(store);
    expect(parse({ ...store, tracks: { release: 'latest' } }).store?.tracks).toEqual({ release: 'latest' });
  });

  it.each([
    [{ ...store, repo: '' }, '"repo"'],
    [{ ...store, github: 'nym' }, '"github"'],
    [{ ...store, tracks: { release: 'newest' } }, '"tracks"'],
    [{ ...store, tracks: { branch: 'develop', release: 'latest' } }, '"tracks"'],
    [{ ...store, roots: [] }, '"roots"'],
  ])('rejects %j', (s, field) => {
    expect(() => parse(s)).toThrow(field);
  });
});

describe('githubCommits', () => {
  it('resolves the newest release to its tag commit, with the token', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
      const body = url.endsWith('/releases/latest')
        ? { tag_name: 'nym-vpn-v2026.16.1', published_at: '2026-11-20T10:00:00Z' }
        : { sha: HEAD, commit: { committer: { date: '2026-11-19T09:00:00Z' } } };
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const got = await githubCommits({ token: 't', fetchImpl }).latestRelease('nymtech/nym-vpn-client');
    expect(got).toEqual({ ref: 'nym-vpn-v2026.16.1', sha: HEAD, since: new Date('2026-11-20T10:00:00Z') });
    expect(seen).toEqual([
      'https://api.github.com/repos/nymtech/nym-vpn-client/releases/latest Bearer t',
      'https://api.github.com/repos/nymtech/nym-vpn-client/commits/nym-vpn-v2026.16.1 Bearer t',
    ]);
  });

  it('throws on an HTTP error', async () => {
    const fetchImpl = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(githubCommits({ fetchImpl }).branchHead('nymtech/nym', 'develop')).rejects.toThrow('GitHub /repos/nymtech/nym/commits/develop: HTTP 404');
  });
});

describe('formatCoverage', () => {
  it('prints one table row per shard and root, and nothing for no rows', () => {
    expect(formatCoverage([{ shard: 'nym/code', root: 'sdk/rust', chunks: 2 }])).toBe('### Store coverage\n\n| Shard | Root | Chunks |\n|---|---|---:|\n| nym/code | sdk/rust | 2 |');
    expect(formatCoverage([])).toBe('');
  });
});
