/**
 * Cross-language declaration heuristics, for grammars with no hand-written table.
 *
 * Sits between the two extremes: better than the text-pattern provider (it works on a
 * real syntax tree, so it never matches inside a comment or a string), worse than a
 * hand-written table (it infers meaning from node-type NAMES rather than knowing the
 * grammar). Without it, downloading a grammar would be a no-op — `supports()` gates on
 * having a declaration table, so a parsed file with no table yields an empty outline,
 * which reads as "this file has no structure" instead of "we cannot read this language".
 *
 * The critical detail is name extraction. Measured across the CDN's grammars, reading
 * only the `name` FIELD returns **zero declarations for Kotlin** — its
 * `class_declaration` / `function_declaration` nodes are named exactly as expected but
 * expose the identifier as a positional child, with no field at all. Silently empty, no
 * error. Swift, Scala and Zig share the shape. Hence the positional fallback below; it
 * is the difference between the generic tier working and looking broken.
 *
 * Two grammars still defeat it (Lua's `function_definition_statement`, Elixir's
 * everything-is-a-call model). Those are labelled in the manifest rather than papered
 * over: a near-empty outline the user was warned about is honest, a fabricated one is not.
 */
import {
	MAX_TRAVERSAL_DEPTH,
	MAX_VISITED_NODES,
	type RichOutlineNode,
	type SyntaxNode,
} from "./outline";
import type { StructKind } from "./provider";

/** Node types that name a declaration, by suffix (`class_declaration`, `type_spec`…). */
const DECLARATION_SUFFIX = /_(declaration|definition|item|spec|declarator)$/;

/**
 * Bare node types that are declarations without a suffix.
 *
 * Ruby is the reason: its nodes are plainly `class`, `module`, `method`.
 */
const BARE_DECLARATION = new Set([
	"class",
	"module",
	"method",
	"singleton_method",
	"function",
	"struct",
	"enum",
	"interface",
	"trait",
	"protocol",
	"impl",
	"mod",
	"namespace",
	"object",
]);

/** Identifier node types, in fallback priority order. */
const IDENTIFIER_SUFFIX = /(^|_)identifier$/;

/** Node types whose contents are statements, not members — never descended into. */
const STATEMENT_BODY_TYPES = new Set([
	"statement_block",
	"block",
	"body",
	"function_body",
	"compound_statement",
]);

/** Maximum declarations emitted, mirroring the table-driven walk's cap. */
const MAX_NODES = 3000;

/** Depth beyond which we stop descending, to bound work on generated files. */
const MAX_DEPTH = 8;

/**
 * Map a node type name to a normalized kind.
 *
 * Ordered longest-first where prefixes overlap, so `interface_declaration` is not
 * classified by an earlier `int` match.
 */
const KIND_PATTERNS: ReadonlyArray<[RegExp, StructKind]> = [
	[/^(class|singleton_class)/, "class"],
	[/^interface/, "interface"],
	[/^(struct|record)/, "struct"],
	[/^enum/, "enum"],
	[/^(trait|protocol)/, "trait"],
	[/^impl/, "impl"],
	[/^(module|mod|namespace|package)/, "module"],
	[/^(constructor|initializer)/, "constructor"],
	[/^(method|singleton_method)/, "method"],
	[/^(function|func|fn|procedure|subroutine)/, "function"],
	[/^(type|typedef|type_alias)/, "type"],
	[/^(const|constant)/, "constant"],
	[/(property|field|member)/, "property"],
	[/^(variable|var|let|local)/, "variable"],
];

export interface GenericOutlineResult {
	nodes: RichOutlineNode[];
	truncated: boolean;
}

/** Build an outline using type-name heuristics instead of a language table. */
export function buildGenericOutline(
	root: SyntaxNode,
	options: { maxDepth?: number; maxNodes?: number; signal?: AbortSignal } = {},
): GenericOutlineResult {
	const maxDepth = options.maxDepth ?? MAX_DEPTH;
	const maxNodes = options.maxNodes ?? MAX_NODES;
	const state = { emitted: 0, visited: 0, truncated: false };

	const nodes = walk(root, {
		depth: 0,
		frame: 0,
		symbolPrefix: "",
		maxDepth,
		maxNodes,
		state,
		...(options.signal ? { signal: options.signal } : {}),
	});
	return { nodes, truncated: state.truncated };
}

interface WalkOptions {
	depth: number;
	/**
	 * Recursion depth of the walk itself, which `depth` is not: an unnameable
	 * declaration and any non-declaration node both recurse with `depth` deliberately
	 * unchanged, so `maxDepth` cannot bound them. See `MAX_TRAVERSAL_DEPTH`.
	 */
	frame: number;
	symbolPrefix: string;
	maxDepth: number;
	maxNodes: number;
	state: { emitted: number; visited: number; truncated: boolean };
	signal?: AbortSignal;
}

function walk(node: SyntaxNode, opts: WalkOptions): RichOutlineNode[] {
	if (opts.signal?.aborted) return [];
	if (opts.depth > opts.maxDepth || opts.frame > MAX_TRAVERSAL_DEPTH) {
		opts.state.truncated = true;
		return [];
	}

	const results: RichOutlineNode[] = [];
	for (let i = 0; i < node.childCount; i++) {
		// `emitted` bounds the OUTPUT and `visited` bounds the WORK; a file with no
		// declarations at all can never trip the first one.
		if (opts.state.emitted >= opts.maxNodes || opts.state.visited >= MAX_VISITED_NODES) {
			opts.state.truncated = true;
			break;
		}
		const child = node.child(i);
		if (!child?.isNamed) continue;
		opts.state.visited++;

		if (isDeclaration(child)) {
			const name = readAnyName(child);
			if (!name) {
				// A declaration shape we cannot name is not worth an anonymous row; its
				// children may still be nameable.
				results.push(...walk(child, { ...opts, depth: opts.depth, frame: opts.frame + 1 }));
				continue;
			}
			const symbolPath = opts.symbolPrefix ? `${opts.symbolPrefix}.${name}` : name;
			const entry: RichOutlineNode = {
				kind: kindFor(child.type),
				name,
				symbolPath,
				startLine: child.startPosition.row + 1,
				endLine: child.endPosition.row + 1,
				startIndex: child.startIndex,
				endIndex: child.endIndex,
				depth: opts.depth,
				exported: isLikelyPublic(child, name),
			};
			opts.state.emitted++;

			const children = walk(child, {
				...opts,
				depth: opts.depth + 1,
				frame: opts.frame + 1,
				symbolPrefix: symbolPath,
			});
			if (children.length > 0) entry.children = children;
			results.push(entry);
			continue;
		}

		// Not a declaration: keep looking inside, but never through a statement body.
		// Descending into statements would report a function's locals as though they
		// were members of the enclosing type.
		if (STATEMENT_BODY_TYPES.has(child.type)) continue;
		results.push(...walk(child, { ...opts, depth: opts.depth, frame: opts.frame + 1 }));
	}
	return results;
}

function isDeclaration(node: SyntaxNode): boolean {
	return DECLARATION_SUFFIX.test(node.type) || BARE_DECLARATION.has(node.type);
}

/**
 * The declaration's name, from the `name` field or the first identifier child.
 *
 * The fallback is not a nicety: Kotlin, Swift, Scala and Zig expose no `name` field at
 * all, so a field-only read returns nothing for them and the whole tier looks broken.
 */
function readAnyName(node: SyntaxNode): string | null {
	const field = node.childForFieldName("name");
	if (field) {
		const text = field.text.trim();
		if (text.length > 0 && !text.includes("\n")) return text;
	}

	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child?.isNamed) continue;
		// Stop at the first body/parameter list: an identifier past that point belongs to
		// the implementation, not to this declaration's name.
		if (STATEMENT_BODY_TYPES.has(child.type)) break;
		if (IDENTIFIER_SUFFIX.test(child.type)) {
			const text = child.text.trim();
			if (text.length > 0 && !text.includes("\n")) return text;
		}
	}
	return null;
}

function kindFor(nodeType: string): StructKind {
	for (const [pattern, kind] of KIND_PATTERNS) {
		if (pattern.test(nodeType)) return kind;
	}
	return "unknown";
}

/**
 * Best-effort visibility.
 *
 * Deliberately conservative and syntactic: a `pub`/`public`/`export` keyword among the
 * node's own children, or the capitalisation convention. Without a language table there
 * is no way to be certain, so `api` mode on a generic-tier language is a hint rather
 * than an authoritative contract.
 */
function isLikelyPublic(node: SyntaxNode, name: string): boolean {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		const text = child.text.trim();
		if (
			child.type === "visibility_modifier" ||
			child.type === "modifiers" ||
			text === "pub" ||
			text === "public" ||
			text === "export"
		) {
			if (/\b(pub|public|export)\b/.test(text)) return true;
		}
		// Keep the scan shallow; a modifier never appears deep inside a body.
		if (STATEMENT_BODY_TYPES.has(child.type)) break;
	}
	const first = name[0];
	return first !== undefined && first === first.toUpperCase() && /[A-Z]/.test(first);
}
