// Postgres + pgvector store for retrieval shards.
//
// A shard is the chunks one producer writes for one repo and one modality. A run
// replaces its shard: a row whose hash is unchanged keeps its vector, a changed
// or new row is embedded and upserted, and a row the run no longer produces is
// deleted, all in one transaction. Embedding happens before the transaction
// opens, so minutes of embed calls never hold a transaction open.
//
// Ids are unique within a store. A single-producer store can keep unprefixed
// ids; any producer sharing a store sets `repo` on chunkCodeFile so its ids
// cannot collide with another producer's.

import { readdir, readFile } from 'node:fs/promises';
import { chunkHash, embedChunks, type EmbedProvider, type Embeddable } from './embed.js';

/**
 * One database connection: a pg `Client`, a client checked out of a pg `Pool`,
 * or PGlite. Never a `Pool` itself: a pool may run BEGIN, the writes, and COMMIT
 * on different connections, which silently drops the one-transaction guarantee.
 */
export interface Connection {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type Modality = 'docs' | 'code';

export interface StoreChunk extends Embeddable {
  id: string;
  source: string;
  title: string;
  heading: string;
  url: string;
  lang?: string;
  tokensEst?: number;
  test?: true;
}

export interface ShardStats {
  total: number;
  embedded: number;
  unchanged: number;
  deleted: number;
}

const MIGRATIONS = new URL('../migrations/', import.meta.url);

/**
 * Apply the up section of every migration, in file order, to a PGlite or
 * throwaway local store. It records nothing, so a shared store uses
 * node-pg-migrate (`pnpm migrate up`) instead: once a migration is not
 * idempotent, a second ensureSchema run fails or changes data.
 */
export async function ensureSchema(db: Connection): Promise<void> {
  const files = (await readdir(MIGRATIONS)).sort();
  for (const file of files) {
    // node-pg-migrate loads any other file as a JavaScript migration and fails.
    if (!file.endsWith('.sql')) throw new Error(`migrations/${file} is not a .sql file`);
    for (const statement of upStatements(file, await readFile(new URL(file, MIGRATIONS), 'utf8'))) {
      await db.query(statement);
    }
  }
}

// The section markers match as node-pg-migrate matches them (getActions in its
// sqlMigration.js): any case, any run of dashes and spaces after `--`.
const marker = (direction: 'up' | 'down') => new RegExp(`^\\s*--[\\s-]*${direction}\\s+migration`, 'im');

// PGlite's query takes one statement, so the up section is split on a semicolon
// at a line end. A function body ($$ ... $$) with such a semicolon would break
// this; no migration has one. A file with no up marker throws here, where
// node-pg-migrate would run the whole file as its up section.
function upStatements(file: string, sql: string): string[] {
  const start = sql.search(marker('up'));
  if (start < 0) throw new Error(`migrations/${file} has no "-- Up Migration" marker`);
  const end = sql.search(marker('down'));
  return sql
    .slice(start, end > start ? end : undefined)
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement.replace(/^--.*$/gm, '').trim() !== '');
}

// Rows per write statement. Each row carries its vector as text (about 12 KB at
// 1024 dimensions), so a whole shard in one statement would be a parameter of
// tens of MB.
const ROWS_PER_STATEMENT = 500;

// One lock for the whole store, not one per shard: the id and model checks span
// shards, so two producers writing at once must not both pass them.
const STORE_LOCK = 'retrieval-store';

const inBatches = <T>(xs: T[]): T[][] =>
  Array.from({ length: Math.ceil(xs.length / ROWS_PER_STATEMENT) }, (_, i) => xs.slice(i * ROWS_PER_STATEMENT, (i + 1) * ROWS_PER_STATEMENT));

const sameHashes = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([id, h]) => b.get(id) === h);

async function shardHashes(db: Connection, shard: string): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; content_hash: string }>('select id, content_hash from chunks where shard = $1', [shard]);
  return new Map(rows.map((r) => [r.id, r.content_hash]));
}

export interface ShardRun {
  repo: string;
  chunks: StoreChunk[];
  /** the source commit: the model-independent freshness signal */
  sourceRev?: string | null;
}

interface Plan extends ShardRun {
  shard: string;
  before: Map<string, string>;
  hashes: Map<string, string>;
  changed: StoreChunk[];
  unchanged: StoreChunk[];
}

/** Throw if another shard of `modality`, outside this call, uses a different model or dimension. */
async function checkModel(db: Connection, modality: Modality, shards: string[], provider: EmbedProvider): Promise<void> {
  const { rows } = await db.query<{ shard: string; model: string; dim: number }>(
    'select shard, model, dim from shards where modality = $1 and shard <> all($2::text[]) and (model <> $3 or dim <> $4)',
    [modality, shards, provider.model, provider.dim],
  );
  if (rows.length === 0) return;
  const others = rows.map((r) => `${r.shard} (${r.model}, ${r.dim})`).join(', ');
  throw new Error(`${provider.model} (${provider.dim}) differs from the ${modality} model of ${others}; re-embed every ${modality} shard together in one indexShards call`);
}

/** Throw if a chunk id of a run is stored under any other shard. */
async function checkIds(db: Connection, plans: Plan[]): Promise<void> {
  const ids = plans.flatMap((p) => p.chunks.map((c) => c.id));
  const owners = plans.flatMap((p) => p.chunks.map(() => p.shard));
  const { rows } = await db.query<{ id: string; shard: string; wanted: string }>(
    `select c.id, c.shard, v.shard as wanted from chunks c join unnest($1::text[], $2::text[]) as v(id, shard) on c.id = v.id
     where c.shard <> v.shard`,
    [ids, owners],
  );
  if (rows.length === 0) return;
  const sample = rows.slice(0, 5).map((r) => `${r.id} (owned by ${r.shard}, wanted by ${r.wanted})`).join(', ');
  throw new Error(`${rows.length} chunk id(s) belong to another shard, e.g. ${sample}; give the producer's ids a repo prefix`);
}

/**
 * Replace the shards `<repo>/<modality>` of `runs` with their chunks, in one
 * transaction, all embedded with `provider`. Several runs in one call are how a
 * modality moves to a new model: every shard of it re-embeds and commits
 * together, so the store never holds two models for one modality.
 *
 * Throws, and writes nothing, on an empty run, a duplicate id, an id another
 * shard owns, a model or dimension that differs from a shard of the same
 * modality outside the call, or a shard that another run changed while this one
 * was embedding. The id and model checks run once before embedding, so a
 * misconfigured producer fails before it pays for an embed, and again under the
 * lock.
 *
 * With `maxShrink`, it also throws on a run that has fewer than
 * `(1 - maxShrink)` of the rows its shard holds: a lost content directory or a
 * broken walk would otherwise delete that part of the index. The check counts
 * the baseline that the lock later proves unchanged, so no other writer can
 * commit between the count and the write.
 */
export async function indexShards(
  db: Connection,
  modality: Modality,
  runs: ShardRun[],
  { provider, concurrency, maxShrink }: { provider: EmbedProvider; concurrency?: number; maxShrink?: number },
): Promise<Map<string, ShardStats>> {
  // A pg.Pool satisfies Connection structurally but runs each statement on its
  // own pooled connection, so begin, the advisory lock, and commit would not
  // share one, silently voiding the single-transaction guarantee. Only a Pool
  // has totalCount.
  if ('totalCount' in db) throw new Error('indexShards needs a single connection (pg.Client or PGlite), not a pg.Pool: begin, the advisory lock, and commit must share one connection');
  const seen = new Set<string>();
  for (const run of runs) {
    const shard = `${run.repo}/${modality}`;
    // With no ids the stale delete would empty the shard.
    if (run.chunks.length === 0) throw new Error(`shard ${shard}: the run produced no chunks; refusing to empty the shard`);
    for (const c of run.chunks) {
      if (seen.has(c.id)) throw new Error(`shard ${shard}: chunk id ${c.id} appears twice in this call`);
      seen.add(c.id);
    }
  }

  const plans: Plan[] = [];
  for (const run of runs) {
    const shard = `${run.repo}/${modality}`;
    const before = await shardHashes(db, shard);
    if (maxShrink !== undefined && run.chunks.length < before.size * (1 - maxShrink)) {
      throw new Error(`shard ${shard}: this run has ${run.chunks.length} chunks, but the store holds ${before.size}; refusing to delete ${before.size - run.chunks.length} rows`);
    }
    const hashes = new Map(run.chunks.map((c) => [c.id, chunkHash(c, provider)]));
    plans.push({
      ...run,
      shard,
      before,
      hashes,
      changed: run.chunks.filter((c) => before.get(c.id) !== hashes.get(c.id)),
      unchanged: run.chunks.filter((c) => before.get(c.id) === hashes.get(c.id)),
    });
  }
  const shards = plans.map((p) => p.shard);
  await checkModel(db, modality, shards, provider);
  await checkIds(db, plans);

  const { embedded } = await embedChunks(plans.flatMap((p) => p.changed), provider, new Map(), { concurrency });
  const vectors = new Map(embedded.map((c) => [c.id, c.vector]));

  await db.query('begin');
  try {
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [STORE_LOCK]);
    for (const plan of plans) {
      if (!sameHashes(plan.before, await shardHashes(db, plan.shard))) {
        throw new Error(`shard ${plan.shard}: another run changed it while this one was embedding; run again`);
      }
    }
    await checkModel(db, modality, shards, provider);
    await checkIds(db, plans);

    const stats = new Map<string, ShardStats>();
    for (const plan of plans) stats.set(plan.shard, await writeShard(db, modality, plan, provider, vectors));
    await db.query('commit');
    return stats;
  } catch (error) {
    // A failed rollback must not hide the error that caused it.
    await db.query('rollback').catch(() => {});
    throw error;
  }
}

/** Replace one shard. A thin form of indexShards for the common single-producer run. */
export async function indexShard(
  db: Connection,
  { repo, modality, chunks, provider, sourceRev = null, concurrency, maxShrink }: {
    repo: string;
    modality: Modality;
    chunks: StoreChunk[];
    provider: EmbedProvider;
    sourceRev?: string | null;
    concurrency?: number;
    maxShrink?: number;
  },
): Promise<ShardStats> {
  const stats = await indexShards(db, modality, [{ repo, chunks, sourceRev }], { provider, concurrency, maxShrink });
  return stats.get(`${repo}/${modality}`)!;
}

async function writeShard(db: Connection, modality: Modality, plan: Plan, provider: EmbedProvider, vectors: Map<string, number[]>): Promise<ShardStats> {
  const { shard, repo, hashes } = plan;
  await db.query(
    `insert into shards (shard, repo, modality, model, dim, source_rev, last_run) values ($1, $2, $3, $4, $5, $6, now())
     on conflict (shard) do update set model = excluded.model, dim = excluded.dim, source_rev = excluded.source_rev, last_run = excluded.last_run`,
    [shard, repo, modality, provider.model, provider.dim, plan.sourceRev ?? null],
  );

  for (const batch of inBatches(plan.changed)) {
    await db.query(
      `insert into chunks (id, shard, repo, modality, source, title, heading, url, text, lang, tokens_est, test, content_hash, embedding)
       select v.id, $1, $2, $3, v.source, v.title, v.heading, v.url, v.text, v.lang, v.tokens_est, v.test, v.content_hash, v.embedding::vector
       from unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::int[], $12::bool[], $13::text[], $14::text[])
         as v(id, source, title, heading, url, text, lang, tokens_est, test, content_hash, embedding)
       on conflict (id) do update set
         source = excluded.source, title = excluded.title, heading = excluded.heading, url = excluded.url, text = excluded.text,
         lang = excluded.lang, tokens_est = excluded.tokens_est, test = excluded.test,
         content_hash = excluded.content_hash, embedding = excluded.embedding`,
      [
        shard, repo, modality,
        batch.map((c) => c.id), batch.map((c) => c.source), batch.map((c) => c.title), batch.map((c) => c.heading),
        batch.map((c) => c.url), batch.map((c) => c.text), batch.map((c) => c.lang ?? null), batch.map((c) => c.tokensEst ?? null),
        batch.map((c) => c.test === true), batch.map((c) => hashes.get(c.id)), batch.map((c) => `[${vectors.get(c.id)!.join(',')}]`),
      ],
    );
  }

  // The hash covers only the embedded text, so an unchanged row can still have
  // moved: a code chunk shifted down a file keeps its text and gets a new `#L`
  // url. Only rows whose metadata differs are written.
  for (const batch of inBatches(plan.unchanged)) {
    await db.query(
      `update chunks c set source = v.source, title = v.title, heading = v.heading, url = v.url,
         lang = v.lang, tokens_est = v.tokens_est, test = v.test
       from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int[], $9::bool[])
         as v(id, source, title, heading, url, lang, tokens_est, test)
       where c.id = v.id and c.shard = $1
         and (c.source, c.title, c.heading, c.url, c.lang, c.tokens_est, c.test)
           is distinct from (v.source, v.title, v.heading, v.url, v.lang, v.tokens_est, v.test)`,
      [
        shard,
        batch.map((c) => c.id), batch.map((c) => c.source), batch.map((c) => c.title), batch.map((c) => c.heading),
        batch.map((c) => c.url), batch.map((c) => c.lang ?? null), batch.map((c) => c.tokensEst ?? null), batch.map((c) => c.test === true),
      ],
    );
  }

  const deleted = await db.query('delete from chunks where shard = $1 and id <> all($2::text[]) returning id', [shard, plan.chunks.map((c) => c.id)]);
  return { total: plan.chunks.length, embedded: plan.changed.length, unchanged: plan.unchanged.length, deleted: deleted.rows.length };
}
