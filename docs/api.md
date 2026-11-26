# API reference

This page lists each export of each module in the `package.json` `exports` map. The modules are in the order of the README [Modules](../README.md#modules) table, and the exports are in source order. [how-it-works.md](how-it-works.md) explains how the parts work together.

The `retrieval-mcp-check` bin (`src/checks-cli.ts`) is not in `exports`. The README [Check a deployed MCP endpoint](../README.md#check-a-deployed-mcp-endpoint) section describes it.

## walk

`@nymproject/retrieval-indexer/walk`

### `DEFAULT_EXCLUDE`

```ts
export const DEFAULT_EXCLUDE =
  /(^|\/)(node_modules|target|dist|build|out|\.next|pkg|coverage|__pycache__)(\/|$)|\.d\.[cm]?ts$/;
```

The paths that `collectSourceFiles` skips by default: build output and dependency directories at any depth, and TypeScript declaration files. `collectMarkdownPages` also applies it.

### `MAX_FILE_BYTES`

```ts
export const MAX_FILE_BYTES = 256 * 1024;
```

The default size cap of `collectSourceFiles`. A larger source file goes to `oversized` and is not read.

### `SOURCE_LIKE`

```ts
export const SOURCE_LIKE = new Set([
  'rb', 'java', 'scala', 'cs', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hxx', 'm', 'mm', 'proto', 'sh',
]);
```

Source extensions that `langOf` has no rule for. `collectSourceFiles` records a file with one of these extensions in `dropped`.

### `ACCEPTED_DROP`

```ts
export const ACCEPTED_DROP = new Set(['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'm', 'mm', 'proto', 'sh']);
```

The dropped extensions that `assertNoSilentDrops` accepts by default.

### `SourceFile`

```ts
export interface SourceFile {
  path: string;
  content: string;
}
```

A file from `collectSourceFiles`. `path` is repo-relative and `/`-separated.

### `collectSourceFiles`

```ts
export function collectSourceFiles(
  repoRoot: string,
  roots: string[],
  { exclude = DEFAULT_EXCLUDE, maxBytes = MAX_FILE_BYTES }: { exclude?: RegExp; maxBytes?: number } = {},
): { files: SourceFile[]; oversized: string[]; dropped: Record<string, string[]> }
```

Walks each root (repo-relative) below `repoRoot` and returns the chunkable files in walk order, the paths it skipped for size, and the dropped source-like files by extension. It skips a path that `exclude` matches. It skips a directory it cannot read, so a missing root gives no error. It does not throw on drops or size: call `assertNoSilentDrops` for the drops.

### `assertNoSilentDrops`

```ts
export function assertNoSilentDrops(dropped: Record<string, string[]>, accepted: Set<string> = ACCEPTED_DROP): void
```

Throws when `dropped` holds an extension outside `accepted`. The error names each extension, its file count and its files, and tells you to give `code-chunker` a rule or to add the extension to `ACCEPTED_DROP`.

### `assertRootsYieldChunks`

```ts
export function assertRootsYieldChunks(roots: string[], files: SourceFile[], chunkPaths: string[]): void
```

Throws when a root holds at least one file of `files` but no path of `chunkPaths` is at or below it. The error names the roots. A root with no files passes.

### `DOCS_EXCLUDE`

```ts
export const DOCS_EXCLUDE = /(^|\/)(CHANGELOG|CODE_OF_CONDUCT|CLAUDE|AGENTS)\.md$|(^|\/)(\.github|\.nym-codex)(\/|$)/i;
```

The paths that `collectMarkdownPages` skips by default, in addition to `DEFAULT_EXCLUDE`.

### `collectMarkdownPages`

```ts
export function collectMarkdownPages(
  repoRoot: string,
  roots: string[],
  { source, github, exclude = DOCS_EXCLUDE }: { source: string; github: string; exclude?: RegExp },
): PageRecord[]
```

Returns the `.md` files below `roots` as pages for `chunkPages`. The title is the first `# ` heading, or the repo-relative path. The URL is `${github}/${path}`. The body is the raw file. It skips empty files and directories it cannot read. Pass the same `github` as `siteUrl` to `chunkPages`, so the chunk id is the repo-relative path plus the anchor.

## chunker

`@nymproject/retrieval-indexer/chunker`

### `Section`

```ts
export interface Section {
  heading: string;
  anchor: string | null;
  level: number;
  text: string;
}
```

One heading section from `splitByHeadings`. `anchor` is the explicit `{#id}` or `[#id]` of the heading, or null. `level` is 1 for the text before the first heading, else 2 to 4.

### `MAX_CHARS`

```ts
export const MAX_CHARS = 2400;
```

The default part size of `packSection` and `chunkPages`, in characters.

### `MIN_CHARS`

```ts
export const MIN_CHARS = 120;
```

A docs size floor. No function in `chunker.ts` reads it, so `chunkPages` keeps sections of any size.

### `DEFAULT_SKIP_SLUGS`

```ts
export const DEFAULT_SKIP_SLUGS = new Set(['generate-fig-spec']);
```

The heading slugs whose sections `chunkPages` drops by default.

### `slugify`

```ts
export function slugify(heading: string): string
```

The github-slugger slug of a heading, with no de-duplication.

### `estimateTokens`

```ts
export function estimateTokens(text: string): number
```

Returns `Math.ceil(text.length / 4)`.

### `splitByHeadings`

```ts
export function splitByHeadings(body: string, pageTitle: string): Section[]
```

Splits a Markdown body at `##` to `####` headings outside code fences. The text before the first heading becomes a level 1 section with `pageTitle` as its heading. Sections with only white space are dropped.

### `packSection`

```ts
export function packSection(text: string, maxChars = MAX_CHARS): string[]
```

Returns `[text]` when it fits. Else it splits at blank lines, then at line breaks, then at `maxChars` characters, and packs the units again up to `maxChars`. No part is longer than `maxChars`.

### `chunkPages`

```ts
export function chunkPages(
  pages: PageRecord[],
  { siteUrl, repo, maxChars = MAX_CHARS, skipSlugs = DEFAULT_SKIP_SLUGS }: { siteUrl: string; repo?: string; maxChars?: number; skipSlugs?: Set<string> },
): Chunk[]
```

Turns pages into chunks: one or more parts for each section. The id is `${repo}/` (when `repo` is set), the page URL without `${siteUrl}/`, the anchor, and `~<n>` when the section has more than one part. The URL is the page URL plus the anchor. Docs chunks never have `test`.

## mdx

`@nymproject/retrieval-indexer/mdx`

### `Frontmatter`

```ts
export type Frontmatter = Record<string, unknown>;
```

Parsed frontmatter data.

### `FenceState`

```ts
export type FenceState = 'open' | 'inside' | 'close' | null;
```

The value a `FenceTracker` returns for one line. `null` is a line outside any fence.

### `FenceTracker`

```ts
export interface FenceTracker {
  (line: string): FenceState;
  info: string;
  isOpen(): boolean;
}
```

The function that `fenceTracker` returns. `info` is the info string of the open fence. `isOpen()` tells whether a fence is open after the last line.

### `InlineOptions`

```ts
export interface InlineOptions {
  filePath: string;
  root: string;
  lineOffset?: number;
  aliases?: Record<string, string>;
  citation?: (id: string, attrs: string) => string;
  link?: (id: string) => string;
  seen?: Set<string>;
}
```

The options of `inlineMdxPartials`. `lineOffset` is the number of frontmatter lines above the content, so an error gives the line in the file. `seen` holds the files on the current include path.

### `Expand`

```ts
export type Expand = (tag: string, attrs: string, ctx: Record<string, unknown>) => string | null;
```

The `expand` callback of `stripMdx`. Return text to replace a whole-line JSX tag, or `null` to remove it.

### `parseFrontmatter`

```ts
export function parseFrontmatter(raw: string): { data: Frontmatter; content: string }
```

Parses a leading frontmatter block with gray-matter. A `---` in the body stays in `content`.

### `pageTitle`

```ts
export function pageTitle(data: Frontmatter, content: string, fallback: string): string
```

Returns the frontmatter `title`, else the first `# ` heading in `content`, else `fallback` with `-` and `_` replaced by spaces.

### `pageDescription`

```ts
export function pageDescription(data: Frontmatter): string
```

Returns the frontmatter `description` as a string, or `''`.

### `fenceTracker`

```ts
export function fenceTracker(): FenceTracker
```

Returns a tracker that you call once for each line, in order. It follows the CommonMark rule: three or more backticks or tildes open a fence, and a line of the same character, at least as long, with no info string, closes it. A backtick opener whose info string holds a backtick does not open a fence.

### `HEADING_ANCHOR`

```ts
export const HEADING_ANCHOR = /\s*(?:\{#([\w-]+)\}|\[#([^\]]+)\])\s*$/;
```

An explicit anchor at the end of a heading: `{#anchor}` (group 1) or `[#anchor]` (group 2).

### `stripHeadingIds`

```ts
export function stripHeadingIds(body: string): string
```

Removes `HEADING_ANCHOR` from heading lines (`#` to `######`) outside code fences.

### `inlineMdxPartials`

```ts
export function inlineMdxPartials(content: string, opts: InlineOptions): string
```

Replaces each `<Snippet id="..." />` with `citation(id, attrs)` and each `](snippet:<id>)` with `](<link(id)>)`, when those callbacks are set. Then it replaces each `<Name />` tag of a default `.mdx` import with the partial's text, recursively. `content` is the body without frontmatter. Throws, with `filePath:line`, when an import does not resolve to a file, and when `citation` or `link` throws. An error in a partial gets the importing file, line and specifier as a prefix. A cycle stops at the first repeated file.

### `frontmatterLines`

```ts
export const frontmatterLines = (raw: string, content: string): number => raw.split('\n').length - content.split('\n').length;
```

The number of lines that `parseFrontmatter` removed from `raw`.

### `CITATION`

```ts
export const CITATION = /<Snippet\s+(?=[^>]*?\bid="([^"]+)")([^>]*?)\s*\/>/g;
```

A self-closing `<Snippet ... />` tag with an `id` attribute in any position. Group 1 is the id. Group 2 is all the attributes.

### `resolveImport`

```ts
export function resolveImport(spec: string, { filePath, root, aliases = {} }: { filePath: string; root: string; aliases?: Record<string, string> }): string
```

Resolves an import specifier: an `aliases` prefix to its directory, a `.` path against the directory of `filePath`, and any other path against `root`. It does not check that the file exists.

### `stripMdx`

```ts
export function stripMdx(
  content: string,
  { expand, values, context, rewrite }: {
    expand?: Expand;
    values?: Record<string, string>;
    context?: (content: string) => Record<string, unknown>;
    rewrite?: (line: string) => string;
  } = {},
): string
```

Removes imports, top-level JS statements, MDX comments, bare `{...}` lines and whole-line JSX tags from a body without frontmatter, and keeps fenced code as it is. `rewrite` runs on each line first. Then `values` replaces each `{IDENT}` it holds. `expand` gives the text for a whole-line tag, with the `ctx` that `context(content)` built once for the call. Returns the trimmed text, with runs of blank lines reduced to one.

## code-chunker

`@nymproject/retrieval-indexer/code-chunker`

### `Lang`

```ts
export type Lang = 'rust' | 'typescript' | 'kotlin' | 'swift' | 'go' | 'python';
```

A language the code chunker reads. TypeScript and JavaScript files are both `typescript`.

### `CodeChunk`

```ts
export interface CodeChunk extends Omit<Chunk, 'tokensEst'> {
  lang: Lang;
}
```

A code chunk from `chunkCodeFile`. It has no `tokensEst`.

### `CodeBlock`

```ts
export interface CodeBlock {
  text: string;
  symbol: string;
  startLine: number;
  importsOnly?: true;
}
```

A block from `chunkCode`. `startLine` is 1-indexed. `importsOnly` marks text before the first item that holds only package lines, import lines and comments that are not docs.

### `isTestCode`

```ts
export function isTestCode(repoPath: string, symbol: string, lang: Lang): boolean
```

True for a file under a test directory, a test file by name, or a Rust block whose symbol is `test` or `tests`.

### `langOf`

```ts
export function langOf(file: string): Lang | null
```

The language of a file by extension: `.rs`, `.ts`/`.tsx`/`.cts`/`.mts`/`.js`/`.jsx`/`.mjs`/`.cjs`, `.kt`/`.kts`, `.swift`, `.go`, `.py`. Returns `null` for any other file.

### `symbolOf`

```ts
export function symbolOf(line: string, lang: 'kotlin' | 'swift'): string
```

The name after the item keyword on a Kotlin or Swift item line, or `''`.

### `chunkCode`

```ts
export async function chunkCode(content: string, file: string): Promise<CodeBlock[]>
```

Splits a file at top-level items, with tree-sitter for Rust, TS, TSX, JS, Go and Python and a line rule for Kotlin and Swift. Each block starts at its item's docs. Text above the first item is a header block, marked `importsOnly` when it holds only noise. A block longer than `MAX_CHARS` splits, and a piece shorter than `MIN_CHARS` is dropped. Returns `[]` for a file with no language. Rejects when tree-sitter returns no tree.

### `chunkCodeFile`

```ts
export async function chunkCodeFile(
  content: string,
  repoPath: string,
  { repo, source, github }: { repo?: string; source: string; github: string },
): Promise<CodeChunk[]>
```

Turns the `chunkCode` blocks of one file into records. It drops `importsOnly` blocks. The id is `${repo}/${repoPath}#${i}` (no prefix when `repo` is unset), where `i` counts the dropped blocks too. The URL is `${github}/${repoPath}#L${startLine}`. Returns `[]` for a file with no language.

### `MAX_CHARS`

```ts
const MAX_CHARS = 2400;
export { MAX_CHARS, MIN_CHARS };
```

The size cap of a code block, in trimmed characters. This constant is separate from `chunker`'s `MAX_CHARS`.

### `MIN_CHARS`

```ts
const MIN_CHARS = 16;
export { MAX_CHARS, MIN_CHARS };
```

The smallest code block that `chunkCode` keeps, in trimmed characters.

## items

`@nymproject/retrieval-indexer/items`

### `Grammar`

```ts
export type Grammar = keyof typeof GRAMMARS;
```

A loadable tree-sitter grammar: `'rust' | 'typescript' | 'tsx' | 'javascript' | 'go' | 'python'`.

### `withTree`

```ts
export async function withTree<T>(text: string, grammar: Grammar, read: (root: Node) => T): Promise<T>
```

Parses `text`, passes the root node to `read`, and frees the tree after `read` returns or throws. It loads each grammar once. Rejects for a grammar it has no `.wasm` for, and when the parser returns no tree.

### `squash`

```ts
export const squash = (text: string): string => text
  .replace(/\s+/g, ' ')
  .replace(/(\w)\s+</g, '$1<')
  .replace(/<\s+/g, '<')
  .replace(/\s+>/g, '>')
  .replace(/\s*,\s*/g, ', ')
  .trim();
```

One spelling for a type or trait: white space collapsed, no space at `<` and `>`, one space after a comma.

### `isRustDocOrAttribute`

```ts
export const isRustDocOrAttribute = (node: Node): boolean =>
  node.type === 'attribute_item' ||
  ((node.type === 'line_comment' || node.type === 'block_comment') && /^(\/\/\/(?!\/)|\/\*\*(?![*/]))/.test(node.text));
```

True for a Rust attribute or an outer doc comment (`///`, `/**`). False for `////`, `/**/`, `/***` and `//!`.

### `startWithDocs`

```ts
export function startWithDocs(node: Node, attaches: (prev: Node) => boolean = isRustDocOrAttribute): number
```

The 0-indexed start row of `node` with the run of siblings directly above it that `attaches` accepts. A blank line or another node ends the run. A trailing comment on the row of the node before it does not end the run.

### `Item`

```ts
export interface Item {
  name: string;
  qualifiedName: string;
  aliases: string[];
  kind: string;
  startLine: number;
  endLine: number;
}
```

A named item from `items`. The line range is 1-indexed, inclusive, and starts at the item's docs and attributes. A method of `impl Trait for Type` has the qualified name `<Type as Trait>::method`, and `Type::method` in `aliases`.

### `items`

```ts
export async function items(text: string, lang: string): Promise<Item[]>
```

The named items of a Rust source file, including items in `mod` and `trait` bodies, `impl` methods and items in `extern` blocks. Throws for any `lang` other than `'rust'`.

### `pathSegments`

```ts
export function pathSegments(qualified: string): string[]
```

Splits a path at each `::` outside `<...>`.

### `matchSymbol`

```ts
export function matchSymbol(list: Item[], symbol: string): Item[]
```

The items whose qualified name or an alias ends with the path segments of `symbol`. `name` matches each item of that name. `Type::name` matches fewer.

## embed

`@nymproject/retrieval-indexer/embed`

### `Embeddable`

```ts
export interface Embeddable {
  title?: string;
  heading?: string;
  text: string;
}
```

The fields that `embedText` reads.

### `InputType`

```ts
export type InputType = 'document' | 'query';
```

The embedding input type. Indexing uses `document`. `embedQuery` uses `query`.

### `EmbedProvider`

```ts
export interface EmbedProvider {
  name: string;
  model: string;
  dim: number;
  embed(texts: string[], inputType?: InputType): Promise<number[][]>;
}
```

An embedding provider. `model` and `dim` go into each `chunkHash` and into the shard row.

### `EmbedCache`

```ts
export type EmbedCache = Map<string, number[]>;
```

A vector cache, from `chunkHash` key to vector.

### `loadCache`

```ts
export function loadCache(file: string): EmbedCache
```

Reads a cache that `saveCache` wrote. Returns an empty cache when the file does not exist. Throws when it cannot read or parse the file, and tells you to delete it.

### `saveCache`

```ts
export function saveCache(file: string, cache: EmbedCache): void
```

Writes the cache to a temporary file, then renames it to `file`. It creates the parent directory.

### `EmbedStats`

```ts
export interface EmbedStats {
  total: number;
  embedded: number;
  cached: number;
}
```

The counts that `embedChunks` returns.

### `contentHash`

```ts
export function contentHash(text: string): string
```

The SHA-256 of `text`, in hex.

### `fetchWithRetry`

```ts
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  { delaysMs = RETRY_DELAYS_MS, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }: { delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response>
```

`fetch` with retries on a thrown request, a 429 and a 5xx. The default waits are 1, 2, 4, 8 and 16 seconds. A `Retry-After` value in seconds sets the wait, up to 60 seconds. Returns any other response at once, and the last response after the last retry. Rethrows the error of a request that throws after the last retry.

### `voyageProvider`

```ts
export function voyageProvider({ apiKey, model = 'voyage-3-large', dim = 1024 }: { apiKey: string; model?: string; dim?: number }): EmbedProvider
```

A provider for the Voyage embeddings API. It sends `input_type` from the input type, and does not send `dim`. `embed` throws `voyage embeddings <status>: <body>` on a response that is not OK after the retries.

### `selfHostedProvider`

```ts
export function selfHostedProvider(
  { url, model, dim = 1024, queryInstruction, apiKey }: { url: string; model: string; dim?: number; queryInstruction?: string; apiKey?: string },
): EmbedProvider
```

A provider for an OpenAI-compatible `/v1/embeddings` endpoint. `url` is the full endpoint. `queryInstruction` goes before each query text. `apiKey` sets a bearer token. Throws at once when `url` or `model` is empty. `embed` throws on a response that is not OK, on a response with no `data` array, on a vector count that differs from the input count, and on `index` values that are not `0` to `n - 1`. It sorts the vectors by `index` when each one has an `index`.

### `embedText`

```ts
export function embedText(chunk: Embeddable): string
```

The title, the heading and the text, joined with line breaks. It leaves out an empty title or heading, and a heading equal to the title.

### `mockProvider`

```ts
export function mockProvider({ dim = 8 }: { dim?: number } = {}): EmbedProvider
```

A provider for tests, with no network. The vector of a text comes from its SHA-256, so the same text gives the same vector. Its model is `mock`.

### `chunkHash`

```ts
export function chunkHash(chunk: Embeddable, provider: Pick<EmbedProvider, 'model' | 'dim'>): string
```

The cache and store key of a chunk: `${model}:${dim}:${contentHash(embedText(chunk))}`.

### `embedChunks`

```ts
export async function embedChunks<C extends Embeddable>(
  chunks: C[],
  provider: EmbedProvider,
  cache: EmbedCache = new Map(),
  { batchSize = 128, concurrency = 1, onProgress }: {
    batchSize?: number;
    concurrency?: number;
    onProgress?: (p: { done: number; total: number; cache: EmbedCache }) => void;
  } = {},
): Promise<{ embedded: (C & { vector: number[] })[]; cache: EmbedCache; stats: EmbedStats }>
```

Embeds the chunks whose key is not in `cache`, in batches of at most `batchSize` chunks and about 80,000 tokens, with at most `concurrency` batches at a time. It adds each vector to `cache` and returns the same `cache`. A batch that the provider rejects for size splits in half. Throws when `concurrency` is not an integer of 1 or more, when a batch returns the wrong number of vectors, when the provider throws, and when a vector length differs from `provider.dim`. After a failure, no further batch starts.

### `embedQuery`

```ts
export async function embedQuery(text: string, provider: EmbedProvider): Promise<number[]>
```

Embeds one search query with the input type `query`.

## store

`@nymproject/retrieval-indexer/store`

### `Connection`

```ts
export interface Connection {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
```

One database connection: a pg `Client`, a client from a pg `Pool`, or PGlite. A `Pool` itself fits the type, but `indexShards` refuses it.

### `Modality`

```ts
export type Modality = 'docs' | 'code';
```

The two modalities of a store.

### `StoreChunk`

```ts
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
```

A chunk as the store writes and returns it. `Chunk` and `CodeChunk` both fit it.

### `ShardStats`

```ts
export interface ShardStats {
  total: number;
  embedded: number;
  unchanged: number;
  deleted: number;
}
```

The counts of one shard write. `embedded` is the number of changed chunks.

### `StoreConnectionConfig`

```ts
export interface StoreConnectionConfig {
  connectionString: string;
  ssl?: { ca: string };
}
```

The pg options that `storeConnection` returns.

### `storeConnection`

```ts
export function storeConnection(url: string, ca?: string): StoreConnectionConfig
```

Returns pg options for a store. With `ca`, it returns `ssl: { ca }`. It throws when `ca` does not contain `-----BEGIN CERTIFICATE-----`, and when the URL sets `sslmode`, `sslrootcert`, `sslcert` or `sslkey`. Without `ca`, it throws when the URL sets none of those four parameters.

### `ensureSchema`

```ts
export async function ensureSchema(db: Connection): Promise<void>
```

Runs the up section of each file in `migrations/`, in file name order, one statement at a time. It records nothing, so use it only on PGlite or a throwaway local store. Throws when a file is not `.sql`, when a file has no `-- Up Migration` marker, and when a statement fails.

### `ShardRun`

```ts
export interface ShardRun {
  repo: string;
  chunks: StoreChunk[];
  sourceRev?: string | null;
}
```

One shard's input to `indexShards`. `sourceRev` is the source commit, which goes to `shards.source_rev`.

### `indexShards`

```ts
export async function indexShards(
  db: Connection,
  modality: Modality,
  runs: ShardRun[],
  { provider, concurrency, maxShrink }: { provider: EmbedProvider; concurrency?: number; maxShrink?: number },
): Promise<Map<string, ShardStats>>
```

Replaces the shard `${repo}/${modality}` of each run with its chunks, in one transaction under a store-wide advisory lock. It embeds only chunks whose id has no stored row with the same hash, and deletes stored rows that the run does not hold. Returns the stats by shard name. Throws, and writes nothing, on a `pg.Pool`, an empty run, an id that is in the call twice, an id that another shard owns, a model or dimension that differs from another shard of the modality outside the call, a run with fewer than `(1 - maxShrink)` of the stored rows, a shard that another writer changed during the embed, and an embed failure.

### `indexShard`

```ts
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
): Promise<ShardStats>
```

Calls `indexShards` with one run and returns the stats of that shard. It throws what `indexShards` throws.

## search

`@nymproject/retrieval-indexer/search`

### `TEST_SCORE_PENALTY`

```ts
export const TEST_SCORE_PENALTY = 0.05;
```

The value that `search` subtracts from the cosine score of a chunk with `test`.

### `StoreHit`

```ts
export interface StoreHit {
  chunk: StoreChunk;
  score: number;
}
```

One search result.

### `SEARCH_SQL`

```ts
export const SEARCH_SQL = `
  with scored as (
    select c.id, c.source, c.title, c.heading, c.url, c.text, c.lang, c.tokens_est, c.test,
      1 - (c.embedding <=> $2::vector) - case when c.test then $3::float8 else 0 end as score
    from chunks c join shards s on s.shard = c.shard
    where c.modality = $1 and s.model = $5
  )
  select * from scored where score >= 0 order by score desc, id limit $4`;
```

The ranking statement. Parameters: `$1` modality, `$2` query vector as pgvector text, `$3` test penalty, `$4` limit, `$5` model. It keeps rows with a score of 0 or more, orders by score then `id`, and reads only rows of the model `$5`.

### `modalityModel`

```ts
export async function modalityModel(db: Connection, modality: Modality): Promise<{ model: string; dim: number } | null>
```

The model and dimension of one shard of the modality, or `null` when the modality has no shard.

### `modalities`

```ts
export async function modalities(db: Connection): Promise<Set<Modality>>
```

The modalities that have at least one chunk.

### `search`

```ts
export async function search(
  db: Connection,
  modality: Modality,
  queryVector: number[],
  { topK = 6, model }: { topK?: number; model?: string } = {},
): Promise<StoreHit[]>
```

Ranks the chunks of a modality against `queryVector` with `SEARCH_SQL`. Returns `[]` when the modality has no shard and `model` is unset. Throws when the modality has no shard and `model` is set, when `model` differs from the stored model, and when the vector length differs from the stored dimension.

### `getSection`

```ts
export async function getSection(db: Connection, idOrUrl: string): Promise<StoreChunk | null>
```

A docs section by id or URL. It matches rows whose id, or id before `~`, equals the argument, and else rows whose URL equals it. It takes the rows of one shard, joins their texts in part order with a blank line, and returns the id before `~`. A part id such as `x~1` returns that part only. Returns `null` when no row matches.

### `StaleShard`

```ts
export interface StaleShard {
  shard: string;
  reason: string;
}
```

One finding of `staleShards`.

### `staleShards`

```ts
export async function staleShards(
  db: Connection,
  { maxAgeMs, expectedRevs = {} }: { maxAgeMs: number; expectedRevs?: Record<string, string> },
): Promise<StaleShard[]>
```

The shards whose `last_run` is older than `maxAgeMs`, and the shards whose `source_rev` differs from their value in `expectedRevs`, in shard order. A shard can appear twice, once for each reason.

## types

`@nymproject/retrieval-indexer/types`

### `PageRecord`

```ts
export interface PageRecord {
  source: string;
  title: string;
  description?: string;
  url: string;
  body: string;
}
```

A page before chunking. `url` is the page URL without an anchor. `body` is Markdown. `chunkPages` does not read `description`.

### `Chunk`

```ts
export interface Chunk {
  id: string;
  source: string;
  title: string;
  heading: string;
  url: string;
  text: string;
  tokensEst: number;
  test?: true;
}
```

One retrievable unit. `chunkPages` returns it. `url` is the deep link. `test` marks test code, which search ranks lower.

### `EmbeddedChunk`

```ts
export interface EmbeddedChunk extends Chunk {
  vector: number[];
}
```

A `Chunk` with its vector. No function in the package takes or returns this type.

### `DocIndex`

```ts
export interface DocIndex {
  schema: number;
  generated: string | null;
  embedding: {
    provider: string | null;
    model: string | null;
    dim: number | null;
  };
  chunks: EmbeddedChunk[];
}
```

The shape of a portable index file: embedded chunks and the model they were built with. `generated` is an ISO time stamp. No function in the package reads or writes this type.

### `SearchHit`

```ts
export interface SearchHit {
  chunk: Chunk;
  score: number;
}
```

A result over `Chunk`, without the vector. No function in the package returns it: `search` returns `StoreHit`.

## checks

`@nymproject/retrieval-indexer/checks`

### `PROBE_FORMAT_VERSION`

```ts
export const PROBE_FORMAT_VERSION = 1;
```

The probe file format version that `parseProbeFile` reads.

### `Probe`

```ts
export interface Probe {
  group?: string;
  label: string;
  tool: string;
  args?: Record<string, unknown>;
  match?: string | string[];
  notMatch?: string;
  isError?: boolean;
  path?: { repo: string; path: string };
  roundTrip?: boolean;
  advisory?: boolean;
}
```

One probe. The README [Check a deployed MCP endpoint](../README.md#check-a-deployed-mcp-endpoint) table describes each field.

### `StoreDeclaration`

```ts
export interface StoreDeclaration {
  repo: string;
  github: string;
  tracks: { branch: string } | { release: 'latest' };
  roots: string[];
}
```

The `store` block of a probe file. The README [Store checks](../README.md#store-checks) table describes each field.

### `ProbeFile`

```ts
export interface ProbeFile {
  version: typeof PROBE_FORMAT_VERSION;
  name: string;
  tools?: string[];
  store?: StoreDeclaration;
  probes: Probe[];
}
```

A parsed probe file.

### `CheckStatus`

```ts
export type CheckStatus = 'pass' | 'fail' | 'note';
```

The status of one check. A `note` does not fail the run.

### `CheckResult`

```ts
export interface CheckResult {
  source: string;
  group: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}
```

One check result. `source` is the probe file name, `server` for the transport checks, or `store` when the CLI cannot connect to the store. `detail` holds the failure reason.

### `ToolResult`

```ts
export interface ToolResult {
  text: string;
  isError: boolean;
}
```

The first text block of a `tools/call` result, and its `isError` flag.

### `McpClient`

```ts
export interface McpClient {
  rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(init: { method: 'GET' | 'POST'; accept: string; body?: string }): Promise<number>;
}
```

The client that `runChecks` uses. `rpc` sends one JSON-RPC request and returns its `result`. `status` sends a raw request and returns the HTTP status.

### `parseProbeFile`

```ts
export function parseProbeFile(text: string, source: string): ProbeFile
```

Parses and validates a probe file. Throws, with `source` in the message, when the text is not JSON, the version is not 1, `name` is empty, `tools` is not a list of strings, the `store` block is not valid, `probes` is empty, a probe has no `label` or `tool`, a probe has none of `match`, `notMatch`, `isError`, `path` or `roundTrip`, a regex is not valid, or `path` lacks `repo` or `path`.

### `parseRpcBody`

```ts
export function parseRpcBody(body: string): Record<string, unknown>
```

Returns the `result` of an MCP response body. For an SSE body, it reads the last `data: ` line. Throws when the payload is not JSON, holds a JSON-RPC `error`, or has no `result`.

### `mcpClient`

```ts
export function mcpClient(url: string, { bypass, fetchImpl = fetch }: { bypass?: string; fetchImpl?: typeof fetch } = {}): McpClient
```

An `McpClient` over HTTP `POST`. `rpc` sends `Accept: application/json, text/event-stream` and throws `HTTP <status>: <body>` on a response that is not OK. `bypass` sets the `x-vercel-protection-bypass` header.

### `runChecks`

```ts
export async function runChecks(client: McpClient, files: ProbeFile[]): Promise<CheckResult[]>
```

Runs the transport checks once, then the tool list checks and the probes of each file, in order. It does not throw for a probe: an error becomes the `detail` of a `fail`, or of a `note` for an `advisory` probe.

### `tally`

```ts
export function tally(results: CheckResult[]): Record<CheckStatus, number>
```

The number of results of each status.

### `formatText`

```ts
export function formatText(results: CheckResult[]): string
```

The results as plain text, grouped by source and group, with a count line at the end.

### `formatMarkdown`

```ts
export function formatMarkdown(results: CheckResult[], endpoint: string): string
```

A Markdown summary: a heading with the run status, the counts, and a table of the results that did not pass.

## store-checks

`@nymproject/retrieval-indexer/store-checks`

### `ExpectedCommit`

```ts
export interface ExpectedCommit {
  ref: string;
  sha: string;
  since: Date;
}
```

The commit that a producer's shards must be built from. `ref` is the branch or the release tag. `since` is the commit date on the branch, or the release publish date.

### `CommitLookup`

```ts
export interface CommitLookup {
  branchHead(github: string, branch: string): Promise<ExpectedCommit>;
  latestRelease(github: string): Promise<ExpectedCommit>;
}
```

Looks up the commit that a `tracks` value names.

### `CoverageRow`

```ts
export interface CoverageRow {
  shard: string;
  root: string;
  chunks: number;
}
```

One row of the coverage table. `root` is a code root, `OUTSIDE`, or `(all)` for a docs shard.

### `WRITE_GRACE_MS`

```ts
export const WRITE_GRACE_MS = 2 * 60 * 60 * 1000;
```

Two hours. A freshness mismatch for a commit younger than this is a `note`.

### `OUTSIDE`

```ts
export const OUTSIDE = '(outside every root)';
```

The `root` value of the coverage row for chunks under no declared root.

### `storeError`

```ts
export function storeError(e: unknown, failure = 'the store query failed'): string
```

Returns `failure` with the error's `code` in brackets, or `no error code`. It never includes the error message.

### `githubCommits`

```ts
export function githubCommits({ token, fetchImpl = fetch }: { token?: string; fetchImpl?: typeof fetch } = {}): CommitLookup
```

A `CommitLookup` over the GitHub REST API, with `token` as a bearer token when it is set. `latestRelease` reads the latest release, then the commit of its tag. Each call throws `GitHub <path>: HTTP <status>` on a response that is not OK.

### `storeChecks`

```ts
export async function storeChecks(
  db: Connection,
  files: ProbeFile[],
  commits: CommitLookup,
  now = Date.now(),
): Promise<{ results: CheckResult[]; rows: CoverageRow[] }>
```

Runs the freshness and coverage checks for each file with a `store` block. A failed commit lookup or store query becomes a `fail` result, with the store error by code only.

### `formatCoverage`

```ts
export function formatCoverage(rows: CoverageRow[]): string
```

The coverage rows as a Markdown table, or `''` when there are no rows.
