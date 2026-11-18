import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { EmbedProvider } from './embed.js';
import { getSection, modalities, modalityModel, search, staleShards, TEST_SCORE_PENALTY } from './search.js';
import { ensureSchema, indexShard, type StoreChunk } from './store.js';

// Each chunk's text names its vector, so a test controls every score. The text
// is the last line of what embedChunks sends (title, heading, then text).
const VECTORS: Record<string, number[]> = {
  north: [0, 1, 0],
  'north-east': [0.6, 0.8, 0],
  east: [1, 0, 0],
  'east-ish': [0.95, 0.31, 0],
  'east-test': [1, 0.02, 0],
  'barely-east': [0.04, 0, 0.999],
  south: [0, -1, 0],
};
const fixed = (model = 'fixed'): EmbedProvider => ({
  name: 'fixed',
  model,
  dim: 3,
  async embed(texts) {
    return texts.map((t) => {
      const v = VECTORS[t.split('\n').pop()!];
      if (!v) throw new Error(`no fixture vector for ${t}`);
      return v;
    });
  },
});

const doc = (id: string, text: string, extra: Partial<StoreChunk> = {}): StoreChunk => ({
  id, source: 'nym-docs', title: 'Page', heading: id, url: `https://d/${id}`, text, tokensEst: 3, ...extra,
});
const code = (id: string, text: string, extra: Partial<StoreChunk> = {}): StoreChunk => ({
  id, source: 'nym-code', title: `src/${id}.rs`, heading: id, url: `https://g/src/${id}.rs#L1`, text, lang: 'rust', ...extra,
});

const cosine = (a: number[], b: number[]) => {
  const dot = a.reduce((s, x, i) => s + x * b[i]!, 0);
  const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return dot / (norm(a) * norm(b));
};

let db: PGlite;
beforeEach(async () => {
  db = new PGlite({ extensions: { vector } });
  await ensureSchema(db);
});
afterEach(() => db.close());

describe('search', () => {
  it('ranks by cosine, best first, below-zero dropped, topK', async () => {
    const chunks = [doc('n', 'north'), doc('ne', 'north-east'), doc('e', 'east'), doc('ei', 'east-ish'), doc('s', 'south')];
    await indexShard(db, { repo: 'nym', modality: 'docs', chunks, provider: fixed() });
    const q = [1, 0.1, 0];

    const reference = chunks
      .map((c) => ({ id: c.id, score: cosine(q, VECTORS[c.text]!) }))
      .filter((h) => h.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    const hits = await search(db, 'docs', q, { topK: 3 });

    expect(hits.map((h) => h.chunk.id)).toEqual(reference.map((h) => h.id));
    hits.forEach((h, i) => expect(h.score).toBeCloseTo(reference[i]!.score, 6));
  });

  it('returns chunks in the shape callers read: no null fields, no test flag on production code', async () => {
    await indexShard(db, { repo: 'nym', modality: 'docs', chunks: [doc('e', 'east')], provider: fixed() });
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [code('c', 'east')], provider: fixed() });
    expect((await search(db, 'docs', [1, 0, 0]))[0]!.chunk).toEqual(doc('e', 'east'));
    expect((await search(db, 'code', [1, 0, 0]))[0]!.chunk).toEqual(code('c', 'east'));
  });

  it('ranks a test chunk below production code it would beat, and drops one the penalty takes below zero', async () => {
    await indexShard(db, {
      repo: 'nym', modality: 'code', provider: fixed(),
      chunks: [code('prod', 'east-ish'), code('t', 'east-test', { test: true }), code('weak', 'barely-east', { test: true })],
    });
    const hits = await search(db, 'code', [1, 0, 0]);
    expect(hits.map((h) => h.chunk.id)).toEqual(['prod', 't']);
    expect(hits[1]!.chunk.test).toBe(true);
    expect(hits[1]!.score).toBeCloseTo(cosine([1, 0, 0], VECTORS['east-test']!) - TEST_SCORE_PENALTY, 6);
  });

  it('searches one modality only', async () => {
    await indexShard(db, { repo: 'nym', modality: 'docs', chunks: [doc('d', 'east')], provider: fixed() });
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [code('c', 'east')], provider: fixed() });
    expect((await search(db, 'code', [1, 0, 0])).map((h) => h.chunk.id)).toEqual(['c']);
  });

  it('refuses a query vector of another dimension', async () => {
    await indexShard(db, { repo: 'nym', modality: 'docs', chunks: [doc('e', 'east')], provider: fixed() });
    await expect(search(db, 'docs', [1, 0])).rejects.toThrow(/2-dim query against docs rows embedded at 3/);
  });

  it('returns nothing for a modality with no shard', async () => {
    expect(await search(db, 'code', [1, 0, 0])).toEqual([]);
  });

  it('with a model, refuses a modality with no shard instead of returning nothing', async () => {
    await expect(search(db, 'code', [1, 0, 0], { model: 'fixed' })).rejects.toThrow(/has no code shard/);
  });

  it('with a model, refuses rows of another model of the same dimension', async () => {
    await indexShard(db, { repo: 'nym', modality: 'docs', chunks: [doc('e', 'east')], provider: fixed('other') });
    await expect(search(db, 'docs', [1, 0, 0], { model: 'fixed' })).rejects.toThrow(/embedded with other, but the query is embedded with fixed/);
  });

  it('with the matching model, ranks as without one', async () => {
    await indexShard(db, { repo: 'nym', modality: 'docs', chunks: [doc('e', 'east')], provider: fixed() });
    expect((await search(db, 'docs', [1, 0, 0], { model: 'fixed' })).map((h) => h.chunk.id)).toEqual(['e']);
  });
});

describe('getSection', () => {
  const parts = Array.from({ length: 12 }, (_, i) => doc(`page#install~${i}`, 'east', { heading: 'Install', url: 'https://d/page#install' }));
  // Each part needs its own text for the join to be checked, and every text a vector.
  for (const [i, p] of parts.entries()) {
    p.text = `part ${i}`;
    VECTORS[p.text] = [1, 0, 0];
  }

  it('rejoins a split section in numeric part order, so ~10 comes after ~9', async () => {
    await indexShard(db, { repo: 'nym', modality: 'docs', chunks: [...parts].reverse(), provider: fixed() });
    const section = await getSection(db, 'page#install');
    expect(section?.id).toBe('page#install');
    expect(section?.text).toBe(parts.map((p) => p.text).join('\n\n'));
  });

  it('falls back to the url, and returns one part when asked for it by its own id', async () => {
    await indexShard(db, { repo: 'nym', modality: 'docs', chunks: parts, provider: fixed() });
    expect((await getSection(db, 'https://d/page#install'))?.text).toBe(parts.map((p) => p.text).join('\n\n'));
    expect(await getSection(db, 'page#install~3')).toMatchObject({ id: 'page#install', text: 'part 3' });
  });

  it('takes the parts of a section from one shard when two shards share a base id', async () => {
    VECTORS['nym text'] = [1, 0, 0];
    VECTORS['vpn part 0'] = [1, 0, 0];
    VECTORS['vpn part 1'] = [1, 0, 0];
    await indexShard(db, { repo: 'nym', modality: 'docs', chunks: [doc('x', 'nym text', { url: 'https://d/x' })], provider: fixed() });
    const vpn = [doc('x~0', 'vpn part 0', { url: 'https://d/x' }), doc('x~1', 'vpn part 1', { url: 'https://d/x' })];
    await indexShard(db, { repo: 'vpn', modality: 'docs', chunks: vpn, provider: fixed() });
    expect((await getSection(db, 'x'))?.text).toBe('nym text');
    expect((await getSection(db, 'https://d/x'))?.text).toBe('nym text');
  });

  it('reads docs only, and returns null for an unknown ref', async () => {
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [code('c', 'east')], provider: fixed() });
    expect(await getSection(db, 'c')).toBeNull();
    expect(await getSection(db, 'nowhere')).toBeNull();
  });
});

describe('modalities and modalityModel', () => {
  it('lists a modality only while it has chunks, and reports its model', async () => {
    expect(await modalities(db)).toEqual(new Set());
    await indexShard(db, { repo: 'nym', modality: 'docs', chunks: [doc('e', 'east')], provider: fixed('docs-model') });
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [code('c', 'east')], provider: fixed('code-model') });
    expect(await modalities(db)).toEqual(new Set(['docs', 'code']));
    expect(await modalityModel(db, 'code')).toEqual({ model: 'code-model', dim: 3 });

    await db.query("delete from chunks where modality = 'code'");
    expect(await modalities(db)).toEqual(new Set(['docs']));
  });
});

describe('staleShards', () => {
  it('reports a shard by age and by source revision', async () => {
    await indexShard(db, { repo: 'nym', modality: 'docs', chunks: [doc('e', 'east')], provider: fixed(), sourceRev: 'aaa' });
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [code('c', 'east')], provider: fixed(), sourceRev: 'bbb' });
    await db.query("update shards set last_run = now() - interval '3 days' where shard = 'nym/code'");
    const day = 24 * 3_600_000;

    expect(await staleShards(db, { maxAgeMs: day })).toEqual([{ shard: 'nym/code', reason: 'last run 72 h ago' }]);
    expect(await staleShards(db, { maxAgeMs: 7 * day, expectedRevs: { 'nym/docs': 'ccc', 'nym/code': 'bbb' } }))
      .toEqual([{ shard: 'nym/docs', reason: 'built from aaa, source is at ccc' }]);
  });
});
