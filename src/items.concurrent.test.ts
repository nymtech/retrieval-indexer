import { describe, it, expect } from 'vitest';
import { chunkCodeFile } from './code-chunker.js';

// Its own file, so no earlier test has loaded a grammar: the first calls race.
describe('grammar loading under concurrent first use', () => {
  it('chunks many files that start at the same time', async () => {
    const sources: [string, string][] = [
      ['a.rs', 'pub fn one() { let x = 1; println!("{}", x); }\n'.repeat(5)],
      ['a.go', 'package a\nfunc One() { x := 1; _ = x }\n'.repeat(5)],
      ['a.py', 'def one():\n    return 1\n'.repeat(5)],
      ['a.js', 'function one() { return 1 }\n'.repeat(5)],
    ];
    const runs = Array.from({ length: 40 }, (_, i) => sources[i % sources.length]!);
    const shard = { repo: 'r', source: 's', github: 'https://example.org' };
    const chunks = await Promise.all(runs.map(([file, text]) => chunkCodeFile(text, file, shard)));
    expect(chunks.every((list) => list.length > 0)).toBe(true);
  });
});
