// The named items of a source file, with tree-sitter: one function for callers
// that cite items by symbol, and the parser and doc-comment rule the code
// chunker shares.
//
//   const list = await items(text, 'rust');
//   // [{ name, qualifiedName, kind, startLine, endLine }], 1-indexed, inclusive
//
// The range of an item includes its doc comments and attributes. `qualifiedName`
// is the path of the item inside the file: `module::Type::method`. A method in
// `impl Trait for Type` is `<Type as Trait>::method`, Rust's own fully qualified
// form, and it also answers to `Type::method`.

import { createRequire } from 'node:module';
import { Parser, Language, type Node } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
// Each grammar's prebuilt .wasm. Kotlin and Swift have no grammar here: their npm
// packages ship no .wasm (the code chunker keeps a line rule for them).
const GRAMMARS = {
  rust: 'tree-sitter-rust/tree-sitter-rust.wasm',
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  go: 'tree-sitter-go/tree-sitter-go.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
} as const;
export type Grammar = keyof typeof GRAMMARS;

// Rust node type -> item kind. `impl_item` is not an item a citation names:
// its methods are.
const RUST_KINDS: Record<string, string> = {
  function_item: 'fn',
  function_signature_item: 'fn',
  struct_item: 'struct',
  enum_item: 'enum',
  union_item: 'union',
  trait_item: 'trait',
  mod_item: 'mod',
  const_item: 'const',
  static_item: 'static',
  type_item: 'type',
  macro_definition: 'macro',
  associated_type: 'type',
};

const parsers = new Map<Grammar, Parser>();

async function parserFor(grammar: Grammar): Promise<Parser> {
  const cached = parsers.get(grammar);
  if (cached) return cached;
  if (!Object.hasOwn(GRAMMARS, grammar)) throw new Error(`no grammar for language "${grammar}"`);
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(require.resolve(GRAMMARS[grammar])));
  parsers.set(grammar, parser);
  return parser;
}

/** Parse `text` and pass the root node to `read`. The tree lives in WASM memory, so it is freed after `read`. */
export async function withTree<T>(text: string, grammar: Grammar, read: (root: Node) => T): Promise<T> {
  const tree = (await parserFor(grammar)).parse(text);
  if (!tree) throw new Error(`tree-sitter returned no tree for a ${grammar} source`);
  try {
    return read(tree.rootNode);
  } finally {
    tree.delete();
  }
}

/**
 * One spelling for a type or trait: whitespace collapsed, none inside `<...>`
 * at the brackets, one space after a comma. `W <T>` and `W<T>` read the same,
 * and `<W<T> as Clone>` keeps the spaces around `as`.
 */
export const squash = (text: string): string => text
  .replace(/\s+/g, ' ')
  .replace(/(\w)\s+</g, '$1<')
  .replace(/<\s+/g, '<')
  .replace(/\s+>/g, '>')
  .replace(/\s*,\s*/g, ', ')
  .trim();
/** A path with a leading `crate::`, `self::`, or `super::` removed: the item path is inside the file. */
const local = (text: string): string => text.replace(/^(?:(?:crate|self|super)::)+/, '');
/** A type with its generic arguments removed: `Foo<T>` -> `Foo`. */
const bareType = (text: string): string => local(squash(text)).replace(/<.*$/, '');
/** A trait with its module path removed: `fmt::Display` -> `Display`, `From<A>` stays. */
const lastSegment = (text: string): string => { const t = squash(text); const head = t.replace(/<.*$/, ''); return head.split('::').pop() + t.slice(head.length); };

/** A Rust attribute or outer doc comment: `///` and `/**`, not `////`, `/**/`, `/***`, or `//!`. */
export const isRustDocOrAttribute = (node: Node): boolean =>
  node.type === 'attribute_item' ||
  ((node.type === 'line_comment' || node.type === 'block_comment') && /^(\/\/\/(?!\/)|\/\*\*(?![*/]))/.test(node.text));

/** The last row a node covers. A Rust line comment ends at column 0 of the next row, because it holds its newline. */
const endRow = (node: Node): number => (node.endPosition.column === 0 ? node.endPosition.row - 1 : node.endPosition.row);

/**
 * The start row of an item with the run of siblings directly above it that
 * `attaches` accepts (by default Rust doc comments and attributes). Any other
 * node, or a blank line, ends the run.
 */
export function startWithDocs(node: Node, attaches: (prev: Node) => boolean = isRustDocOrAttribute): number {
  let start = node.startPosition.row;
  for (let prev = node.previousNamedSibling; prev; prev = prev.previousNamedSibling) {
    // A trailing comment (`#[ignore] // slow`, `const A = 1; // note`) belongs to
    // the node it follows, so the walk looks past it to that node.
    const before = prev.previousNamedSibling;
    if (before && endRow(before) === prev.startPosition.row) continue;
    // An attribute can sit on the item's own row (`#[inline] fn a()`).
    const lastRow = endRow(prev);
    if (lastRow !== start - 1 && lastRow !== start) break;
    if (!attaches(prev)) break;
    start = prev.startPosition.row;
  }
  return start;
}

export interface Item {
  name: string;
  qualifiedName: string;
  aliases: string[];
  kind: string;
  /** 1-indexed, inclusive */
  startLine: number;
  endLine: number;
}

/** The named items of `text`, a source file in `lang` (`'rust'`). */
export async function items(text: string, lang: string): Promise<Item[]> {
  if (lang !== 'rust') throw new Error(`no item finder for language "${lang}"`);
  return withTree(text, lang, (root) => rustItems(root));
}

function rustItems(root: Node): Item[] {
  const found: Item[] = [];

  const walk = (node: Node, prefix: string) => {
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === 'impl_item') {
        const type = child.childForFieldName('type');
        const trait = child.childForFieldName('trait');
        const body = child.childForFieldName('body');
        if (!type || !body) continue;
        const owner = trait ? `<${local(squash(type.text))} as ${squash(trait.text)}>` : bareType(type.text);
        // A trait-impl method also answers to `Type::method` and to the trait's last path segment.
        const aliasOwners = trait ? [bareType(type.text), `<${local(squash(type.text))} as ${lastSegment(trait.text)}>`].filter((a) => a !== owner) : [];
        for (const member of body.namedChildren) {
          if (!member) continue;
          const kind = RUST_KINDS[member.type];
          if (!kind) continue;
          const name = member.childForFieldName('name')?.text;
          if (!name) continue;
          found.push({
            name,
            qualifiedName: `${prefix}${owner}::${name}`,
            aliases: aliasOwners.map((a) => `${prefix}${a}::${name}`),
            kind,
            startLine: startWithDocs(member) + 1,
            endLine: member.endPosition.row + 1,
          });
        }
        continue;
      }
      // An `extern` block holds items at the level of its parent.
      if (child.type === 'foreign_mod_item') {
        const body = child.childForFieldName('body') ?? child.namedChildren.find((c) => c?.type === 'declaration_list');
        if (body) walk(body, prefix);
        continue;
      }
      const kind = RUST_KINDS[child.type];
      if (!kind) continue;
      const name = child.childForFieldName('name')?.text;
      if (!name) continue;
      found.push({
        name,
        qualifiedName: `${prefix}${name}`,
        aliases: [],
        kind,
        startLine: startWithDocs(child) + 1,
        endLine: child.endPosition.row + 1,
      });
      const body = child.childForFieldName('body');
      if (body && (kind === 'mod' || kind === 'trait')) walk(body, `${prefix}${name}::`);
    }
  };
  walk(root, '');
  return found;
}

/** Split a path on `::`, but not inside `<...>`. */
export function pathSegments(qualified: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < qualified.length; i++) {
    const c = qualified[i];
    if (c === '<') depth++;
    if (c === '>') depth--;
    if (depth === 0 && qualified.startsWith('::', i)) {
      out.push(current);
      current = '';
      i++;
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

/**
 * The items a symbol names: each item whose qualified name or alias ends with
 * the symbol's path segments. `try_update_state` matches every method of that
 * name; `ClassicPeriodicAllowance::try_update_state` matches one.
 */
export function matchSymbol(list: Item[], symbol: string): Item[] {
  const want = pathSegments(squash(symbol));
  const endsWith = (qualified: string) => {
    const have = pathSegments(qualified);
    return have.length >= want.length && want.every((seg, i) => have[have.length - want.length + i] === seg);
  };
  return list.filter((item) => [item.qualifiedName, ...item.aliases].some(endsWith));
}
