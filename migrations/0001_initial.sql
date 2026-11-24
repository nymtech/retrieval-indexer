-- The store schema: the pgvector extension, the shards and chunks tables, and
-- their indexes. node-pg-migrate applies this file to a shared store, and
-- ensureSchema applies it to a PGlite or throwaway local store.
--
-- No down migration: undoing this file drops the whole index.
--
-- A migration that adds a table also names the grants the retrieval_writer and
-- retrieval_reader roles need on it. Whoever applies the migration runs those
-- grants after it (MCP-STORE-SETUP.md, step 3).

-- Up Migration

create extension if not exists vector;

create table if not exists shards (
  shard text primary key,
  repo text not null,
  modality text not null,
  model text not null,
  dim integer not null,
  source_rev text,
  last_run timestamptz not null
);

-- `embedding` has no fixed dimension, so a store's model can change; a typed
-- column matters only if an ANN index is ever added.
create table if not exists chunks (
  id text primary key,
  shard text not null references shards (shard) on delete cascade,
  repo text not null,
  modality text not null,
  source text not null,
  title text not null,
  heading text not null,
  url text not null,
  text text not null,
  lang text,
  tokens_est integer,
  test boolean not null default false,
  content_hash text not null,
  embedding vector not null
);

create index if not exists chunks_shard on chunks (shard);
create index if not exists chunks_modality on chunks (modality);
