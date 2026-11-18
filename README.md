# retrieval-indexer

`@nymproject/retrieval-indexer` chunks documentation and source code, embeds the chunks, and stores them in Postgres with pgvector for semantic retrieval. It is the indexing and search engine behind a Model Context Protocol (MCP) server: a producer builds an index from its docs and code, and an MCP server answers `search_docs` and `search_code` queries from the store.

## What it does

The pipeline is a set of small, composable modules:

1. **Walk** a producer's source roots, skipping build output and dependencies, with a fail-closed gate that records any language it drops rather than dropping it silently (`walk`).
2. **Chunk** Markdown or MDX by heading (`chunker`, `mdx`) and source code at tree-sitter item boundaries (`code-chunker`, `items`), so each chunk is a retrieval-sized unit with a deep link.
3. **Embed** the chunks with a pluggable provider and a content-hash cache, so a rebuild re-embeds only what changed (`embed`).
4. **Store** the embedded chunks in Postgres + pgvector, one transaction per run, keeping unchanged vectors and deleting stale rows (`store`).
5. **Search** the store at query time with cosine similarity, returning the same chunk shape a bundled-index search would (`search`).

## Requirements

- Node 20+ and pnpm.
- Postgres with the `pgvector` extension for the store and search modules. The tests use PGlite (in-process Postgres), so they need no server.

## Install

Pin it as a git dependency at a release tag:

```
"@nymproject/retrieval-indexer": "github:nymtech/retrieval-indexer#v0.1.2"
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
| `@nymproject/retrieval-indexer/walk` | source walk, file-size cap, fail-closed language gate |
| `@nymproject/retrieval-indexer/chunker` | Markdown docs chunker (heading-scoped, deep links) |
| `@nymproject/retrieval-indexer/mdx` | MDX to plain text: frontmatter, partials, fence-aware strip |
| `@nymproject/retrieval-indexer/code-chunker` | code chunker at tree-sitter item boundaries, test-code flag |
| `@nymproject/retrieval-indexer/items` | tree-sitter item finder for Rust, TS/JS, Go, Python |
| `@nymproject/retrieval-indexer/embed` | embedding providers, content-hash cache, bounded-concurrency batching |
| `@nymproject/retrieval-indexer/store` | Postgres + pgvector write side (`indexShard`, `indexShards`) |
| `@nymproject/retrieval-indexer/search` | read side (`search`, `getSection`, `modalities`, `staleShards`); loads no parser |
| `@nymproject/retrieval-indexer/types` | shared types |

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
import { ensureSchema, indexShard } from '@nymproject/retrieval-indexer/store';
import { search } from '@nymproject/retrieval-indexer/search';

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await ensureSchema(db);

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

Pass a single `pg.Client` (or PGlite), never a `pg.Pool`: the store runs `begin`, an advisory lock, and `commit` on one connection, which a pool does not guarantee.

## Develop

```
pnpm install
pnpm test        # vitest, PGlite-backed, no server needed
pnpm typecheck   # tsc, strict
pnpm build       # dist/
```

## Licence

Apache-2.0.
