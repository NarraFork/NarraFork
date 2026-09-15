/**
 * Pinned tree-sitter grammar manifest.
 *
 * Grammars are NOT bundled into the binary — they are 0.2–2.4 MB each and only a
 * fraction of users need any given language. They are downloaded on demand from a
 * CDN into `~/.narrafork/grammars/` instead.
 *
 * That makes this file a security boundary, not a convenience table: we are
 * fetching executable WebAssembly from a third-party CDN, so every download is
 * verified against the digest recorded here and discarded on mismatch. Bundling
 * the digests costs a few hundred bytes; bundling the grammars would cost ~7 MB
 * for this first batch alone.
 *
 * Digests were computed from `unpkg.com/tree-sitter-wasms@0.1.13/out/*.wasm` and
 * each grammar was verified to load under web-tree-sitter 0.25.10 (language ABI
 * 14). To add or bump a language: download the file, recompute sha256, and update
 * both `sha256` and `bytes` — a stale digest disables the grammar rather than
 * silently trusting whatever the CDN served.
 */

/** Version of the `tree-sitter-wasms` npm package the digests below were taken from. */
export const GRAMMAR_PACKAGE_VERSION = "0.1.13";

/**
 * Upstream ABI version of the pinned grammars. web-tree-sitter refuses grammars
 * outside its supported range, so a future bump must re-verify this.
 */
export const GRAMMAR_LANGUAGE_ABI = 14;

export interface GrammarManifestEntry {
	/** Language id used everywhere else (settings, API, cache filenames). */
	id: string;
	/** Display name for the settings UI. */
	label: string;
	/** Basename inside the CDN package (`out/tree-sitter-<wasmName>.wasm`). */
	wasmName: string;
	/** Expected sha256 of the wasm file, lowercase hex. */
	sha256: string;
	/** Expected byte size — a cheap pre-check before hashing. */
	bytes: number;
	/** File extensions that map to this language, lowercase and dot-prefixed. */
	extensions: string[];
}

export const GRAMMAR_MANIFEST: readonly GrammarManifestEntry[] = [
	{
		id: "typescript",
		label: "TypeScript",
		wasmName: "typescript",
		sha256: "8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f",
		bytes: 2_342_690,
		extensions: [".ts", ".mts", ".cts"],
	},
	{
		id: "tsx",
		label: "TypeScript (TSX)",
		wasmName: "tsx",
		sha256: "6aa3b2c70e76f5d48eafef1093e9c4de383e13f2fdde2f4e9b98a378f6a8f1b6",
		bytes: 2_411_272,
		extensions: [".tsx"],
	},
	{
		id: "javascript",
		label: "JavaScript",
		wasmName: "javascript",
		sha256: "63812b9e275d26851264734868d27a1656bd44a2ef6eb3e85e6b03728c595ab5",
		bytes: 647_334,
		extensions: [".js", ".jsx", ".mjs", ".cjs"],
	},
	{
		id: "python",
		label: "Python",
		wasmName: "python",
		sha256: "9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b",
		bytes: 476_105,
		extensions: [".py", ".pyi"],
	},
	{
		id: "go",
		label: "Go",
		wasmName: "go",
		sha256: "9963ca89b616eaf04b08a43bc1fb0f07b85395bec313330851f1f1ead2f755b6",
		bytes: 235_957,
		extensions: [".go"],
	},
	{
		id: "rust",
		label: "Rust",
		wasmName: "rust",
		sha256: "4409921a70d0aa5bec7d1d7ce809a557a8ee1cf6ace901e3ac6a76e62cfea903",
		bytes: 818_756,
		extensions: [".rs"],
	},
	{
		id: "java",
		label: "Java",
		wasmName: "java",
		sha256: "637aac4415fb39a211a4f4292d63c66b5ce9c32fa2cd35464af4f681d91b9a1f",
		bytes: 430_239,
		extensions: [".java"],
	},
];

const byId = new Map(GRAMMAR_MANIFEST.map((entry) => [entry.id, entry]));

const byExtension = new Map<string, GrammarManifestEntry>();
for (const entry of GRAMMAR_MANIFEST) {
	for (const ext of entry.extensions) byExtension.set(ext, entry);
}

/** Manifest entry for a language id, or null when the id is not in the allow-list. */
export function getGrammarEntry(languageId: string): GrammarManifestEntry | null {
	return byId.get(languageId) ?? null;
}

/**
 * Language id for a file extension (dot-prefixed, any case).
 *
 * Detection stops at the extension on purpose: content sniffing would mean
 * reading and guessing before we know whether a grammar is even installed.
 */
export function languageIdForExtension(extension: string): string | null {
	return byExtension.get(extension.toLowerCase())?.id ?? null;
}

/** Whether a language id is a known, allow-listed grammar. */
export function isKnownGrammarLanguage(languageId: string): boolean {
	return byId.has(languageId);
}
