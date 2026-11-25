# retrieval-indexer

`@nymproject/retrieval-indexer` chunks documentation and source code, embeds the chunks, and stores them in Postgres with pgvector for semantic retrieval. It is the indexing and search engine behind a Model Context Protocol (MCP) server: a producer builds an index from its docs and code, and an MCP server answers `search_docs` and `search_code` queries from the store.

## What it does

The pipeline is a set of small, composable modules:

1. **Walk** a producer's source roots, skipping build output and dependencies, with a fail-closed gate that records any language it drops rather than dropping it silently (`walk`). For a repository with no docs site, the same module reads its Markdown files as pages for the docs chunker (`collectMarkdownPages`).
2. **Chunk** Markdown or MDX by heading (`chunker`, `mdx`) and source code at tree-sitter item boundaries (`code-chunker`, `items`), so each chunk is a retrieval-sized unit with a deep link.
3. **Embed** the chunks with a pluggable provider and a content-hash cache, so a rebuild re-embeds only what changed (`embed`).
4. **Store** the embedded chunks in Postgres + pgvector, one transaction per run, keeping unchanged vectors and deleting stale rows (`store`).
5. **Search** the store at query time with cosine similarity, returning the same chunk shape a bundled-index search would (`search`).

The steps are separate, so a producer can skip any of them. A producer that already has its own units, for example one record per docs section from another tool, can build its own `Chunk[]` and pass it to `indexShard`, which embeds and stores it.

## Requirements

- Node 20+ and pnpm.
- Postgres with the `pgvector` extension for the store and search modules. The tests use PGlite (in-process Postgres), so they need no server.

## Install

Pin it as a git dependency at a release tag:

```
"@nymproject/retrieval-indexer": "github:nymtech/retrieval-indexer#v0.2.1"
```

The package ships TypeScript and builds `dist/` on install (`prepare`), so a git install gets JavaScript. The consumer's `pnpm-workspace.yaml` must set two things. Approve this package's own `prepare` build, or pnpm installs it without `dist/`. Tell pnpm not to run the tree-sitter grammars' native build scripts, because the code-chunker loads each grammar as prebuilt WebAssembly, not a native addon:

```yaml
allowBuilds:
  '@nymproject/retrieval-indexer': true
  tree-sitter-go: false
  tree-sitter-javascript: false
  tree-sitter-python: false
  tree-sitter-rust: false
  tree-sitter-typescript: false
```

## Modules

Each module is a separate export, so a read-only MCP server pulls in `search` and `store` without the chunker or any parser.

| Import | Role |
|---|---|
| `@nymproject/retrieval-indexer/walk` | source walk, file-size cap, fail-closed language gate, Markdown walk |
| `@nymproject/retrieval-indexer/chunker` | Markdown docs chunker (heading-scoped, deep links) |
| `@nymproject/retrieval-indexer/mdx` | MDX to plain text: frontmatter, partials, fence-aware strip |
| `@nymproject/retrieval-indexer/code-chunker` | code chunker at tree-sitter item boundaries, test-code flag |
| `@nymproject/retrieval-indexer/items` | tree-sitter item finder for Rust, TS/JS, Go, Python |
| `@nymproject/retrieval-indexer/embed` | embedding providers, content-hash cache, bounded-concurrency batching |
| `@nymproject/retrieval-indexer/store` | Postgres + pgvector write side (`indexShard`, `indexShards`, `storeConnection`) |
| `@nymproject/retrieval-indexer/search` | read side (`search`, `getSection`, `modalities`, `staleShards`); loads no parser |
| `@nymproject/retrieval-indexer/types` | shared types |
| `@nymproject/retrieval-indexer/checks` | probe-file runner for a deployed MCP endpoint (`runChecks`, `parseProbeFile`); CLI `retrieval-mcp-check` |

## Embedding providers

A provider is `{ name, model, dim, embed() }`. Three ship with the package:

- `voyageProvider({ apiKey })`: Voyage AI, the default for a public store.
- `selfHostedProvider({ url, model, dim })`: any OpenAI-compatible `/v1/embeddings` endpoint (text-embeddings-inference, Ollama, vLLM, LocalAI, llama.cpp). Use this for a private store whose content cannot go to a third-party API. Set `queryInstruction` for instruction-tuned models.
- `mockProvider()`: deterministic vectors for tests, no network.

Index and query must use the same model; the store records the model per modality and rejects a vector of the wrong dimension.

## Example

```ts
import { Client } from 'pg';
import { chunkCodeFile } from '@nymproject/retrieval-indexer/code-chunker';
import { voyageProvider, embedQuery } from '@nymproject/retrieval-indexer/embed';
import { indexShard, storeConnection } from '@nymproject/retrieval-indexer/store';
import { search } from '@nymproject/retrieval-indexer/search';

const db = new Client(storeConnection(process.env.DATABASE_URL!, process.env.DATABASE_CA_CERT));
await db.connect();

const provider = voyageProvider({ apiKey: process.env.VOYAGE_API_KEY! });

const chunks = await chunkCodeFile(sourceText, 'src/lib.rs', {
  repo: 'my-repo',
  source: 'my-repo-code',
  github: 'https://github.com/org/my-repo/blob/main',
});
await indexShard(db, { repo: 'my-repo', modality: 'code', chunks, provider });

const queryVector = await embedQuery('how do I open a connection', provider);
const hits = await search(db, 'code', queryVector, { topK: 6 });
```

The example needs a migrated store (see [Schema and migrations](#schema-and-migrations)).

`storeConnection(url, ca?)` returns the pg options for a store. For a store with a private CA, pass the CA as PEM text and leave `sslmode` and `sslrootcert` out of the URL. Without a CA, the URL must set `sslmode`, for example `sslmode=disable` for a local store. Pass a single `pg.Client` (or PGlite), never a `pg.Pool`: the store runs `begin`, an advisory lock, and `commit` on one connection, which a pool does not guarantee.

## Set up a store

1. As the server admin, connected to the default database, run `bootstrap/init.sql`. It creates the `codex` database, the owner `retrieval_ddl`, the roles `retrieval_writer` and `retrieval_reader`, and their default privileges. Replace the placeholder passwords with `\password <role>`.
2. Apply the schema with the `store-migrate` workflow (see [Schema and migrations](#schema-and-migrations)).
3. As `retrieval_ddl`: `grant delete on chunks to retrieval_writer;`. A write run deletes the chunks that left a shard.
4. As the server admin: `alter role retrieval_reader connection limit 20;`.

Each connection string ends in the store database (`/codex`), not the server's default database. A managed server's console URI often ends in `/defaultdb`.

## Schema and migrations

The schema is the SQL files in `migrations/`, applied in file order. [node-pg-migrate](https://github.com/salsita/node-pg-migrate) applies them to a shared store and records each applied file in the store's `pgmigrations` table, so a later run applies only the new files.

To migrate a shared store, run the `store-migrate` workflow (Actions, then "Run workflow"). Give it a GitHub Environment that holds `PG_URL` (the owner role, at the direct Postgres address, not a PgBouncer pooler) and, optionally, `PG_CA_CERT`. Run it with `dry_run` first to list the pending files. A dry run applies no migration, but it still takes node-pg-migrate's lock, and on a store that was never migrated it creates the empty `pgmigrations` table. From a machine with access to the database:

```
DATABASE_URL=postgres://... pnpm migrate up --dry-run
DATABASE_URL=postgres://... pnpm migrate up
```

Each run logs `Can't determine timestamp for 0001`. node-pg-migrate expects a timestamp prefix, and when it finds a plain number it logs this line and orders the files by that number. Nothing is wrong.

`ensureSchema(db)` applies the same files to a PGlite or throwaway local store, which is what the tests use. It records nothing, so do not use it on a shared store.

Rules for a new migration:

- Write the file by hand and name it with the next four-digit number, for example `0002_edges.sql`. Do not use `pnpm migrate create`: it names the file with a timestamp, which sorts after every numbered file, so node-pg-migrate refuses to apply a numbered file written after it.
- Put its statements under `-- Up Migration`.
- Put only `.sql` files in `migrations/`. node-pg-migrate loads any other file as a JavaScript migration, and `ensureSchema` throws on it.
- End each statement with a semicolon at the end of a line. `ensureSchema` splits on that, because PGlite runs one statement per query.
- If it adds a table, say in the file which grants the writer and reader roles need. The person who runs the migration runs those grants after it. By default (`bootstrap/init.sql`), a new table gives the reader `select` and the writer `select`, `insert` and `update`. Name any other grant, such as `delete`, in the file.
- Once a file is applied to a store, do not change it. Write a new file.

## Check a deployed MCP endpoint

`retrieval-mcp-check <mcp-url> <probe file or URL>...` runs probe files against a deployed MCP server and exits 1 when a check fails. A Vercel preview needs its bypass token in `$BYPASS`.

Each producer keeps its probe file beside its index roots, so one pull request changes a root and its probe. A probe file (format version 1) is JSON:

```json
{
  "version": 1,
  "name": "nym",
  "tools": ["get_section", "search_code", "search_docs"],
  "probes": [
    { "group": "Retrieval", "label": "finds the SOCKS5 setup", "tool": "search_docs", "args": { "query": "run a socks5 client" }, "match": "socks5|SOCKS5" },
    { "group": "Index coverage", "label": "smolmix", "tool": "search_code", "args": { "query": "Tunnel new_with_ipr", "topK": 8 }, "path": { "repo": "nymtech/nym", "path": "smolmix" } }
  ]
}
```

| Field | Check |
|---|---|
| `tools` | `tools/list` returns exactly these names, and each description has 20 characters or more |
| `match` | Each regex matches the tool's text |
| `notMatch` | The regex does not match |
| `isError` | The result is (or is not) an MCP error result |
| `path` | A hit links to a file at or under `path` in `repo`: `github.com/<repo>/blob/<ref>/<path>/` |
| `roundTrip` | `get_section` resolves the first anchored URL in the text |
| `advisory` | A failure is a note and does not fail the run |

A probe needs at least one of `match`, `notMatch`, `isError`, `path` or `roundTrip`. Each run also checks the transport once: a single `Accept` type is refused with 406, and `GET` with 405.

The `mcp-checks` workflow runs every producer's probe file against `https://nym.com/docs/api/mcp` each day, on a dispatch, on a push to `main`, and on each pull request. It blocks no other repository. Outside pull requests, a failure opens or updates the issue "MCP checks failing", a pass closes it, and each change of state sends a Zulip direct message when the `ZULIP_*` secrets are set. The server can be self-hosted: see the workflow file for its CA, the runner, and the masking of its host name.

## Develop

```
pnpm install
pnpm test        # vitest, PGlite-backed, no server needed
pnpm typecheck   # tsc, strict
pnpm build       # dist/
```

## Licence

Apache-2.0.
