// The read side of a store: what an MCP server runs per request. Results keep a
// stable chunk shape, so a caller sees the same result whatever backs the store.

import type { Connection, Modality, StoreChunk } from './store.js';

// Test code stays in the index as a fallback, but a test module must not outrank
// the production code it exercises: a test block can sit lexically closer to a
// query than the implementation it tests. Search subtracts this from the cosine
// score of a chunk flagged `test`. It lives here, not with the chunker, so the
// read side loads no parser.
// Calibrated conservatively on a small query set; raise it if test chunks still
// outrank production code on test-heavy queries.
export const TEST_SCORE_PENALTY = 0.05;

export interface StoreHit {
  chunk: StoreChunk;
  score: number;
}

/**
 * Cosine similarity minus the test-code penalty, kept at 0 or above, best
 * first, `id` breaking ties. Parameters: $1 modality, $2 query vector as
 * pgvector text, $3 penalty, $4 limit, $5 the model the rows must be embedded
 * with. Exported so the private MCP runs the same statement and both endpoints
 * rank alike.
 *
 * The model filter is in this statement, not only in the check before it: each
 * statement reads its own snapshot, so a migration that commits between the two
 * would otherwise rank rows of the new model against a query of the old one.
 */
export const SEARCH_SQL = `
  with scored as (
    select c.id, c.source, c.title, c.heading, c.url, c.text, c.lang, c.tokens_est, c.test,
      1 - (c.embedding <=> $2::vector) - case when c.test then $3::float8 else 0 end as score
    from chunks c join shards s on s.shard = c.shard
    where c.modality = $1 and s.model = $5
  )
  select * from scored where score >= 0 order by score desc, id limit $4`;

interface ChunkRow {
  id: string;
  source: string;
  title: string;
  heading: string;
  url: string;
  text: string;
  lang: string | null;
  tokens_est: number | null;
  test: boolean;
}

/** A row in the chunk shape callers already read: no null fields, no `test: false`. */
function toChunk(row: ChunkRow): StoreChunk {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    heading: row.heading,
    url: row.url,
    text: row.text,
    ...(row.lang !== null && { lang: row.lang }),
    ...(row.tokens_est !== null && { tokensEst: row.tokens_est }),
    ...(row.test && { test: true as const }),
  };
}

/** The model and dimension a modality's rows were embedded with, or null if it has no shard. */
export async function modalityModel(db: Connection, modality: Modality): Promise<{ model: string; dim: number } | null> {
  const { rows } = await db.query<{ model: string; dim: number }>('select model, dim from shards where modality = $1 limit 1', [modality]);
  return rows[0] ?? null;
}

/** The modalities with at least one chunk: a tool is listed only while its modality has one. */
export async function modalities(db: Connection): Promise<Set<Modality>> {
  const { rows } = await db.query<{ modality: Modality }>('select distinct modality from chunks');
  return new Set(rows.map((r) => r.modality));
}

/**
 * Rank a modality's chunks against `queryVector`, which the caller embedded with
 * the modality's model (modalityModel). A vector of another dimension is an
 * error, not an empty result.
 *
 * With `model`, the caller names the model it embedded the query with. Then a
 * modality with no shard, or rows of another model, is an error too: a query
 * from another model with the same dimension would otherwise rank against the
 * wrong space and return confident, wrong neighbours. The check reads the same
 * row as the dimension check, so it costs no extra query.
 *
 * The ranking reads only rows of the model the check saw. If a model migration
 * commits between the check and the ranking, the result is empty for that one
 * query, not neighbours from the other model.
 */
export async function search(
  db: Connection,
  modality: Modality,
  queryVector: number[],
  { topK = 6, model }: { topK?: number; model?: string } = {},
): Promise<StoreHit[]> {
  const embedded = await modalityModel(db, modality);
  if (!embedded) {
    if (model !== undefined) throw new Error(`the store has no ${modality} shard`);
    return [];
  }
  if (model !== undefined && embedded.model !== model) {
    throw new Error(`the store's ${modality} rows are embedded with ${embedded.model}, but the query is embedded with ${model}`);
  }
  if (queryVector.length !== embedded.dim) {
    throw new Error(`a ${queryVector.length}-dim query against ${modality} rows embedded at ${embedded.dim} (${embedded.model})`);
  }
  const { rows } = await db.query<ChunkRow & { score: number }>(SEARCH_SQL, [modality, `[${queryVector.join(',')}]`, TEST_SCORE_PENALTY, topK, embedded.model]);
  return rows.map(({ score, ...row }) => ({ chunk: toChunk(row), score }));
}

/**
 * A whole docs section by chunk id or deep-link URL. An oversized section was
 * split into `id~0`, `id~1`, ... parts with one url; this rejoins them in part
 * order, so a caller gets the section, not a fragment. An id match wins over a
 * url match.
 *
 * Ids are unique only as whole values, so two shards can hold the same base id
 * (one as `x`, another as `x~0`, `x~1`). The parts are taken from one shard: the
 * shard with an exact id match, or else the first shard by name.
 */
export async function getSection(db: Connection, idOrUrl: string): Promise<StoreChunk | null> {
  const select = `select id, shard, source, title, heading, url, text, lang, tokens_est, test from chunks where modality = 'docs' and`;
  type SectionRow = ChunkRow & { shard: string };
  const byId = await db.query<SectionRow>(`${select} (id = $1 or split_part(id, '~', 1) = $1)`, [idOrUrl]);
  const { rows } = byId.rows.length ? byId : await db.query<SectionRow>(`${select} url = $1`, [idOrUrl]);
  if (rows.length === 0) return null;

  const shard = rows.find((r) => r.id === idOrUrl)?.shard ?? rows.map((r) => r.shard).sort()[0]!;
  const part = (id: string) => Number(id.split('~')[1] ?? 0);
  const ordered = rows.filter((r) => r.shard === shard).sort((a, b) => part(a.id) - part(b.id));
  const head = ordered[0]!;
  return { ...toChunk(head), id: head.id.split('~')[0]!, text: ordered.map((r) => r.text).join('\n\n') };
}

export interface StaleShard {
  shard: string;
  reason: string;
}

/**
 * The shards whose last run is older than `maxAgeMs`, or whose source revision
 * is not the one `expectedRevs` names for them (the private store's copy of a
 * public source that has moved on). A shard missing from `expectedRevs` is
 * checked by age only.
 */
export async function staleShards(
  db: Connection,
  { maxAgeMs, expectedRevs = {} }: { maxAgeMs: number; expectedRevs?: Record<string, string> },
): Promise<StaleShard[]> {
  const { rows } = await db.query<{ shard: string; source_rev: string | null; age_ms: number }>(
    'select shard, source_rev, extract(epoch from now() - last_run) * 1000 as age_ms from shards order by shard',
  );
  const stale: StaleShard[] = [];
  for (const r of rows) {
    const age = Number(r.age_ms);
    if (age > maxAgeMs) stale.push({ shard: r.shard, reason: `last run ${Math.round(age / 3_600_000)} h ago` });
    const want = expectedRevs[r.shard];
    if (want !== undefined && want !== r.source_rev) stale.push({ shard: r.shard, reason: `built from ${r.source_rev ?? 'no revision'}, source is at ${want}` });
  }
  return stale;
}
