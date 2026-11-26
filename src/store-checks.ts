/**
 * Checks of the store itself, beside the probes: is each producer's shard built
 * from the commit it tracks, and does each declared code root hold chunks. A
 * probe file declares what its producer writes in its `store` block.
 *
 * The output is public (CI logs), so a store error is reported by its code only:
 * a driver message can name the host or its address.
 */
import type { CheckResult, ProbeFile, StoreDeclaration } from './checks.js';
import type { Connection } from './store.js';

/** A commit a producer's shards should be built from, and when it appeared. */
export interface ExpectedCommit {
  /** `develop` or the release tag, for the messages. */
  ref: string;
  sha: string;
  /** When the commit reached the branch, or when the release was published. */
  since: Date;
}

/** Looks up the commit each `tracks` value names on GitHub. */
export interface CommitLookup {
  branchHead(github: string, branch: string): Promise<ExpectedCommit>;
  latestRelease(github: string): Promise<ExpectedCommit>;
}

export interface CoverageRow {
  shard: string;
  /** A code root, `(outside every root)`, or `(all)` for a docs shard. */
  root: string;
  chunks: number;
}

/** A write that started after the commit may still be running inside this window. */
export const WRITE_GRACE_MS = 2 * 60 * 60 * 1000;
export const OUTSIDE = '(outside every root)';

const short = (sha: string | null) => (sha ? sha.slice(0, 10) : 'no revision');

/** The store error's code (`ENOTFOUND`, `28P01`), never its message. */
export function storeError(e: unknown, failure = 'the store query failed'): string {
  const code = (e as { code?: unknown })?.code;
  return `${failure} (${typeof code === 'string' && code ? code : 'no error code'})`;
}

export function githubCommits({ token, fetchImpl = fetch }: { token?: string; fetchImpl?: typeof fetch } = {}): CommitLookup {
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  type Commit = { sha: string; commit: { committer: { date: string } } };
  return {
    async branchHead(github, branch) {
      const c = await get<Commit>(`/repos/${github}/commits/${encodeURIComponent(branch)}`);
      return { ref: branch, sha: c.sha, since: new Date(c.commit.committer.date) };
    },
    async latestRelease(github) {
      const r = await get<{ tag_name: string; published_at: string }>(`/repos/${github}/releases/latest`);
      const c = await get<Commit>(`/repos/${github}/commits/${encodeURIComponent(r.tag_name)}`);
      return { ref: r.tag_name, sha: c.sha, since: new Date(r.published_at) };
    },
  };
}

async function freshness(db: Connection, file: ProbeFile, store: StoreDeclaration, commits: CommitLookup, now: number): Promise<CheckResult[]> {
  const base = { source: file.name, group: 'Store freshness' };
  let expected: ExpectedCommit;
  try {
    expected = 'branch' in store.tracks ? await commits.branchHead(store.github, store.tracks.branch) : await commits.latestRelease(store.github);
  } catch (e) {
    return [{ ...base, label: `look up the commit ${store.github} tracks`, status: 'fail', detail: (e as Error).message }];
  }
  let shards: { shard: string; source_rev: string | null }[];
  try {
    ({ rows: shards } = await db.query<{ shard: string; source_rev: string | null }>('select shard, source_rev from shards where repo = $1 order by shard', [store.repo]));
  } catch (e) {
    return [{ ...base, label: `read the ${store.repo} shards`, status: 'fail', detail: storeError(e) }];
  }
  if (shards.length === 0) return [{ ...base, label: `the store holds ${store.repo} shards`, status: 'fail', detail: `no shard has repo ${store.repo}` }];
  const young = now - expected.since.getTime() < WRITE_GRACE_MS;
  return shards.map(({ shard, source_rev }) => {
    const label = `${shard} is built from ${expected.ref}`;
    if (source_rev === expected.sha) return { ...base, label, status: 'pass' as const };
    const detail = `built from ${short(source_rev)}, ${expected.ref} is at ${short(expected.sha)} since ${expected.since.toISOString()}`;
    // A write for a new commit takes minutes, so a mismatch is only a note at first.
    return { ...base, label, status: young ? ('note' as const) : ('fail' as const), detail: young ? `${detail}; the write may still be running` : detail };
  });
}

async function coverage(db: Connection, file: ProbeFile, store: StoreDeclaration): Promise<{ results: CheckResult[]; rows: CoverageRow[] }> {
  const base = { source: file.name, group: 'Store coverage' };
  let counts: { shard: string; modality: string; title: string; n: number }[];
  try {
    ({ rows: counts } = await db.query<{ shard: string; modality: string; title: string; n: number }>(
      'select shard, modality, title, count(*)::int as n from chunks where repo = $1 group by shard, modality, title',
      [store.repo],
    ));
  } catch (e) {
    return { results: [{ ...base, label: `count the ${store.repo} chunks`, status: 'fail', detail: storeError(e) }], rows: [] };
  }
  const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  const rows: CoverageRow[] = [];
  const results: CheckResult[] = [];
  const shards = [...new Set(counts.map((c) => c.shard))].sort();
  const codeShards = shards.filter((s) => counts.some((c) => c.shard === s && c.modality === 'code'));
  if (codeShards.length === 0) results.push({ ...base, label: `the store holds a ${store.repo} code shard`, status: 'fail', detail: `no code chunks for repo ${store.repo}` });
  for (const shard of shards) {
    const mine = counts.filter((c) => c.shard === shard);
    if (!codeShards.includes(shard)) {
      const total = mine.reduce((n, c) => n + c.n, 0);
      rows.push({ shard, root: '(all)', chunks: total });
      results.push({ ...base, label: `${shard}: ${total} chunks`, status: total > 0 ? 'pass' : 'fail' });
      continue;
    }
    for (const root of store.roots) {
      const total = mine.filter((c) => under(c.title, root)).reduce((n, c) => n + c.n, 0);
      rows.push({ shard, root, chunks: total });
      results.push({ ...base, label: `${shard} ${root}: ${total} chunks`, status: total > 0 ? 'pass' : 'fail', ...(total > 0 ? {} : { detail: 'a declared root with no chunks' }) });
    }
    const outside = mine.filter((c) => !store.roots.some((root) => under(c.title, root)));
    const total = outside.reduce((n, c) => n + c.n, 0);
    rows.push({ shard, root: OUTSIDE, chunks: total });
    if (total > 0) {
      const files = outside.slice(0, 3).map((c) => c.title).join(', ');
      results.push({ ...base, label: `${shard}: every chunk is under a declared root`, status: 'fail', detail: `${total} chunks under no root, for example ${files}; the probe file's roots differ from the write's` });
    } else {
      results.push({ ...base, label: `${shard}: every chunk is under a declared root`, status: 'pass' });
    }
  }
  return { results, rows };
}

/** The freshness and coverage checks for each probe file with a `store` block. */
export async function storeChecks(
  db: Connection,
  files: ProbeFile[],
  commits: CommitLookup,
  now = Date.now(),
): Promise<{ results: CheckResult[]; rows: CoverageRow[] }> {
  const results: CheckResult[] = [];
  const rows: CoverageRow[] = [];
  for (const file of files) {
    if (!file.store) continue;
    results.push(...(await freshness(db, file, file.store, commits, now)));
    const map = await coverage(db, file, file.store);
    results.push(...map.results);
    rows.push(...map.rows);
  }
  return { results, rows };
}

export function formatCoverage(rows: CoverageRow[]): string {
  if (rows.length === 0) return '';
  const lines = ['### Store coverage', '', '| Shard | Root | Chunks |', '|---|---|---:|'];
  for (const r of rows) lines.push(`| ${r.shard} | ${r.root} | ${r.chunks} |`);
  return lines.join('\n');
}
