# How the indexer works

This page explains the internals of `@nymproject/retrieval-indexer` for a contributor who changes the package. The [README](../README.md) tells you how to use the package. [api.md](api.md) lists each export with its signature.

## The flow

The package has no single pipeline function. A producer script (in a producer repository, `.github/indexer/index.mts`) calls each step in turn. `indexShards` is the only function that calls another step for you: it calls `embedChunks`.

```text
producer script
 |
 |  code                                          docs
 v                                                v
collectSourceFiles(repoRoot, roots)            collectMarkdownPages(repoRoot, roots, opts)
  exclude, MAX_FILE_BYTES, dropped by ext        or the producer's own MDX pages:
 |                                                parseFrontmatter, inlineMdxPartials, stripMdx
 v                                                |
assertNoSilentDrops(dropped)                      |
 |                                                v
chunkCodeFile(content, path, opts), each file  chunkPages(pages, { siteUrl, repo })
  chunkCode: tree-sitter items or line rule      splitByHeadings, packSection
  drop the import-only header, set test          ids with #anchor and ~part, deep links
 |                                                |
assertRootsYieldChunks(roots, files, paths)       |
 |                                                |
 +-----------------------+------------------------+
                         | StoreChunk[] for each shard
                         v
indexShards(db, modality, runs, { provider, concurrency, maxShrink })
  1  refuse a pg.Pool, an empty run, a duplicate id
  2  read the stored id -> content_hash of each shard; maxShrink check
  3  chunkHash of each chunk; split into changed and unchanged
  4  checkModel, checkIds
  5  embedChunks(changed)  -> provider.embed(texts, 'document')
       batches, concurrency, fetchWithRetry
  6  begin; pg_advisory_xact_lock(hashtext('retrieval-store'))
  7  read the hashes again; checkModel, checkIds again
  8  writeShard for each shard; commit (rollback on any error)
                         |
                         v
               Postgres + pgvector: shards, chunks
                         ^
                         |
MCP server: embedQuery(text, provider) -> search(db, modality, vector, { topK, model })
            getSection(db, idOrUrl), modalities(db), modalityModel(db, modality)
```

## Walk

`collectSourceFiles(repoRoot, roots)` walks each root below `repoRoot`. It reads directories with `readdirSync`. A root that does not exist gives no error: the walk skips it. For each entry, the walk tests `exclude` against the repo-relative path. `DEFAULT_EXCLUDE` skips `node_modules`, `target`, `dist`, `build`, `out`, `.next`, `pkg`, `coverage` and `__pycache__` at any depth, and `.d.ts`, `.d.cts` and `.d.mts` files.

The walk sorts each file into one of four groups by its extension:

| Extension | Result |
|---|---|
| A language that `langOf` knows: `rs`, `ts`, `tsx`, `cts`, `mts`, `js`, `jsx`, `mjs`, `cjs`, `kt`, `kts`, `swift`, `go`, `py` | The walk reads the file, or puts its path in `oversized` when it is larger than `maxBytes` (`MAX_FILE_BYTES`, 256 KiB) |
| `ACCEPTED_DROP`: `c`, `h`, `cc`, `cpp`, `cxx`, `hpp`, `hxx`, `m`, `mm`, `proto`, `sh` | The walk records it in `dropped`, and the gate accepts it |
| In `SOURCE_LIKE` and outside `ACCEPTED_DROP`: `rb`, `java`, `scala`, `cs` | The walk records it in `dropped`, and the gate throws |
| Any other extension | The walk ignores the file |

The walk does not throw. The producer calls the two gates:

- `assertNoSilentDrops(dropped)` throws when `dropped` holds an extension outside `ACCEPTED_DROP`. The error names each file. To index such a language, give `code-chunker` a rule for it. To skip it on purpose, add the extension to `ACCEPTED_DROP`.
- `assertRootsYieldChunks(roots, files, chunkPaths)` throws when a root holds source files but no chunk path is at or below that root. A root with no source files passes. The producer passes the chunk titles as `chunkPaths`, because a code chunk's title is its repo-relative path.

`collectMarkdownPages` is the docs walk for a repository with no docs site. It reads `.md` files only, and skips the paths that `DEFAULT_EXCLUDE` or `DOCS_EXCLUDE` match. `DOCS_EXCLUDE` skips `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `CLAUDE.md`, `AGENTS.md`, `.github/` and `.nym-codex/`. It skips empty files. The page title is the first `# ` heading, or the path when the file has none. The page URL is `${github}/${path}`. The body is the raw file text.

## Chunk docs

### MDX to text

A producer with an MDX site turns each page into a `PageRecord` before it calls `chunkPages`. The `mdx` module gives the steps:

1. `parseFrontmatter` parses the leading YAML block with gray-matter. A `---` line in the body stays in the body.
2. `inlineMdxPartials` puts the text of each imported MDX partial where its tag stands. It first replaces each `<Snippet id="..." />` with the text that the `citation` callback returns, and each `](snippet:<id>)` link with the `link` callback's result. Both replacements skip code fences. Then it finds each default import of a `.mdx` file outside a fence. It resolves the path: an `aliases` prefix maps to its directory, a `./` or `../` path resolves against the importing file, and a bare path resolves against `root`. A missing file throws, with the file and line of the import. A file that is already in `seen` is skipped, so a cycle stops. The function recurses into each partial, then replaces each `<Name />` tag, anywhere on a line, with the partial text between blank lines. It leaves the import lines in place.
3. `stripMdx` removes what a reader does not see as text. It keeps fenced code lines as they are. It removes import lines, top-level JS statements (`export`, `const x =`, `let x =`, `var x =`, `function`, `class`) and the following lines until the brackets balance, MDX comments `{/* ... */}` on one or more lines, and lines that hold only a `{...}` expression. It replaces `{IDENT}` with its value when `values` has that name. A line that holds only a JSX opening or self-closing tag becomes the text that `expand` returns, or is removed. A line that holds only a closing tag is removed. The text between an opening and a closing tag stays. Runs of three or more line breaks become two.

`stripHeadingIds` removes `{#id}` and `[#id]` anchors from heading lines. It is for a plain-text copy of a page. Do not use it on a body before `chunkPages`, because `chunkPages` reads those anchors to build its deep links.

### Sections and parts

`splitByHeadings(body, pageTitle)` splits a body at `##`, `###` and `####` headings outside code fences. A `#` heading and a `#####` or `######` heading do not split the body: they stay in the section text. Its fence rule is simple: a line that starts with three or more backticks or tildes opens a fence, and the next such line of the same character closes it. The text before the first heading becomes a section with the page title as its heading and level 1. A section with only white space is dropped. When a heading ends with `{#id}` or `[#id]` (`HEADING_ANCHOR`), the anchor goes to `Section.anchor` and leaves the heading text.

`packSection(text, maxChars)` returns the text as one part when it is `MAX_CHARS` (2400) characters or less. A longer text splits at blank lines into paragraphs. A paragraph longer than the cap splits at line breaks, and a line longer than the cap splits into slices of `maxChars` characters. The function then joins the units again, with a blank line between them, up to the cap. Each part is trimmed and is never longer than `maxChars`.

`chunkPages(pages, { siteUrl, repo })` makes the chunks:

- The page path is `page.url` with `${siteUrl}/` removed. When `page.url` does not start with `siteUrl`, the id holds the whole URL.
- The intro section (level 1) has no anchor. Each other section gets its explicit anchor, or a slug from github-slugger. One slugger instance serves one page, so repeated headings get `-1`, `-2` suffixes, as on the rendered page.
- A section whose plain slug is in `skipSlugs` (default `generate-fig-spec`) is dropped. A dropped section does not move the slugger, so later suffixes do not change.
- The id is `${repo}/${pagePath}${anchor}`, without the `${repo}/` prefix when `repo` is unset. When `packSection` gives more than one part, each id gets `~0`, `~1`, and so on.
- The URL is `${page.url}${anchor}`. All parts of a section share one URL.
- `tokensEst` is `ceil(length / 4)`.

The docs chunker has no size floor. `chunker.ts` exports `MIN_CHARS = 120`, but `chunkPages` does not read it.

## Chunk code

### Boundaries

`chunkCode(content, file)` splits a file into blocks at top-level items. `langOf(file)` decides the language. A file with no language gives no blocks.

For Rust, TypeScript, TSX, JavaScript, Go and Python, tree-sitter finds the items. `items.ts` loads each grammar once, as the prebuilt `.wasm` file from its npm package, and caches the load promise, because web-tree-sitter fails when it loads one grammar twice at the same time. `withTree` frees the parse tree after use. Only the named children of the root node count, so a nested item is never a boundary.

| Language | Boundary nodes | Symbol |
|---|---|---|
| Rust | `function_item`, `struct_item`, `enum_item`, `union_item`, `trait_item`, `impl_item`, `mod_item`, `type_item`, `static_item`, `macro_definition` | The `name` field. For an `impl`, the concrete type of `impl Type` or `impl Trait for Type`, or the trait when the type is a type parameter of the impl |
| TypeScript, TSX, JavaScript | `function_declaration`, `generator_function_declaration`, `function_signature`, `class_declaration`, `abstract_class_declaration`, `interface_declaration`, `type_alias_declaration`, `enum_declaration`, a `const` with one plain name, and each of these inside `export` | The `name` field |
| Go | `function_declaration`, `method_declaration`, `type_declaration`, `var_declaration`, `const_declaration` | The `name` field, or `''` for a group with more than one spec |
| Python | `function_definition`, `class_definition`, with or without decorators | The `name` field |

A Rust `const` item, a TS or JS `let` or `var`, a destructuring `const` and an `export default` value are not boundaries. They stay in the block of the item above them.

Kotlin and Swift have no grammar in the package, so they use a line rule. An item line starts at column 0 with optional annotations and modifiers, then a keyword (`KOTLIN_ITEM`, `SWIFT_ITEM`). `symbolOf` takes the first name after the keyword, past Kotlin generics and an extension receiver.

### Docs attached to items

A block starts at the first doc line of its item. `startWithDocs` walks back over the siblings directly above the item. For Rust, it accepts outer doc comments (`///`, `/**`) and attributes. For the other grammars, it accepts any comment. A blank line or any other node stops the walk. A trailing comment on the row of the node before it belongs to that node, so the walk looks past it. When two items start on the same row, they share one block, with the name of the first. The Kotlin and Swift rule walks back over comment, doc and annotation lines, and never past the previous item line.

### The header

When the first item does not start at row 0, the text above it becomes a header block with the symbol `''`. The chunker marks it `importsOnly` when every top-level node in it is noise:

| Language | Noise |
|---|---|
| Rust | `use`, `extern crate`, attributes, inner attributes, and comments other than `///`, `//!`, `/**`, `/*!` |
| TypeScript, TSX, JavaScript | imports, re-exports with a source (`export { a } from 'b'`), directive strings (`'use strict'`), and comments other than `/**` |
| Go | the package clause, imports, and comments other than a comment on the line directly above the package clause |
| Python | imports, `from` imports, `__future__` imports, and comments |
| Kotlin, Swift | blank lines, `package`, `import` and `@file:` lines, `#if`, `#elseif`, `#else`, `#endif`, and comment lines other than docs (`LINE_NOISE`) |

A header with a crate doc, a package doc, a JSDoc block or a Python module docstring is not noise, and the chunker keeps it. A file with no item becomes one header block. When all of its top-level nodes are noise, for example a TS file of re-exports or a Python `__init__.py` with only imports, the file gives no chunk.

### Size cap and hard split

A block runs from its start row to the start row of the next boundary. While the trimmed block is longer than `MAX_CHARS` (2400), the chunker cuts it at the last line break within the cap. When the block has no line break within the cap, it cuts at 2400 characters. A piece shorter than `MIN_CHARS` (16) after trim is dropped. Each piece keeps the symbol and the `importsOnly` mark of its block, and its `startLine` counts the lines of the pieces before it.

### Records

`chunkCodeFile(content, repoPath, { repo, source, github })` turns the blocks into `CodeChunk` records:

| Field | Value |
|---|---|
| `id` | `${repo}/${repoPath}#${i}`, without `${repo}/` when `repo` is unset. `i` is the position of the block in the `chunkCode` output |
| `title` | `repoPath` |
| `heading` | The symbol, or the file name when the symbol is `''` |
| `url` | `${github}/${repoPath}#L${startLine}` |
| `lang` | The `langOf` result. All TS and JS files get `typescript` |
| `test` | `true` when `isTestCode` is true, else absent |

`chunkCodeFile` drops the `importsOnly` blocks, but `i` counts each header block that `chunkCode` gave. A header shorter than 16 characters after trim gives no block, so the first item is `#0`. A header of up to 2400 characters gives one block, so the first kept chunk is `#1`. A longer header gives two or more blocks. The ids of the item blocks stay the same whether or not the header is dropped. An item added above other items moves the index of each block below it. Those blocks get ids whose stored hash differs or is absent, so `indexShards` embeds them again.

`CodeChunk` has no `tokensEst`, so a code row has a null `tokens_est` unless the producer adds one.

`isTestCode(repoPath, symbol, lang)` is true for:

- a path with a directory `test`, `tests`, `Tests`, `__tests__`, `androidTest`, or a name that ends in `Tests`;
- a file `*.test.*` or `*.spec.*` (JS and TS), `*_test.go`, `*_test.py`, `test_*.py`, `*Test.kt`, `*Tests.kt`, `*Test.swift`, `*Tests.swift`, `test.rs`, `tests.rs` or `test_utils.rs`;
- a Rust block whose symbol is `test` or `tests`, of any item kind.

## Embed

### Embed text and hash

`embedText(chunk)` gives the string that the provider embeds: the title, the heading and the text, joined with line breaks. It removes an empty title or heading, and a heading that equals the title. The stored `text` stays the body only, because the search result shows the body.

`contentHash(text)` is the SHA-256 of a string, in hex. `chunkHash(chunk, provider)` is the key of a vector:

```text
${provider.model}:${provider.dim}:${contentHash(embedText(chunk))}
```

The key holds the model and the dimension because two models give vectors that you cannot compare. A model or dimension change changes every key, so no cache and no store row gives a vector of one model to a run of another. The key holds the title and heading through `embedText`, so a heading change also changes the key.

### Two caches

| | File cache | Store |
|---|---|---|
| Where | A JSON file, `chunkHash` to vector (`loadCache`, `saveCache`) | The `content_hash` column of each chunk row |
| Who uses it | A producer that passes it to `embedChunks` | `indexShards`, which compares the stored hash of the same id |
| Reuse across ids | Yes, by key | No |

`indexShards` gives `embedChunks` an empty `Map`, so the store write does not use a file cache. `loadCache` returns an empty cache for a missing file and throws for a file it cannot parse. `saveCache` writes a temporary file and renames it.

### Batches, concurrency and retries

`embedChunks(chunks, provider, cache, { batchSize, concurrency, onProgress })` works in these steps:

1. It throws when `concurrency` is not an integer of 1 or more.
2. It computes `chunkHash` for each chunk and selects the chunks whose key is not in `cache`.
3. It puts those chunks in batches. A batch holds at most `batchSize` (128) chunks and at most 80,000 tokens, with the tokens of a text estimated as `ceil(length / 1.5)`. A batch always holds at least one chunk.
4. It starts `min(concurrency, batches)` workers. Each worker takes the next batch. The default `concurrency` of 1 sends one batch at a time.
5. Each batch calls `provider.embed(texts)` with the default input type `document`. When the provider throws an error whose message matches `/too many tokens|max(?:imum)? allowed (?:tokens|batch)|batch size/i`, and the batch has more than one text, the batch splits in half and each half runs again. A wrong vector count throws.
6. After one batch fails, no worker takes another batch, and the call rejects with that error.
7. At the end, each chunk must have a vector of length `provider.dim`. Else the call throws.

`fetchWithRetry(url, init)` retries a request that throws, a 429 and a 5xx response. It waits 1, 2, 4, 8 and 16 seconds, so it makes at most six attempts. A `Retry-After` header with a number of seconds above zero sets the wait, up to 60 seconds. It returns any other response at once, and the last response after the last retry. After the last retry, a request that throws rethrows its error. The two HTTP providers then throw on a response that is not OK, with the status and the body.

### Input types, models and dimensions

`embedChunks` embeds with the input type `document`. `embedQuery(text, provider)` embeds one query with the input type `query`.

| Provider | `name`, default `model`, default `dim` | `document` | `query` |
|---|---|---|---|
| `voyageProvider` | `voyage`, `voyage-3-large`, 1024 | `input_type: 'document'` | `input_type: 'query'` |
| `selfHostedProvider` | `self-hosted`, no default (required), 1024 | texts as given | `queryInstruction` before each text, when it is set |
| `mockProvider` | `mock`, `mock`, 8 | input type ignored | input type ignored |

No provider sends `dim` to its API. `dim` is the vector length that `embedChunks` expects, and the store records it. When `dim` differs from the length the model returns, `embedChunks` throws. The README tells producers of the public store to use `voyage-code-3` for code and `voyage-3-large` for docs. The producer passes `model` for code.

## Store write

### Schema

`migrations/0001_initial.sql` creates the `vector` extension and two tables.

| `shards` column | Meaning |
|---|---|
| `shard` (key) | `${repo}/${modality}` |
| `repo`, `modality` | The parts of the shard name |
| `model`, `dim` | The provider of the last write |
| `source_rev` | The source commit that the producer passed, or null |
| `last_run` | The time of the last write |

| `chunks` column | Meaning |
|---|---|
| `id` (key) | The chunk id, unique in the store |
| `shard` | The owner shard, with `on delete cascade` |
| `repo`, `modality` | Copies from the shard |
| `source`, `title`, `heading`, `url`, `text`, `lang`, `tokens_est`, `test` | The chunk fields |
| `content_hash` | `chunkHash` of the chunk |
| `embedding` | A `vector` with no fixed dimension |

The indexes are the two keys, `chunks (shard)` and `chunks (modality)`. The schema has no vector index, so each search computes the distance for each row of the modality.

### `indexShards`

`indexShards(db, modality, runs, { provider, concurrency, maxShrink })` replaces the shard `${repo}/${modality}` of each run, in one transaction. `indexShard` calls it with one run.

Before the transaction:

1. It throws when `db` has a `totalCount` property, which only a `pg.Pool` has. A pool can run `begin`, the writes and `commit` on different connections.
2. It throws when a run has no chunks, because the delete step would empty the shard. It throws when one id is in the call twice.
3. For each run, it reads the stored `id` and `content_hash` of its shard. With `maxShrink`, it throws when the run has fewer than `stored rows * (1 - maxShrink)` chunks. With `maxShrink: 0.2` and 100 stored rows, a run of fewer than 80 chunks throws.
4. It computes `chunkHash` for each chunk. A chunk whose id has the same stored hash is unchanged. All others are changed.
5. It runs the model check and the id check.
6. It calls `embedChunks` on the changed chunks only.

The embed step is before `begin`, so a long embed holds no transaction open.

In the transaction:

1. It takes `pg_advisory_xact_lock(hashtext('retrieval-store'))`. Postgres releases the lock at `commit` or `rollback`.
2. It reads the hashes of each shard again. When they differ from the first read, another writer changed the shard during the embed, and the call throws.
3. It runs the model check and the id check again.
4. It writes each shard, then commits. On any error, it rolls back and throws the first error. A failed rollback does not hide that error.

The lock is one key for the whole store because the model check and the id check read other shards. With a lock for each shard, two producers that write two different shards at the same time could both pass the checks. They could then commit one id in two shards, or two models in one modality.

| Check | Throws when |
|---|---|
| Model (`checkModel`) | A shard of the same modality outside this call has a different `model` or `dim`. To change the model of a modality, put all of its shards in one `indexShards` call |
| Id (`checkIds`) | A chunk id of this call is stored under another shard. The error shows up to five ids and tells you to add a repo prefix |

`writeShard` does these writes for each shard, in statements of at most 500 rows:

| Rows | Write |
|---|---|
| Shard row | Insert, or update `model`, `dim`, `source_rev` and `last_run` |
| Changed chunks | Insert, or update all columns on an id conflict |
| Unchanged chunks | Update `source`, `title`, `heading`, `url`, `lang`, `tokens_est` and `test` only where a value differs. `text`, `content_hash` and `embedding` stay as stored |
| Stored chunks of the shard that the run does not hold | Delete |

The unchanged update exists because the hash covers only the embed text. A code chunk that moves down a file keeps its text and its hash, but its `#L` URL changes.

The result is a `ShardStats` for each shard: `total`, `embedded` (changed), `unchanged` and `deleted`.

### `storeConnection`

`storeConnection(url, ca)` returns the pg options for a store. The TLS parameters are `sslmode`, `sslrootcert`, `sslcert` and `sslkey` in the URL query.

| `ca` | TLS parameter in the URL | Result |
|---|---|---|
| Not given | None | Throws |
| Not given | One or more | `{ connectionString: url }` |
| Given, without `-----BEGIN CERTIFICATE-----` | Any | Throws. The error asks for PEM text without base64 encoding |
| Given as PEM | One or more | Throws, because pg applies the URL parameters over `ca` |
| Given as PEM | None | `{ connectionString: url, ssl: { ca } }`. pg then verifies the server chain and host name |

## Search

`SEARCH_SQL` is the ranking statement. The parameters are `$1` modality, `$2` the query vector as pgvector text, `$3` the test penalty, `$4` the limit, and `$5` the model.

- The score is `1 - (embedding <=> query)`, the cosine similarity. For a row with `test = true`, the statement subtracts `$3`.
- The statement reads only rows whose shard has the model `$5`. Each statement reads its own snapshot, so this filter keeps a model change that commits between the check and the ranking out of the result.
- It drops rows with a score below 0. It orders by score, highest first, then by `id`, and returns at most `$4` rows.

`search(db, modality, queryVector, { topK, model })` runs these steps:

1. `modalityModel` reads the model and dimension of the modality.
2. When the modality has no shard, it returns `[]`, or throws when you gave `model`.
3. When you gave `model` and it differs from the stored model, it throws.
4. When the query length differs from the stored `dim`, it throws.
5. It runs `SEARCH_SQL` with `TEST_SCORE_PENALTY` (0.05) and `topK` (default 6). Each row becomes a `StoreChunk` without null fields, and with `test` only when it is true.

`modalityModel(db, modality)` reads one `shards` row of the modality, with `limit 1` and no order. It relies on the write-side model check, which keeps one model and one dimension for each modality.

`modalities(db)` returns the modalities that have at least one chunk row. An MCP server lists a tool only while its modality has a chunk.

`getSection(db, idOrUrl)` reads docs rows only:

1. It selects rows whose `id` equals the argument, or whose `id` before the first `~` equals it.
2. When no row matches, it selects rows whose `url` equals the argument.
3. From the rows, it keeps one shard: the shard of the row whose id equals the argument, or else the first shard by name.
4. It sorts the rows by the number after `~` (0 when absent), joins their texts with a blank line, and returns the first row's fields with the id before `~`.

A base id or a section URL returns the whole section. A part id such as `x~1` matches only that row, so `getSection` returns that one part, with the id `x`. It returns `null` when nothing matches.

`staleShards(db, { maxAgeMs, expectedRevs })` reads each shard row, in shard order. It reports a shard whose `last_run` is older than `maxAgeMs`, and a shard whose `source_rev` differs from its value in `expectedRevs`. A shard with both problems is in the result twice. A shard that is not in `expectedRevs` gets the age check only.

## Checks

`checks.ts` runs probe files against a deployed MCP endpoint. `runChecks` first checks the transport once: a `POST` with a single `Accept` type must give 406, and a `GET` must give 405. Then, for each file, it compares `tools/list` with `tools` and checks that each description has 20 characters or more. It calls each probe's tool with `tools/call` and judges the first text block of the result. An error in a probe call becomes the failure detail of that probe. An `advisory` probe that fails gives a `note`.

`store-checks.ts` reads the store for each probe file with a `store` block. The freshness check gets the tracked commit through a `CommitLookup` (`githubCommits` uses the GitHub API) and compares it with the `source_rev` of each shard of `repo`. A mismatch is a `note` while the commit is less than `WRITE_GRACE_MS` (2 hours) old, and a `fail` after that. The age of a branch head is its committer date, so a push of older commits can fail before its write ends. The coverage check reads the shards of `repo` from the `shards` table and counts their chunks by `title`. For a code shard, it gives a row for each declared root and a row for chunks outside every root. For a docs shard, it gives one row with the chunk count. A root, or a docs shard, with no chunks fails, and so does a repo with no code shard. A store error shows only its code, because the output is public and a driver message can name the host.

The [README](../README.md#check-a-deployed-mcp-endpoint) gives the probe file format, and [Store checks](../README.md#store-checks) gives the `store` block.

## Migrations

The SQL files in `migrations/` are the schema. Two tools apply them:

| | node-pg-migrate (`pnpm migrate up`) | `ensureSchema(db)` |
|---|---|---|
| Use for | A shared store | PGlite and throwaway local stores, and the tests |
| Records applied files | Yes, in `pgmigrations` | No |
| Runs | Only files that `pgmigrations` does not hold | The up section of each file, each call |

`ensureSchema` reads the `migrations/` directory one level above the module file (`dist/../migrations/`). It splits the up section at each `;` at a line end, because PGlite runs one statement for each query. It throws on a file that is not `.sql`, and on a file without a `-- Up Migration` marker. It runs the text from the up marker to the down marker, or to the end. `0001_initial.sql` uses `if not exists`, so `ensureSchema` can run it more than once.

node-pg-migrate does not run a file that `pgmigrations` already records. A change to an applied file never reaches a store that applied it. Do not change an applied migration: add a file with the next number. The [README](../README.md#schema-and-migrations) gives the rules for the file.
