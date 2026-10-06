/**
 * Shared web-tree-sitter engine bootstrap.
 *
 * The core engine (`tree-sitter.wasm`, 205 KB) stays embedded in the binary —
 * only the per-language grammars are downloaded on demand. Materializing it into
 * a real temp directory is what makes dev and compiled-binary runs take the same
 * path: in a single-executable build the imported asset lives behind a virtual
 * `$bunfs` path that Emscripten's `fs.readFileSync` cannot open, while
 * `require.resolve` may still point at the build machine's `node_modules`.
 *
 * This module exists because `Parser.init` is a PROCESS-WIDE singleton with an
 * unguarded initialization check:
 *
 *     if (!Module3) Module3 = await tree_sitter_default(options)
 *
 * Two concurrent callers both see `!Module3`, both build an Emscripten module, and
 * the last `setModule` wins — leaving any `Language` loaded against the losing
 * module holding pointers into a heap the engine no longer uses. So every consumer
 * (bash command analysis, the structural providers) has to funnel through the one
 * cached promise here rather than calling `Parser.init` itself.
 */

// `import ... with { type: "file" }` gives Bun an explicit asset edge so the wasm
// is present both in dev and in packaged binaries.
import embeddedTreeSitterWasm from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };

export interface TreeSitterNodeLike {
	type: string;
	text: string;
	childCount: number;
	child(index: number): TreeSitterNodeLike | null;
	parent: TreeSitterNodeLike | null;
	descendantsOfType(type: string): TreeSitterNodeLike[];
}

interface ParserCtor {
	init(options: { locateFile(): string }): Promise<void>;
	new (): ParserInstance;
}

/**
 * A parsed tree.
 *
 * `delete()` is declared because it is REQUIRED, not optional housekeeping: the tree
 * holds wasm-heap memory that JS GC cannot reclaim. Callers must free it once they
 * have extracted plain data — see `withParsedTree` in tree-sitter-provider.ts.
 */
export interface ParsedTreeHandle {
	rootNode: TreeSitterNodeLike;
	delete(): void;
}

export interface ParserInstance {
	setLanguage(language: unknown): void;
	parse(input: string): ParsedTreeHandle | null;
	delete?(): void;
}

interface LanguageStatic {
	load(input: string | Uint8Array): Promise<unknown>;
}

interface TreeSitterRuntime {
	Parser: ParserCtor;
	Language: LanguageStatic;
}

let runtimePromise: Promise<TreeSitterRuntime> | null = null;

/** Initialize (once per process) and return the engine handles. */
export function getTreeSitterRuntime(): Promise<TreeSitterRuntime> {
	if (!runtimePromise) runtimePromise = initRuntime();
	return runtimePromise;
}

async function initRuntime(): Promise<TreeSitterRuntime> {
	const TreeSitter = await import("web-tree-sitter");
	const Parser = (TreeSitter.Parser ?? TreeSitter.default) as unknown as ParserCtor | undefined;
	type ModuleLike = {
		Language?: LanguageStatic;
		default?: { Language?: LanguageStatic };
	};
	const moduleLike = TreeSitter as unknown as ModuleLike;
	const Language = moduleLike.Language ?? moduleLike.default?.Language;
	if (!Parser) throw new Error("web-tree-sitter Parser API is unavailable");
	if (!Language) throw new Error("web-tree-sitter Language API is unavailable");

	const { mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const tmpDir = mkdtempSync(join(tmpdir(), "narrafork-wasm-"));

	const coreBuf = await Bun.file(embeddedTreeSitterWasm).arrayBuffer();
	const corePath = join(tmpDir, "tree-sitter.wasm");
	writeFileSync(corePath, new Uint8Array(coreBuf));

	await Parser.init({
		locateFile() {
			return corePath;
		},
	});

	return { Parser, Language };
}

/**
 * Load a grammar from wasm bytes.
 *
 * `Language.load` accepts a `Uint8Array`, so it does not care whether the bytes
 * came from an embedded asset or from the on-demand grammar cache.
 */
export async function loadTreeSitterLanguage(bytes: Uint8Array): Promise<unknown> {
	const { Language } = await getTreeSitterRuntime();
	return Language.load(bytes);
}

/** Create a parser bound to an already-loaded language. */
export async function createTreeSitterParser(language: unknown): Promise<ParserInstance> {
	const { Parser } = await getTreeSitterRuntime();
	const parser = new Parser();
	parser.setLanguage(language);
	return parser;
}
