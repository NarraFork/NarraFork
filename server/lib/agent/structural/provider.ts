/**
 * Structure provider contract — the pluggable seam behind StructView (and, later,
 * StructSed).
 *
 * The kernel never talks to tree-sitter directly. It asks a chain of providers
 * "can you handle this document?" and uses the first one that says `full`,
 * degrading through the chain to the heuristic provider, which always answers
 * `degraded`. That indirection is the whole point: adding an LSP-backed provider
 * later is a registration, not a refactor, because the normalized shapes below
 * (`OutlineNode` / `LocatedNode`) are what every provider must produce — not
 * whatever its underlying engine happens to return.
 *
 * The same `locate()` output serves reads and writes. StructView slices the file
 * with it; StructSed will turn it into an edit address. Keeping one selector
 * implementation is what makes "you can change exactly what you just looked at"
 * true rather than aspirational.
 */

/** Normalized declaration kind, shared across languages and providers. */
export type StructKind =
	| "function"
	| "method"
	| "class"
	| "interface"
	| "struct"
	| "enum"
	| "trait"
	| "impl"
	| "type"
	| "constant"
	| "variable"
	| "property"
	| "field"
	| "module"
	| "namespace"
	| "constructor"
	| "getter"
	| "setter"
	| "test"
	/**
	 * A statement-level bare call that takes a callback (`useEffect(…)`,
	 * `describe(…)`, `app.route(…)`). Not a declaration, but structurally load-bearing
	 * in files whose skeleton is made of such calls.
	 */
	| "call"
	| "unknown";

/** One declaration in a file outline. */
export interface OutlineNode {
	kind: StructKind;
	/** Declaration name. Empty only for anonymous constructs the provider still wants to show. */
	name: string;
	/**
	 * Short signature fragment shown after the name (parameters, return type,
	 * receiver, extends clause…). Never the body.
	 */
	signature?: string;
	/** 1-based inclusive start line. */
	startLine: number;
	/** 1-based inclusive end line. */
	endLine: number;
	/** Nesting depth; 0 for top-level declarations. */
	depth: number;
	/**
	 * Whether the declaration is part of the module's public surface. Drives the
	 * `api` mode, which is an exports-only projection of the outline rather than a
	 * separate provider call.
	 */
	exported: boolean;
	/** Extra single-word attributes (async, static, abstract, generator…). */
	modifiers?: string[];
	/**
	 * Every name bound by a destructuring declaration.
	 *
	 * `name` shows a collapsed label (`{ a, b, …+24 }`) so a 27-field destructure does
	 * not dominate the outline, but the full list stays here — otherwise a search for
	 * one of those names could never find the line that binds it.
	 */
	bindings?: string[];
	/** What the declaration is initialized from, e.g. `useState(…)`. */
	initializer?: string;
	/**
	 * How many times the name appears in this file, definition included.
	 *
	 * Lexical, single-file, and same-name-collapsing — NOT resolved references. Present
	 * only when the caller asked for it, since it costs an extra tree walk.
	 */
	refs?: number;
	/** Nested declarations (class members, module contents…). */
	children?: OutlineNode[];
}

/** A resolved node with the byte/line range needed to read or rewrite it. */
export interface LocatedNode {
	kind: StructKind;
	name: string;
	/** Dotted path from the file root, e.g. `PaymentService.charge`. */
	symbolPath: string;
	signature?: string;
	/** UTF-16 offset into the decoded text (what `String.prototype.slice` wants). */
	startIndex: number;
	endIndex: number;
	/** 1-based inclusive line range. */
	startLine: number;
	endLine: number;
	exported: boolean;
	modifiers?: string[];
}

/** How a caller names the node it wants. */
export interface StructSelector {
	/**
	 * Symbol name; `A.b` addresses a member of `A`. A bare `b` matches at any depth,
	 * so `charge` finds `PaymentService.charge` without the caller knowing the class.
	 */
	symbol?: string;
	/** Restrict to these normalized kinds. */
	kinds?: StructKind[];
	/** 1-based disambiguator among equally-good matches (overloads, same-name methods). */
	nth?: number;
}

/** The parsed-document handle providers operate on. */
export interface StructDocument {
	/** Absolute path as the caller addressed it (used for language detection + messages). */
	filePath: string;
	/** Decoded text. All indices in provider results are UTF-16 offsets into this. */
	text: string;
	/** Detected language id, or null when unknown. */
	languageId: string | null;
	/** Abort signal for the enclosing tool call. */
	signal?: AbortSignal;
}

/** Import/export inventory for a single file. */
/**
 * One name an import binds into the local scope.
 *
 * `local` is the name that appears in the file's body; `original` is only set when the
 * import renamed it. That direction matters: a cross-file search looks for the name as
 * written at the use site, so storing only the exported name would miss every aliased
 * import — which is exactly the blind spot this type exists to close.
 */
export interface ImportedName {
	local: string;
	/** The exported name, when `local` is an alias for it. */
	original?: string;
}

export interface ImportExportInfo {
	imports: Array<{
		/** Module specifier as written. */
		module: string;
		/** Imported names, when the provider can see them. */
		names?: ImportedName[];
		line: number;
		/** `import x from "y"` vs `require("y")` vs `from y import x`… */
		form?: string;
	}>;
	exports: Array<{
		name: string;
		kind: StructKind;
		line: number;
		/** Re-export source module, when this is a pass-through. */
		from?: string;
	}>;
}

/** Lexical tallies for one file. Counts are single-file and name-collapsing. */
export interface FileStatistics {
	/**
	 * Identifier tallies. `lines` holds the 1-based lines the name appears on, ascending
	 * and deduped, so callers can ask WHERE a symbol is used rather than only how often —
	 * the distinction between "7 references" and "7 references, all inside L2177-2418".
	 */
	identifiers: Array<{ name: string; count: number; lines?: number[] }>;
	calls: Array<{ name: string; count: number }>;
	elements: Array<{ name: string; count: number }>;
	/** Counts are lower bounds because the walk hit its node cap. */
	truncated: boolean;
}

/** One node of a nested element (JSX) skeleton. */
export interface ElementNode {
	/** Element or component name; `<>` for a fragment. */
	name: string;
	line: number;
	endLine: number;
	/** Structural attribute names only (`ref`, `key`), never their values. */
	attributes?: string[];
	/** How this element is conditionally rendered, when it is. */
	condition?: "and" | "ternary" | "map" | "optional";
	/** Lowercase HTML tag rather than a component. */
	html?: boolean;
	children?: ElementNode[];
}

/**
 * How much a provider trusts a search result.
 *
 * `structural` means "matched by shape and name text" — it skips comments and
 * strings, but it does not know identity: two unrelated `charge`s look identical
 * and an aliased re-export is invisible. `semantic` is reserved for a provider
 * that resolved references for real. Callers surface this to the model verbatim;
 * quietly presenting structural hits as semantic is how a tool starts lying.
 */
export type SearchPrecision = "structural" | "semantic";

export interface SearchHit {
	filePath: string;
	line: number;
	/** Symbol chain the hit sits inside, when resolvable. */
	enclosing?: string;
	/** Single-line, truncated snippet. Never a whole body. */
	snippet: string;
	kind?: StructKind;
	precision: SearchPrecision;
}

/** A provider's confidence for a given document. */
export type ProviderSupport = "full" | "degraded" | "no";

export interface StructureProvider {
	readonly id: string;
	/** Human-readable name for tool output footnotes. */
	readonly label: string;
	/**
	 * How well this provider can handle the document. `degraded` still gets used
	 * when nothing better is available, and the caller is expected to tell the
	 * model the result is approximate.
	 */
	supports(doc: StructDocument): Promise<ProviderSupport> | ProviderSupport;
	outline(doc: StructDocument): Promise<OutlineNode[]>;
	/**
	 * Whether the outline hit a traversal/output budget. Readers must label partial
	 * results; symbol-based edits and stashes must refuse them because missing
	 * declarations can make an ambiguous selector look unique. Shares the outline cache.
	 */
	isOutlineTruncated?(doc: StructDocument): Promise<boolean>;
	locate(doc: StructDocument, selector: StructSelector): Promise<LocatedNode[]>;
	/** Innermost-first chain of named ancestors at a position. */
	enclosing(doc: StructDocument, position: StructPosition): Promise<LocatedNode[]>;
	/** Optional: import/export inventory. Kernel reports "unsupported" when absent. */
	imports?(doc: StructDocument): Promise<ImportExportInfo>;
	/**
	 * Optional: lexical identifier/call/element tallies for one file.
	 *
	 * Only a real parser can answer this honestly — a regex version would miscount
	 * generics and comments, so the heuristic provider deliberately omits it and the
	 * tool reports the mode as needing an installed grammar.
	 */
	statistics?(doc: StructDocument): Promise<FileStatistics | null>;
	/** Optional: nested element (JSX) skeleton. */
	elementTree?(doc: StructDocument): Promise<ElementNode[] | null>;
	/**
	 * Optional: structural/semantic search. Deliberately absent from the
	 * tree-sitter provider in this phase; the kernel reports the mode as
	 * unsupported rather than faking it.
	 */
	search?(query: StructQuery, scope: SearchScope): Promise<SearchHit[]>;
	/**
	 * Why this provider is only `degraded`/`no` for a document, phrased for the
	 * model (e.g. "typescript grammar is not installed").
	 */
	explainLimitation?(doc: StructDocument): Promise<string | null> | string | null;
}

/** A line, or a line:column pair. Both 1-based, matching editor and Grep output. */
export interface StructPosition {
	line: number;
	column?: number;
}

export type StructQuery =
	| { kind: "preset"; name: string; argument?: string }
	| { kind: "pattern"; pattern: string }
	| { kind: "raw"; query: string };

export interface SearchScope {
	/** Files to consider. Single-element for a single-file search. */
	documents: StructDocument[];
	maxHits?: number;
}

// ── Provider registry ────────────────────────────────────────────────

const providers: StructureProvider[] = [];

/**
 * Register a provider. Order is priority order, so the tree-sitter provider must
 * be registered before the heuristic fallback.
 */
export function registerStructureProvider(provider: StructureProvider): void {
	const existing = providers.findIndex((p) => p.id === provider.id);
	if (existing >= 0) providers[existing] = provider;
	else providers.push(provider);
}

/** All registered providers, in priority order. */
export function listStructureProviders(): readonly StructureProvider[] {
	return providers;
}

/** Resolution outcome: which provider handles a document, and how well. */
export interface ResolvedProvider {
	provider: StructureProvider;
	support: ProviderSupport;
	/** Model-facing note when the chosen provider is degraded. */
	limitation?: string;
}

/**
 * Pick the highest-priority provider that can handle the document.
 *
 * Providers answering `full` win immediately. Otherwise the first `degraded`
 * provider is remembered and used only if nothing better turns up, so an
 * uninstalled grammar falls back to heuristics instead of failing the call.
 */
export async function resolveProvider(doc: StructDocument): Promise<ResolvedProvider | null> {
	let degraded: ResolvedProvider | null = null;

	for (const provider of providers) {
		const support = await provider.supports(doc);
		if (support === "no") continue;
		if (support === "full") return { provider, support };
		if (!degraded) {
			const limitation = (await provider.explainLimitation?.(doc)) ?? undefined;
			degraded = { provider, support, ...(limitation ? { limitation } : {}) };
		}
	}

	return degraded;
}

/** Reset the registry. Test-only. */
export function clearStructureProviders(): void {
	providers.length = 0;
}
