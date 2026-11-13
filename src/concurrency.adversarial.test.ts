// Adversarial coverage for the under-lock re-checks in indexShards (store.ts).
// PGlite is one in-process connection, so it cannot show two writers excluding
// each other on the advisory lock. It CAN show the time-of-check/time-of-use
// re-checks: a provider whose embed() mutates the store lands its change after
// the pre-embed reads but before the transaction's re-read, which is exactly
// the "another run changed it mid-embed" case.
// ponytail: single-connection sim; true lock mutual exclusion needs real
// Postgres (two pg.Client), left as a user-run follow-up.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { mockProvider } from './embed.js';
import { ensureSchema, indexShard, type StoreChunk, type Connection } from './store.js';

const chunk = (id: string, text: string): StoreChunk => ({
  id, source: 'nym-code', title: `src/${id}.rs`, heading: id, url: `https://g/src/${id}.rs#L1`, text, lang: 'rust',
});

// A provider that runs `mutate(db)` once, during its first embed() call: the
// mutation commits (no open transaction yet) between the pre-embed read and the
// under-lock re-read.
function sabotageProvider(db: Connection, mutate: (db: Connection) => Promise<void>, model = 'mock') {
  const base = mockProvider({ dim: 4 });
  let fired = false;
  return {
    name: base.name, model, dim: base.dim,
    async embed(texts: string[]) {
      if (!fired) { fired = true; await mutate(db); }
      return base.embed(texts);
    },
  };
}

let db: PGlite;
beforeEach(async () => {
  db = new PGlite({ extensions: { vector } });
  await ensureSchema(db);
});
afterEach(() => db.close());

describe('under-lock re-checks', () => {
  it('throws and writes nothing when the shard changes mid-embed (TOCTOU re-read)', async () => {
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A')], provider: mockProvider({ dim: 4 }) });

    // Second run embeds the changed 'a'; mid-embed, something else rewrites a's hash.
    const provider = sabotageProvider(db, async (c) => {
      await c.query(`update chunks set content_hash = 'tampered' where shard = 'nym/code' and id = 'a'`);
    });
    await expect(
      indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A changed')], provider }),
    ).rejects.toThrow(/another run changed it/);

    // The run wrote nothing: 'a' still holds the original text, and the injected hash survived.
    const { rows } = await db.query<{ text: string; content_hash: string }>(`select text, content_hash from chunks where id = 'a'`);
    expect(rows[0]).toEqual({ text: 'A', content_hash: 'tampered' });
  });

  it('throws under the lock when a conflicting model appears mid-embed (checkModel re-check)', async () => {
    await indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A')], provider: mockProvider({ dim: 4 }) });

    // Mid-embed, a second code shard on a different model is inserted. The
    // pre-embed checkModel passed (it did not exist yet); the under-lock one must catch it.
    const provider = sabotageProvider(db, async (c) => {
      await c.query(
        `insert into shards (shard, repo, modality, model, dim, last_run) values ('other/code', 'other', 'code', 'other-model', 4, now())`,
      );
    });
    await expect(
      indexShard(db, { repo: 'nym', modality: 'code', chunks: [chunk('a', 'A changed')], provider }),
    ).rejects.toThrow(/differs from the code model/);

    // 'a' unchanged by the failed run.
    const { rows } = await db.query<{ text: string }>(`select text from chunks where id = 'a'`);
    expect(rows[0]!.text).toBe('A');
  });
});
