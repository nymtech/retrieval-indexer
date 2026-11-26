// Embedding step for the docs index: pluggable provider + content-hash cache.
//
// The provider is an interface (`EmbedProvider`) so the default (Voyage) can be
// swapped without touching the pipeline. The cache keys vectors by the model, the
// dimension and the SHA-256 of the embed text (title, heading and text): on a typical deploy only changed chunks hit the provider, which
// both cuts build latency and decouples the build from the embedding API's
// uptime (an outage reuses cached vectors instead of failing).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** What `embedText` reads from a chunk. */
export interface Embeddable {
  title?: string;
  heading?: string;
  text: string;
}

export type InputType = 'document' | 'query';

export interface EmbedProvider {
  name: string;
  model: string;
  dim: number;
  embed(texts: string[], inputType?: InputType): Promise<number[][]>;
}

/** hash -> vector */
export type EmbedCache = Map<string, number[]>;

/**
 * Read a vector cache written by `saveCache`. A missing file is an empty cache;
 * an unreadable one is an error, so a corrupt cache is not silently replaced by a
 * full, paid re-embed.
 */
export function loadCache(file: string): EmbedCache {
  if (!fs.existsSync(file)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf-8'))));
  } catch (error) {
    throw new Error(`embed cache ${file} is unreadable; delete it to re-embed from scratch`, { cause: error });
  }
}

/**
 * Write the cache through a temporary file and a rename, so a build killed in
 * the middle of a save leaves the previous cache, not a truncated one that
 * loadCache then refuses.
 */
export function saveCache(file: string, cache: EmbedCache): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(cache)));
  fs.renameSync(tmp, file);
}

export interface EmbedStats {
  total: number;
  embedded: number;
  cached: number;
}

/** Stable content key for the vector cache. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// A rate limit (429), a server error (5xx) or a dropped connection is usually
// gone seconds later. Without a retry, one of them fails a run that has already
// paid for most of its embeddings, and the next run pays for them again.
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * `fetch`, retried with backoff on a 429, a 5xx, or a request that throws. A
 * `Retry-After` header in seconds sets the wait, up to a minute. Any other
 * response, and the last one after the final retry, is returned for the caller
 * to check.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  { delaysMs = RETRY_DELAYS_MS, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }: { delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (error) {
      if (attempt >= delaysMs.length) throw error;
      await sleep(delaysMs[attempt]!);
      continue;
    }
    if (res.ok || !(res.status === 429 || res.status >= 500) || attempt >= delaysMs.length) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : delaysMs[attempt]!);
  }
}

/**
 * Voyage provider (default). voyage-3-large returns unit-normalised 1024-dim
 * vectors and retrieves noticeably better than the older voyage-3. Uses
 * input_type to distinguish document (indexing) from query embeddings, which
 * improves retrieval quality on asymmetric search.
 *
 * NB: index and query MUST use the same model. Changing this default requires a
 * re-index; querying a voyage-3 index with voyage-3-large
 * vectors returns garbage.
 */
export function voyageProvider({ apiKey, model = 'voyage-3-large', dim = 1024 }: { apiKey: string; model?: string; dim?: number }): EmbedProvider {
  return {
    name: 'voyage',
    model,
    dim,
    async embed(texts, inputType = 'document') {
      const res = await fetchWithRetry('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: texts, model, input_type: inputType }),
      });
      if (!res.ok) {
        throw new Error(`voyage embeddings ${res.status}: ${await res.text()}`);
      }
      const json = await res.json();
      return json.data.map((d: { embedding: number[] }) => d.embedding);
    },
  };
}

/**
 * Self-hosted embedding through an OpenAI-compatible `/v1/embeddings` endpoint
 * (text-embeddings-inference, Ollama, vLLM, LocalAI, llama.cpp server). Use this
 * for a private store whose content cannot go to a third-party API.
 *
 * `url` is the full endpoint. `model` has no default on purpose: the model name
 * is the cache key and the vector-space identity, so a shared default could let
 * two different models cache under one key and mix their vectors. If
 * `queryInstruction` is set it is prepended to query texts only (not documents);
 * some instruction-tuned embedding models retrieve better with it. Set `apiKey`
 * for an endpoint behind a bearer token (vLLM `--api-key`, or a gateway).
 */
export function selfHostedProvider(
  { url, model, dim = 1024, queryInstruction, apiKey }: { url: string; model: string; dim?: number; queryInstruction?: string; apiKey?: string },
): EmbedProvider {
  if (!url) throw new Error('selfHostedProvider needs a url: the full OpenAI-compatible embeddings endpoint, e.g. http://localhost:8080/v1/embeddings');
  if (!model) throw new Error('selfHostedProvider needs a model name: it is the cache key and the vector-space identity, so two models cannot be told apart without it');
  return {
    name: 'self-hosted',
    model,
    dim,
    async embed(texts, inputType = 'document') {
      const input = inputType === 'query' && queryInstruction ? texts.map((t) => `${queryInstruction}${t}`) : texts;
      const res = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ input, model }),
      });
      if (!res.ok) throw new Error(`self-hosted embeddings ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { data?: { embedding: number[]; index?: number }[] };
      const data = json.data;
      if (!Array.isArray(data)) throw new Error(`self-hosted endpoint returned no data array (got ${JSON.stringify(json).slice(0, 120)})`);
      if (data.length !== texts.length) throw new Error(`self-hosted endpoint returned ${data.length} vectors for ${texts.length} inputs`);
      const hasIndex = data.every((d) => typeof d.index === 'number');
      const ordered = hasIndex ? [...data].sort((a, b) => a.index! - b.index!) : data;
      if (hasIndex && ordered.some((d, i) => d.index !== i)) throw new Error('self-hosted endpoint returned non-contiguous indices');
      return ordered.map((d) => d.embedding);
    },
  };
}

/**
 * The string a chunk is embedded and cached under.
 *
 * Body prose usually assumes its own topic: a section under "Threat actors" that
 * discusses L2 rarely repeats the page title, so a search for the topic misses a
 * chunk that is entirely about it. Prepending the page title and section heading
 * puts that topic in the vector.
 *
 * `chunk.text` stays the body alone, because that is what is displayed and
 * returned to callers. Only the embedded representation carries the headers.
 */
export function embedText(chunk: Embeddable): string {
  const header = [chunk.title, chunk.heading].filter(Boolean);
  // A chunk before the first subheading carries the title as its heading; do not
  // repeat it.
  const unique = header.filter((h, i) => header.indexOf(h) === i);
  return [...unique, chunk.text].join('\n');
}

/**
 * Deterministic mock provider for tests (no network). Derives a pseudo-vector
 * from the text hash so the same text always yields the same vector.
 */
export function mockProvider({ dim = 8 }: { dim?: number } = {}): EmbedProvider {
  return {
    name: 'mock',
    model: 'mock',
    dim,
    async embed(texts) {
      return texts.map((t) => {
        const h = createHash('sha256').update(t).digest();
        return Array.from({ length: dim }, (_, i) => (h[i % h.length] / 255) * 2 - 1);
      });
    },
  };
}

/**
 * The key a chunk's vector is cached and stored under: the model, the dimension,
 * and the hash of the embedded text. A model or dimension change changes every
 * key, so vectors from two models never mix.
 */
export function chunkHash(chunk: Embeddable, provider: Pick<EmbedProvider, 'model' | 'dim'>): string {
  return `${provider.model}:${provider.dim}:${contentHash(embedText(chunk))}`;
}

/**
 * Embed chunks, reusing cached vectors by content hash. Only cache-miss chunks
 * are sent to the provider, in batches, with at most `concurrency` batches in
 * flight. `cache` is mutated and returned.
 *
 * The default of one batch at a time suits a rate-limited hosted API. A
 * self-hosted server (text-embeddings-inference takes hundreds of concurrent
 * requests) is round-trip bound when fed serially, so its pipeline raises it.
 */
export async function embedChunks<C extends Embeddable>(
  chunks: C[],
  provider: EmbedProvider,
  cache: EmbedCache = new Map(),
  { batchSize = 128, concurrency = 1, onProgress }: {
    batchSize?: number;
    concurrency?: number;
    onProgress?: (p: { done: number; total: number; cache: EmbedCache }) => void;
  } = {},
): Promise<{ embedded: (C & { vector: number[] })[]; cache: EmbedCache; stats: EmbedStats }> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`concurrency must be an integer of at least 1, got ${concurrency}`);
  const hashes = chunks.map((c) => chunkHash(c, provider));

  const missIdx: number[] = [];
  hashes.forEach((h, i) => {
    if (!cache.has(h)) missIdx.push(i);
  });

  // Batch by an estimated token budget (Voyage caps a batch at 120k tokens, and
  // code tokenizes far denser than prose). The estimate only keeps splits rare;
  // embedBatch below is the real safety net.
  const TOKEN_BUDGET = 80_000;
  const estTokens = (t: string) => Math.ceil(t.length / 1.5);

  // Embed a batch, halving and retrying if the provider still rejects it for too
  // many tokens. Robust to any content density; terminates because a single
  // (size-capped) chunk never exceeds the cap.
  async function embedBatch(texts: string[]): Promise<number[][]> {
    try {
      return await provider.embed(texts);
    } catch (e) {
      if (texts.length > 1 && /too many tokens|max(?:imum)? allowed (?:tokens|batch)|batch size/i.test(e instanceof Error ? e.message : String(e))) {
        const mid = Math.ceil(texts.length / 2);
        const head = await embedBatch(texts.slice(0, mid));
        const tail = await embedBatch(texts.slice(mid));
        return [...head, ...tail];
      }
      throw e;
    }
  }

  const batches: number[][] = [];
  let b = 0;
  while (b < missIdx.length) {
    const batch: number[] = [];
    let tokens = 0;
    while (
      b < missIdx.length &&
      batch.length < batchSize &&
      (batch.length === 0 || tokens + estTokens(embedText(chunks[missIdx[b]])) <= TOKEN_BUDGET)
    ) {
      tokens += estTokens(embedText(chunks[missIdx[b]]));
      batch.push(missIdx[b]);
      b++;
    }
    batches.push(batch);
  }

  // Each worker takes the next unclaimed batch. After a failure no worker claims
  // another, so a dead provider is not sent the rest of the run.
  let next = 0;
  let done = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < batches.length) {
      const batch = batches[next++];
      try {
        const vectors = await embedBatch(batch.map((i) => embedText(chunks[i])));
        if (vectors.length !== batch.length) throw new Error(`${provider.name} returned ${vectors.length} vectors for ${batch.length} inputs`);
        batch.forEach((i, j) => cache.set(hashes[i], vectors[j]));
      } catch (error) {
        failed = true;
        throw error;
      }
      done += batch.length;
      if (onProgress) onProgress({ done, total: missIdx.length, cache });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));

  const embedded = chunks.map((c, i) => {
    const vector = cache.get(hashes[i]);
    if (!vector) throw new Error(`no vector for chunk ${i} after embedding`);
    if (vector.length !== provider.dim) throw new Error(`${provider.model} returned a ${vector.length}-dim vector, expected ${provider.dim}`);
    return { ...c, vector };
  });
  return {
    embedded,
    cache,
    stats: { total: chunks.length, embedded: missIdx.length, cached: chunks.length - missIdx.length },
  };
}

/** Embed a single search query (input_type=query for providers that support it). */
export async function embedQuery(text: string, provider: EmbedProvider): Promise<number[]> {
  const [vec] = await provider.embed([text], 'query');
  return vec;
}
