import { describe, it, expect } from 'vitest';
import { chunkCode, chunkCodeFile, isTestCode, langOf, symbolOf } from './code-chunker.js';

/** The block symbols of `src`, chunked as `file`. */
const symbols = async (src: string, file: string) => (await chunkCode(src, file)).map((c) => c.symbol);

describe('langOf', () => {
  it('detects rust, typescript, kotlin, swift, go and python, skips the rest', async () => {
    expect(langOf('a/b.rs')).toBe('rust');
    expect(langOf('a/b.ts')).toBe('typescript');
    expect(langOf('a/b.tsx')).toBe('typescript');
    expect(langOf('a/b.cjs')).toBe('typescript');
    expect(langOf('a/b.kt')).toBe('kotlin');
    expect(langOf('a/b.kts')).toBe('kotlin');
    expect(langOf('a/b.swift')).toBe('swift');
    expect(langOf('a/b.go')).toBe('go');
    expect(langOf('a/b.py')).toBe('python');
    expect(langOf('a/b.md')).toBe(null);
  });
});

describe('chunkCode (rust)', () => {
  const src = [
    'use foo::bar::baz;',
    '',
    'pub fn alpha() {',
    '  do_thing();',
    '}',
    '',
    'struct Beta {',
    '  x: u32,',
    '}',
    '',
    'impl Beta {',
    '  fn method(&self) {}',
    '}',
  ].join('\n');

  it('splits at top-level item boundaries and names the symbols', async () => {
    const chunks = (await chunkCode(src, 'a.rs'));
    const symbols = chunks.map((c) => c.symbol);
    expect(symbols).toContain('alpha');
    expect(symbols).toContain('Beta');
    // the `use` preamble is its own leading block, not attached to alpha
    expect(chunks[0].text.startsWith('use foo::bar::baz;')).toBe(true);
  });

  it('records a 1-based start line for each block', async () => {
    const chunks = (await chunkCode(src, 'a.rs'));
    const alpha = chunks.find((c) => c.symbol === 'alpha');
    expect(alpha?.startLine).toBe(3); // `pub fn alpha` is line 3
  });

  it('groups preceding doc comments and attributes with the item they describe', async () => {
    const withDocs = [
      'pub fn alpha() {',
      '  do_thing();',
      '}',
      '',
      '/// Beta does things.',
      '#[derive(Debug)]',
      'pub struct Beta {',
      '  x: u32,',
      '}',
    ].join('\n');
    const chunks = (await chunkCode(withDocs, 'a.rs')) as Array<{ symbol: string; text: string }>;
    const alpha = chunks.find((c) => c.symbol === 'alpha');
    const beta = chunks.find((c) => c.symbol === 'Beta');
    // the doc comment + attribute belong to Beta, not to alpha's chunk
    expect(beta?.text).toContain('/// Beta does things.');
    expect(beta?.text).toContain('#[derive(Debug)]');
    expect(alpha?.text).not.toContain('Beta does things.');
    expect(alpha?.text).not.toContain('#[derive(Debug)]');
  });
});

describe('chunkCode (typescript)', () => {
  it('splits at exported declarations and names them', async () => {
    const src = [
      "import { x } from 'y';",
      '',
      'export function setupMixTunnel() {',
      '  return 1;',
      '}',
      '',
      'export class MixClient {}',
    ].join('\n');
    const symbols = (await chunkCode(src, 'a.ts')).map((c) => c.symbol);
    expect(symbols).toContain('setupMixTunnel');
    expect(symbols).toContain('MixClient');
  });
});

describe('chunkCode (kotlin)', () => {
  const src = [
    'package com.nymtech.vpn',
    '',
    'import kotlinx.coroutines.flow.Flow',
    '',
    '/** A tunnel. */',
    '@Serializable',
    'data class TunnelConfig(val entry: String)',
    '',
    'sealed class TunnelState {',
    '  object Down : TunnelState()',
    '}',
    '',
    'fun Project.getGitHash(): String {',
    '  return "abc"',
    '}',
    '',
    'suspend fun connect(config: TunnelConfig) {',
    '  doThing()',
    '}',
  ].join('\n');

  it('splits at top-level items and names them', async () => {
    const symbols = (await chunkCode(src, 'a.kt')).map((c: { symbol: string }) => c.symbol);
    expect(symbols).toContain('TunnelConfig');
    expect(symbols).toContain('TunnelState');
    expect(symbols).toContain('connect');
  });

  it('names an extension function after the function, not the receiver', async () => {
    const chunks = (await chunkCode(src, 'a.kt')) as Array<{ symbol: string; text: string }>;
    expect(chunks.map((c) => c.symbol)).toContain('getGitHash');
    expect(chunks.map((c) => c.symbol)).not.toContain('Project');
  });

  it('groups a preceding KDoc and annotation with the item', async () => {
    const config = ((await chunkCode(src, 'a.kt')) as Array<{ symbol: string; text: string }>).find(
      (c) => c.symbol === 'TunnelConfig',
    );
    expect(config?.text).toContain('/** A tunnel. */');
    expect(config?.text).toContain('@Serializable');
  });
});

describe('chunkCode (swift)', () => {
  const src = [
    'import Foundation',
    '',
    '/// The tunnel manager.',
    '@MainActor',
    'public final class TunnelManager {',
    '  func start() {}',
    '}',
    '',
    'struct TunnelConfig {',
    '  let entry: String',
    '}',
    '',
    'extension TunnelConfig {',
    '  func validate() -> Bool { true }',
    '}',
    '',
    'func connect(_ config: TunnelConfig) {}',
  ].join('\n');

  it('splits at top-level items and names them (methods inside a type stay with it)', async () => {
    const symbols = (await chunkCode(src, 'a.swift')).map((c: { symbol: string }) => c.symbol);
    expect(symbols).toContain('TunnelManager');
    expect(symbols).toContain('TunnelConfig');
    expect(symbols).toContain('connect');
    // `start` is indented inside the class, so it is not a top-level boundary.
    expect(symbols).not.toContain('start');
  });

  it('groups a preceding doc comment and attribute with the item', async () => {
    const mgr = ((await chunkCode(src, 'a.swift')) as Array<{ symbol: string; text: string }>).find(
      (c) => c.symbol === 'TunnelManager',
    );
    expect(mgr?.text).toContain('/// The tunnel manager.');
    expect(mgr?.text).toContain('@MainActor');
  });
});

describe('chunkCode (go)', () => {
  const src = [
    'package tunnel',
    '',
    'import "context"',
    '',
    '// Server runs the tunnel.',
    'type Server struct {',
    '  addr string',
    '}',
    '',
    'func New(addr string) *Server {',
    '  return &Server{addr: addr}',
    '}',
    '',
    'func (s *Server) Start(ctx context.Context) error {',
    '  return nil',
    '}',
  ].join('\n');

  it('splits at top-level items; a method is named after the method, not the receiver', async () => {
    const chunks = (await chunkCode(src, 'a.go')) as Array<{ symbol: string; text: string }>;
    const symbols = chunks.map((c) => c.symbol);
    expect(symbols).toContain('Server');
    expect(symbols).toContain('New');
    expect(symbols).toContain('Start');
    const start = chunks.find((c) => c.symbol === 'Start');
    expect(start?.text).toContain('func (s *Server) Start');
  });
});

describe('chunkCode (python)', () => {
  const src = [
    'import os',
    '',
    '@dataclass',
    'class TunnelConfig:',
    '    entry: str',
    '',
    'async def connect(config: TunnelConfig) -> None:',
    '    await do_thing()',
    '',
    'def helper():',
    '    return 1',
  ].join('\n');

  it('splits at top-level def/class and groups a preceding decorator', async () => {
    const chunks = (await chunkCode(src, 'a.py')) as Array<{ symbol: string; text: string }>;
    const symbols = chunks.map((c) => c.symbol);
    expect(symbols).toContain('TunnelConfig');
    expect(symbols).toContain('connect');
    expect(symbols).toContain('helper');
    const cfg = chunks.find((c) => c.symbol === 'TunnelConfig');
    expect(cfg?.text).toContain('@dataclass');
  });
});

describe('chunkCodeFile', () => {
  const shard = { source: 'nym-code', github: 'https://github.com/nymtech/nym/blob/develop' };

  it('tags the source and builds a GitHub deep link with the line', async () => {
    const [chunk] = await chunkCodeFile('pub fn only() {}', 'common/nymsphinx/src/lib.rs', shard);
    expect(chunk.source).toBe('nym-code');
    expect(chunk.title).toBe('common/nymsphinx/src/lib.rs');
    expect(chunk.heading).toBe('only');
    expect(chunk.url).toBe('https://github.com/nymtech/nym/blob/develop/common/nymsphinx/src/lib.rs#L1');
    expect(chunk.lang).toBe('rust');
  });

  it('returns nothing for non-code files', async () => {
    expect(await chunkCodeFile('# readme', 'a/b.md', shard)).toEqual([]);
  });

  it('namespaces the id with the repo when one is set', async () => {
    const [chunk] = await chunkCodeFile('pub fn only() {}', 'src/lib.rs', { ...shard, repo: 'nym' });
    expect(chunk.id).toBe('nym/src/lib.rs#0');
  });
});

describe('chunkCode: rust symbols', () => {
  // Each source is one item; the cases the line rule got wrong, and the reason.
  const cases: [string, string, string][] = [
    ['impl<C> TlsWrap<C> {}', 'TlsWrap', 'not C, the generic parameter'],
    ['impl<C, S> Service<Uri> for TlsWrap<C> {}', 'TlsWrap', 'the type after `for`, not C'],
    ["impl<'a, St> BandwidthImporter<'a, St> {}", 'BandwidthImporter', "not a, from the lifetime 'a"],
    ["impl<'de> Deserialize<'de> for Recipient {}", 'Recipient', 'not de'],
    ['const fn v1_reply_surb_serialised_len() -> usize { 0 }', 'v1_reply_surb_serialised_len', 'not fn'],
    ['impl<T: Into<String>> Wrapper<T> {}', 'Wrapper', 'nested generics'],
    ['impl CheckResponse for crate::nyxd::TxResponse {}', 'TxResponse', 'not crate, the path root'],
    ['impl TendermintRpcErrorMap for reqwest::Error {}', 'Error', 'not reqwest, the path root'],
    ['impl<const N: usize> Foo<N> {}', 'Foo', 'a const generic is not the target'],
    ['impl Foo { // for Bar\n}', 'Foo', 'a trailing comment does not supply the `for` target'],
    ['unsafe impl Send for X {}', 'X', 'an unsafe impl'],
    ['impl<C> DkgQueryClient for C where C: CosmWasmClient {}', 'DkgQueryClient', 'blanket impl: the trait, not the parameter'],
    ["impl<'a> Foo for &'a mut Bar {}", 'Bar', 'a reference type'],
    ['impl<T: Debug> Show for (T, T) {}', 'Show', 'a tuple type has no name: the trait'],
    ['pub unsafe extern "C" fn nym_init() {}', 'nym_init', 'an FFI function, which the line rule missed'],
    ['pub fn new(\n    config: Config,\n) -> Self {\n    todo!()\n}', 'new', 'a multiline signature'],
    ['pub mod mixnet_client;', 'mixnet_client', 'a module declaration'],
    ['pub struct MixnetClient {}', 'MixnetClient', 'a struct'],
    ['static mut BUFFER: [u8; 32] = [0; 32];', 'BUFFER', 'a mutable static'],
    ['pub trait Transport {}', 'Transport', 'a trait'],
    ['macro_rules! ensure { () => {} }', 'ensure', 'a macro'],
  ];
  for (const [src, expected, why] of cases) {
    it(`${src.slice(0, 46)} -> ${expected} (${why})`, async () => {
      expect(await symbols(src, 'a.rs')).toEqual([expected]);
    });
  }

  it('keeps a constant with the item above it, not as its own block', async () => {
    const src = 'pub fn send() {\n    go();\n}\n\nconst MAX_HOPS: usize = 5;';
    expect(await symbols(src, 'a.rs')).toEqual(['send']);
  });

  it('groups attributes across a trailing comment', async () => {
    const src = 'use std::collections::BTreeMap;\n\n#[test]\n#[ignore] // expensive test\nfn single_sender() {\n    run();\n}';
    expect((await chunkCode(src, 'a.rs')).map((c) => [c.symbol, c.startLine])).toEqual([['', 1], ['single_sender', 3]]);
  });

  it('ignores an item inside a block comment', async () => {
    expect(await symbols('pub struct Args {\n    a: u8,\n}\n\n/*impl Args {\n    fn take(&mut self) {}\n}*/', 'a.rs')).toEqual(['Args']);
  });

  it('leaves an inner doc comment (`//!`) in the preamble, not on the first item', async () => {
    const src = '//! The crate docs, long enough to keep.\n\npub fn send() {\n    go();\n}';
    const chunks = await chunkCode(src, 'a.rs');
    expect(chunks.map((c) => [c.symbol, c.startLine])).toEqual([['', 1], ['send', 3]]);
  });
});

describe('chunkCode: typescript and javascript symbols', () => {
  it('keeps $ as a name, since it is one', async () => {
    expect(await symbols('const $ = <T extends HTMLElement>(id: string): T => {\n  return null as unknown as T;\n};', 'a.ts')).toEqual(['$']);
  });

  it('names declarations, exported or not, and skips let, destructuring, and an unnamed default export', async () => {
    const src = [
      'export default class Foo {}',
      'export default function () { return 1; }',
      'let counter = 0;',
      'const { a } = b;',
      'export function f(a: string): void;',
      'function* gen() {}',
      'abstract class Shape {}',
      'export interface Props { a: number }',
      'type Id = string;',
      'enum Colour { Red }',
    ].join('\n');
    expect(await symbols(src, 'a.ts')).toEqual(['Foo', 'f', 'gen', 'Shape', 'Props', 'Id', 'Colour']);
  });

  it('leaves a trailing comment with the item it follows', async () => {
    const src = "export const CacheDuration = 120; // 2min\nexport const PricingUrl = 'https://nym.com/pricing';";
    expect(await symbols(src, 'a.ts')).toEqual(['CacheDuration', 'PricingUrl']);
  });

  it('parses JSX in .tsx and .js files', async () => {
    expect(await symbols('export const App = () => <div className="a">{1}</div>;', 'a.tsx')).toEqual(['App']);
    expect(await symbols('/** The app. */\nexport const App = () => <div>{1}</div>;', 'a.js')).toEqual(['App']);
  });
});

describe('chunkCode: go and python symbols', () => {
  it('names a single type, var, or const, and leaves a group unnamed (the short preamble is dropped)', async () => {
    const src = ['package p', '', 'const MaxHops = 5', 'var DefaultAddr = ":0"', 'type (', '  A int', '  B = int', ')'].join('\n');
    expect(await symbols(src, 'a.go')).toEqual(['MaxHops', 'DefaultAddr', '']);
  });

  it('names an async def and a decorated class', async () => {
    expect(await symbols('async def connect(config):\n    pass\n\n@dataclass\nclass TunnelConfig:\n    entry: str', 'a.py')).toEqual(['connect', 'TunnelConfig']);
  });
});

describe('symbolOf: kotlin', () => {
  const cases: [string, string, string][] = [
    ['fun connect() {', 'connect', 'plain function'],
    ['suspend fun connect() {', 'connect', 'modifier before fun'],
    ['fun Project.getGitHash(): String {', 'getGitHash', 'extension: name, not the receiver'],
    ['val Project.gitHash: String', 'gitHash', 'extension property: name, not the receiver'],
    ['fun <T> identity(x: T): T {', 'identity', 'generics before the name are skipped'],
    ['data class TunnelConfig(val entry: String)', 'TunnelConfig', 'modifier before class'],
    ['sealed class TunnelState {', 'TunnelState', 'sealed class'],
    ['object Singleton {', 'Singleton', 'object'],
    ['const val MAX = 5', 'MAX', 'const val'],
  ];
  for (const [line, expected, why] of cases) {
    it(`${line.slice(0, 42)} -> ${expected} (${why})`, async () => {
      expect(symbolOf(line, 'kotlin')).toBe(expected);
    });
  }
});

describe('symbolOf: swift', () => {
  const cases: [string, string, string][] = [
    ['func connect() {', 'connect', 'plain function'],
    ['public final class TunnelManager {', 'TunnelManager', 'modifiers before class'],
    ['struct TunnelConfig {', 'TunnelConfig', 'struct'],
    ['extension TunnelConfig {', 'TunnelConfig', 'extension names its type'],
    ['func connect<T>(_ x: T) {', 'connect', 'generics after the name'],
    ['actor Store {', 'Store', 'actor'],
    ['static func make() -> Self {', 'make', 'static modifier'],
    ['let shared = Store()', 'shared', 'top-level let'],
  ];
  for (const [line, expected, why] of cases) {
    it(`${line.slice(0, 42)} -> ${expected} (${why})`, async () => {
      expect(symbolOf(line, 'swift')).toBe(expected);
    });
  }
});

describe('isTestCode', () => {
  it.each([
    ['common/x/tests/stack.rs', 'round_trip', 'rust'],
    ['sdk/x/src/lib.test.ts', 'it', 'typescript'],
    ['app/src/androidTest/java/a/FooTest.kt', 'FooTest', 'kotlin'],
    ['ios/AppTests/TunnelTests.swift', 'TunnelTests', 'swift'],
    ['ffi/go/client_test.go', 'TestDial', 'go'],
    ['tools/test_probe.py', 'probe', 'python'],
    ['tools/bench/src/speedtest.rs', 'tests', 'rust'],
    ['ios/ServicesMutual/Tests/ConnectionTypesTests/XCStringsResolver.swift', 'resolve', 'swift'],
    ['common/client-libs/gateway-client/src/client/tests.rs', 'claim_reverts', 'rust'],
    ['nym-node/src/directory_publisher/test_utils.rs', 'fake_node', 'rust'],
  ] as const)('flags %s', (path, symbol, lang) => {
    expect(isTestCode(path, symbol, lang)).toBe(true);
  });

  it.each([
    ['common/nymsphinx/src/preparer.rs', 'FragmentPreparer', 'rust'],
    ['sdk/x/src/testing.ts', 'helper', 'typescript'],
    ['common/attestation/src/latest.rs', 'contest', 'rust'],
    ['sdk/src/attests.rs', 'attest', 'rust'],
  ] as const)('leaves %s', (path, symbol, lang) => {
    expect(isTestCode(path, symbol, lang)).toBe(false);
  });

  it('marks a test chunk and leaves the field off production chunks', async () => {
    const shard = { source: 's', github: 'g' };
    const src = ['pub fn send() {}', '', '#[cfg(test)]', 'mod tests {', '    fn t() {}', '}'].join('\n');
    const chunks = await chunkCodeFile(src, 'src/lib.rs', shard);
    expect(chunks.map((c) => [c.heading, c.test])).toEqual([['send', undefined], ['tests', true]]);
    expect('test' in chunks[0]).toBe(false);
  });
});

describe('langOf', () => {
  it('reads .mts and .cts as TypeScript', async () => {
    expect(langOf('lib/a.mts')).toBe('typescript');
    expect(langOf('lib/a.cts')).toBe('typescript');
  });
});

describe('chunkCode oversized split', () => {
  it('keeps startLine aligned with the real source line across hard splits', async () => {
    // One Rust fn far larger than MAX_CHARS, so the block hard-splits several times.
    const body = Array.from({ length: 300 }, (_, i) => `    let v${i} = ${i};`).join('\n');
    const src = `pub fn big() {\n${body}\n}`;
    const lines = src.split('\n');
    const chunks = await chunkCode(src, 'a.rs');
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk's startLine must point at its own first line in the source.
    for (const c of chunks) expect(c.text.split('\n')[0]).toBe(lines[c.startLine - 1]!.trim());
  });
});
