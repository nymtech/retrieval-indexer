// Code chunker: splits source files into retrieval-sized units at top-level item
// boundaries (fn / struct / impl / class / export ...), with a hard size cap.
// Tree-sitter finds the items and their names for Rust, TS/JS, Go, and Python.
// Kotlin and Swift keep a line rule until their grammars ship a loadable .wasm.
//
// Emits chunks shaped like the docs Chunk (title/heading/url/text/source) so the
// same retrieval.search() works over the code index unchanged.

import type { Node } from 'web-tree-sitter';
import { startWithDocs, isRustDocOrAttribute, withTree, type Grammar } from './items.js';
import type { Chunk } from './types.js';

export type Lang = 'rust' | 'typescript' | 'kotlin' | 'swift' | 'go' | 'python';

export interface CodeChunk extends Omit<Chunk, 'tokensEst'> {
  lang: Lang;
}

export interface CodeBlock {
  text: string;
  symbol: string;
  /** 1-indexed */
  startLine: number;
}

const TEST_DIR = /(^|\/)(tests?|Tests|__tests__|androidTest|\w+Tests)\//;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$|Tests?\.(kt|swift)$|(^|\/)(tests?|test_utils)\.rs$/;
const TEST_ITEM = new Set(['tests', 'test']);

/** A test file, a file under a test directory, or a Rust `mod tests` block or `tests.rs` module. */
export function isTestCode(repoPath: string, symbol: string, lang: Lang): boolean {
  return TEST_DIR.test(repoPath) || TEST_FILE.test(repoPath) || (lang === 'rust' && TEST_ITEM.has(symbol));
}

const MAX_CHARS = 2400;
// Lower than the docs floor: small code items (a one-line fn, a tiny struct) are
// legitimate and worth indexing; we only want to drop empty/near-empty blocks.
const MIN_CHARS = 16;

// Top-level item kinds per grammar. A `const` item in Rust and a `let`/`var` in
// TS/JS are not boundaries: a small constant rides with the item before it.
const RUST_ITEMS = new Set([
  'function_item', 'struct_item', 'enum_item', 'union_item', 'trait_item', 'impl_item', 'mod_item', 'type_item', 'static_item', 'macro_definition',
]);
const TS_ITEMS = new Set([
  'function_declaration', 'generator_function_declaration', 'function_signature', 'class_declaration', 'abstract_class_declaration',
  'interface_declaration', 'type_alias_declaration', 'enum_declaration',
]);
const GO_ITEMS = new Set(['function_declaration', 'method_declaration', 'type_declaration', 'var_declaration', 'const_declaration']);
const PY_ITEMS = new Set(['function_definition', 'class_definition']);

/** `crate::nyxd::TxResponse` names the type `TxResponse`, not the crate. */
const lastSegment = (p: string): string => p.split('::').filter(Boolean).pop() ?? '';
/** The leading path of a type, past a reference or `dyn`: `&'a mut TlsWrap<C>` -> `TlsWrap`. */
const typeHead = (text: string): string =>
  lastSegment(text.replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, '').replace(/^dyn\s+/, '').match(/^[A-Za-z_][\w:]*/)?.[0] ?? '');

/**
 * The type an `impl` block is about: the concrete type in both `impl Type` and
 * `impl Trait for Type`. In a blanket impl (`impl<C> DkgQueryClient for C`) the
 * type is a parameter no one searches for, so the trait names the block.
 */
function implTarget(impl: Node): string {
  // Type parameters declared by this impl. Lifetimes never match, since `'` is
  // not a leading identifier character.
  const params = impl.childForFieldName('type_parameters')?.text ?? '';
  const declared = new Set([...params.matchAll(/(?:^|[<,])\s*(?:const\s+)?([A-Za-z_]\w*)/g)].map((m) => m[1]));
  const type = typeHead(impl.childForFieldName('type')?.text ?? '');
  const trait = impl.childForFieldName('trait');
  if (type && !(trait && declared.has(type))) return type;
  return trait ? typeHead(trait.text) : type;
}

const nameOf = (node: Node | null | undefined): string => node?.childForFieldName('name')?.text ?? '';

/** The symbol of a top-level node, `''` for an item with no name, or null for a node that is not an item. */
const SYMBOL: Record<Grammar, (node: Node) => string | null> = {
  rust: (node) => (node.type === 'impl_item' ? implTarget(node) : RUST_ITEMS.has(node.type) ? nameOf(node) : null),
  typescript: tsSymbol,
  tsx: tsSymbol,
  javascript: tsSymbol,
  go: (node) => {
    if (!GO_ITEMS.has(node.type)) return null;
    if (node.type === 'function_declaration' || node.type === 'method_declaration') return nameOf(node);
    // `type (...)`, `var (...)`: a group has no one name.
    const specs = node.namedChildren.filter((c) => c && /_spec$|^type_alias$/.test(c.type));
    return specs.length === 1 ? nameOf(specs[0]) : '';
  },
  python: (node) => {
    const def = node.type === 'decorated_definition' ? node.childForFieldName('definition') : node;
    return def && PY_ITEMS.has(def.type) ? nameOf(def) : null;
  },
};

function tsSymbol(node: Node): string | null {
  if (node.type === 'export_statement') {
    // `export default function () {}` has a value, not a declaration, and no name.
    const declaration = node.childForFieldName('declaration');
    return declaration ? tsSymbol(declaration) : null;
  }
  if (node.type === 'lexical_declaration') {
    if (node.childForFieldName('kind')?.type !== 'const') return null;
    const name = node.namedChildren[0]?.childForFieldName('name');
    // `const { a } = b` destructures: no one name, so not an item.
    return name?.type === 'identifier' ? name.text : null;
  }
  return TS_ITEMS.has(node.type) ? nameOf(node) : null;
}

/** The siblings above an item that belong to it: Rust doc comments and attributes, any comment elsewhere. */
const ATTACHES: Record<Grammar, (node: Node) => boolean> = {
  rust: isRustDocOrAttribute,
  typescript: (n) => n.type === 'comment',
  tsx: (n) => n.type === 'comment',
  javascript: (n) => n.type === 'comment',
  go: (n) => n.type === 'comment',
  python: (n) => n.type === 'comment',
};

function grammarOf(file: string): Grammar | null {
  if (file.endsWith('.rs')) return 'rust';
  if (file.endsWith('.tsx')) return 'tsx';
  if (/\.[cm]?ts$/.test(file)) return 'typescript';
  if (/\.(jsx?|mjs|cjs)$/.test(file)) return 'javascript';
  if (file.endsWith('.go')) return 'go';
  if (file.endsWith('.py')) return 'python';
  return null;
}

export function langOf(file: string): Lang | null {
  if (file.endsWith('.rs')) return 'rust';
  if (/\.([cm]?tsx?|jsx?|mjs|cjs)$/.test(file)) return 'typescript';
  if (/\.kts?$/.test(file)) return 'kotlin';
  if (file.endsWith('.swift')) return 'swift';
  if (file.endsWith('.go')) return 'go';
  if (file.endsWith('.py')) return 'python';
  return null;
}

/** A block start: the 0-indexed row of an item's first doc or attribute line, and the item's name. */
interface Boundary {
  row: number;
  symbol: string;
}

function treeBoundaries(root: Node, grammar: Grammar): Boundary[] {
  const out: Boundary[] = [];
  for (const node of root.namedChildren) {
    if (!node) continue;
    const symbol = SYMBOL[grammar](node);
    if (symbol === null) continue;
    const row = startWithDocs(node, ATTACHES[grammar]);
    // Two items on one row share a block, named after the first.
    if (out.at(-1)?.row === row) continue;
    out.push({ row, symbol });
  }
  return out;
}

// Kotlin and Swift use a line rule until their grammars ship a .wasm that
// web-tree-sitter loads. A top-level item starts at
// column 0; leading annotations on the same line are tolerated, and annotations
// on their own preceding lines group via LINE_DOC.
const KOTLIN_ITEM =
  /^(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|private\s+|internal\s+|protected\s+|open\s+|final\s+|abstract\s+|sealed\s+|data\s+|inner\s+|enum\s+|annotation\s+|value\s+|external\s+|expect\s+|actual\s+|inline\s+|infix\s+|operator\s+|suspend\s+|tailrec\s+|override\s+|const\s+|lateinit\s+)*(?:fun|class|interface|object|val|var|typealias)\b/;
const SWIFT_ITEM =
  /^(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|final\s+|static\s+|class\s+|dynamic\s+|indirect\s+|convenience\s+|required\s+|override\s+|lazy\s+|weak\s+|unowned\s+)*(?:func|class|struct|enum|protocol|extension|actor|typealias|init|subscript|var|let)\b/;
// Symbol name after the keyword. Kotlin can put generics before the name
// (`fun <T> foo`); Swift puts them after (`func foo<T>`), so the name is the
// first identifier after the keyword in both.
// The `(?:[A-Za-z_][\w.]*\.)?` skips an extension receiver, so `fun Project.foo`
// and `val Project.bar` name `foo`/`bar`, not the pervasive receiver `Project`.
const KOTLIN_SYM = /\b(?:fun|class|interface|object|val|var|typealias)\s+(?:<[^>]*>\s+)?(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)/;
const SWIFT_SYM = /\b(?:func|class|struct|enum|protocol|extension|actor|typealias|var|let)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const LINE_ITEM = { kotlin: KOTLIN_ITEM, swift: SWIFT_ITEM };
const LINE_SYM = { kotlin: KOTLIN_SYM, swift: SWIFT_SYM };
// KDoc and Swift doc comments, line comments, and annotations (`@Serializable`,
// `@MainActor`) precede the item.
const LINE_DOC = /^\s*(\/\/|\/\*|\*|@)/;

/** The symbol name on a Kotlin or Swift item line, for the chunk heading. */
export function symbolOf(line: string, lang: 'kotlin' | 'swift'): string {
  return line.match(LINE_SYM[lang])?.[1] ?? '';
}

function lineBoundaries(lines: string[], lang: 'kotlin' | 'swift'): Boundary[] {
  const out: Boundary[] = [];
  let floor = -1;
  lines.forEach((line, i) => {
    if (!LINE_ITEM[lang].test(line)) return;
    // Walk back over the item's doc and annotation lines, never past the previous item.
    let row = i;
    while (row - 1 > floor && LINE_DOC.test(lines[row - 1] ?? '')) row--;
    out.push({ row, symbol: symbolOf(line, lang) });
    floor = i;
  });
  return out;
}

/**
 * Split a source file into { text, symbol, startLine } blocks at top-level
 * items, capping block size. A block runs from an item's doc comments to the
 * next item's, so what sits between items (`use` lines, constants) rides with
 * the item above it. Text before the first item becomes its own block.
 */
export async function chunkCode(content: string, file: string): Promise<CodeBlock[]> {
  const lang = langOf(file);
  if (!lang) return [];
  const lines = content.split('\n');
  const grammar = grammarOf(file);
  const bounds = grammar
    ? await withTree(content, grammar, (root) => treeBoundaries(root, grammar))
    : lineBoundaries(lines, lang as 'kotlin' | 'swift');
  if (bounds[0]?.row !== 0) bounds.unshift({ row: 0, symbol: '' });

  const out: CodeBlock[] = [];
  for (let b = 0; b < bounds.length; b++) {
    const { row: start, symbol } = bounds[b]!;
    const end = bounds[b + 1]?.row ?? lines.length;
    let block = lines.slice(start, end).join('\n');
    let lineOffset = 0;
    // Hard-split oversized blocks so no chunk blows the embedder's budget. Cut at
    // the last newline within the cap; if a single line is longer than the cap
    // (minified/generated code), cut by chars so we always make progress.
    while (block.trim().length > MAX_CHARS) {
      let cut = block.lastIndexOf('\n', MAX_CHARS);
      if (cut <= 0) cut = MAX_CHARS;
      const piece = block.slice(0, cut);
      if (piece.trim().length >= MIN_CHARS) out.push({ text: piece.trim(), symbol, startLine: start + 1 + lineOffset });
      // The newline at `cut` is dropped from both piece and the remainder, so
      // count it too, or every later chunk's startLine drifts low.
      lineOffset += (piece.match(/\n/g) || []).length + (block[cut] === '\n' ? 1 : 0);
      block = block.slice(cut).replace(/^\n/, '');
    }
    if (block.trim().length >= MIN_CHARS) out.push({ text: block.trim(), symbol, startLine: start + 1 + lineOffset });
  }
  return out;
}

/**
 * Chunk one file into retrieval records. `repoPath` is repo-relative, e.g.
 * common/nymsphinx/src/lib.rs.
 *
 * `source` labels the shard and `github` is the repo's deep-link base
 * (`https://github.com/<org>/<repo>/blob/<ref>`). `repo`, when set, namespaces
 * the id so two repos in one store cannot mint the same one; a single-repo index
 * leaves it unset and keeps unprefixed ids.
 */
export async function chunkCodeFile(
  content: string,
  repoPath: string,
  { repo, source, github }: { repo?: string; source: string; github: string },
): Promise<CodeChunk[]> {
  const lang = langOf(repoPath);
  if (!lang) return [];
  const idPrefix = repo ? `${repo}/` : '';
  return (await chunkCode(content, repoPath)).map((c, i) => ({
    id: `${idPrefix}${repoPath}#${i}`,
    source,
    title: repoPath,
    heading: c.symbol || `${repoPath.split('/').pop()}`,
    url: `${github}/${repoPath}#L${c.startLine}`,
    text: c.text,
    lang,
    ...(isTestCode(repoPath, c.symbol, lang) && { test: true as const }),
  }));
}

export { MAX_CHARS, MIN_CHARS };
