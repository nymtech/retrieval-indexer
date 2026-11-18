import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { mockProvider } from './embed.js';
import { ensureSchema, indexShard, indexShards, type StoreChunk, type Connection } from './store.js';

const chunk = (id: string, text: string, extra: Partial<StoreChunk> = {}): StoreChunk => ({
  id, source: 'nym-code', title: `src/${id}.rs`, heading: id, url: `https://g/src/${id}.rs#L1`, text, lang: 'rust', ...extra,
});

function countingProvider(model = 'mock') {
  const base = mockProvider({ dim: 4 });
  const state = { texts: 0 };
  return { state, name: base.name, model, dim: base.dim, async embed(texts: string[]) { state.texts += texts.length; return base.embed(texts); } };
}

let db: PGlite;
beforeEach(async () => {
  db = new PGlite({ extensions: { vector } });
  await ensureSchema(db);
});
afterEach(() => db.close());

const rows = async () => (await db.query<{ id: string; url: string; test: boolean }>('select id, url, test from chunks order by id')).rows;

describe('indexShard', () => {
  it('embeds a new shard, then skips unchanged rows, re-embeds a changed one, and deletes a removed one', async () => {
    const first = countingProvider();
    expect(await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A'), chunk('b', 'B'), chunk('c', 'C')], provider: first }))
      .toEqual({ total: 3, embedded: 3, unchanged: 0, deleted: 0 });

    const second = countingProvider();
    const stats = await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A'), chunk('b', 'B changed')], provider: second });
    expect(stats).toEqual({ total: 2, embedded: 1, unchanged: 1, deleted: 1 });
    expect(second.state.texts).toBe(1);
    expect((await rows()).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('updates the url and test flag of an unchanged row without re-embedding it', async () => {
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A')], provider: countingProvider() });
    const p = countingProvider();
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A', { url: 'https://g/src/a.rs#L9', test: true })], provider: p });
    expect(p.state.texts).toBe(0);
    expect(await rows()).toEqual([{ id: 'a', url: 'https://g/src/a.rs#L9', test: true }]);
  });

  it('records the shard with its model and last run', async () => {
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A')], provider: countingProvider(), sourceRev: 'abc123' });
    const { rows: shards } = await db.query<{ shard: string; model: string; dim: number; source_rev: string; last_run: Date }>('select * from shards');
    expect(shards).toHaveLength(1);
    expect(shards[0]).toMatchObject({ shard: 'nym/code', model: 'mock', dim: 4, source_rev: 'abc123' });
    expect(shards[0].last_run).toBeInstanceOf(Date);
  });

  it('refuses an empty run and leaves the shard as it was', async () => {
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A')], provider: countingProvider() });
    await expect(indexShard(db, { repo: 'nym', modality: 'code', chunks: [], provider: countingProvider() })).rejects.toThrow(/no chunks/);
    expect(await rows()).toHaveLength(1);
  });

  it('with maxShrink, refuses a run that drops too many rows before embedding, and lets a smaller drop through', async () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => chunk(id, id.toUpperCase()));
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: five, provider: countingProvider() });

    const refused = countingProvider();
    await expect(indexShard(db, { repo: 'nym', modality: 'code', chunks: [...five.slice(0, 2), chunk('f', 'F')], provider: refused, maxShrink: 0.2 }))
      .rejects.toThrow(/nym\/code: this run has 3 chunks, but the store holds 5/);
    expect(refused.state.texts).toBe(0);
    expect(await rows()).toHaveLength(5);

    expect((await indexShard(db, { repo: 'nym', modality: 'code', chunks: five.slice(0, 4), provider: countingProvider(), maxShrink: 0.2 })).deleted).toBe(1);
    expect((await indexShard(db, { repo: 'nym', modality: 'code', chunks: five.slice(0, 2), provider: countingProvider() })).deleted).toBe(2);
  });

  it('refuses an id another shard owns and writes nothing', async () => {
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A')], provider: countingProvider() });
    await expect(indexShard(db, { repo: 'vpn', modality: 'code', chunks: [chunk('a', 'other'), chunk('z', 'Z')], provider: countingProvider() }))
      .rejects.toThrow(/belong to another shard/);
    expect((await rows()).map((r) => r.id)).toEqual(['a']);
    expect((await db.query('select * from shards')).rows).toHaveLength(1);
  });

  it('refuses a second model in one modality before embedding, and writes nothing', async () => {
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A')], provider: countingProvider('model-1') });
    const p = countingProvider('model-2');
    await expect(indexShard(db, { repo: 'vpn', modality: 'code', chunks: [chunk('vpn/z', 'Z')], provider: p }))
      .rejects.toThrow(/re-embed every code shard together/);
    expect(p.state.texts).toBe(0);
    expect((await rows()).map((r) => r.id)).toEqual(['a']);
    expect((await db.query('select * from shards')).rows).toHaveLength(1);
  });

  it('moves a modality to a new model when every shard of it runs in one call', async () => {
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A')], provider: countingProvider('model-1') });
    await indexShard(db, { repo: 'vpn', modality: 'code', chunks: [chunk('vpn/z', 'Z')], provider: countingProvider('model-1') });
    const stats = await indexShards(db, 'code', [{ repo: 'nym', chunks: [chunk('a', 'A')] }, { repo: 'vpn', chunks: [chunk('vpn/z', 'Z')] }], { provider: countingProvider('model-2') });
    expect([...stats.values()].map((s) => s.embedded)).toEqual([1, 1]);
    const { rows: shards } = await db.query<{ model: string }>('select model from shards order by shard');
    expect(shards.map((r) => r.model)).toEqual(['model-2', 'model-2']);
  });

  it('leaves the rows of other shards alone', async () => {
    await indexShard(db, { repo: 'vpn', modality: 'code', chunks: [chunk('vpn/z', 'Z')], provider: countingProvider() });
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A')], provider: countingProvider() });
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('b', 'B')], provider: countingProvider() });
    expect((await rows()).map((r) => r.id)).toEqual(['b', 'vpn/z']);
  });

  it('refuses a duplicate id within a run', async () => {
    await expect(indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A'), chunk('a', 'B')], provider: countingProvider() }))
      .rejects.toThrow(/appears twice/);
  });

  it('lets another modality use another model', async () => {
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A')], provider: countingProvider('code-model') });
    await expect(indexShard(db, { repo: 'nym', modality: 'docs', chunks: [chunk('page', 'P')], provider: countingProvider('docs-model') })).resolves.toMatchObject({ embedded: 1 });
  });
});

describe('connection guard', () => {
  it('rejects a pg.Pool, which would run begin/lock/commit on different connections', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool();
    await expect(
      indexShard(pool as unknown as Connection, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A')], provider: mockProvider({ dim: 4 }) }),
    ).rejects.toThrow(/not a pg\.Pool/);
    await pool.end();
  });
});
