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

/**
 * How much structural fidelity a grammar can actually deliver.
 *
 * The distinction matters because downloading a grammar is not sufficient to make
 * StructView work on it: the provider also needs to know which node types are
 * declarations. A grammar with no declaration table would parse fine and report
 * nothing, which reads to the user like "this file has no structure" rather than
 * "we do not know how to read this language".
 *
 * - `verified`: hand-written declaration table, exact results.
 * - `generic`: no table; falls back to cross-language heuristics. Real results, but
 *   some declaration forms will be missed, and the tool says so.
 */
export type GrammarTier = "verified" | "generic";

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
	/** Structural fidelity available for this language. */
	tier: GrammarTier;
	/**
	 * Language ABI reported by the grammar when loaded, recorded from a real load.
	 *
	 * Kept because the engine accepts a RANGE of ABIs and the boundary moves when
	 * web-tree-sitter is upgraded; without it, diagnosing "this grammar stopped
	 * working" would mean re-probing all of them.
	 */
	abi: number;
	/** Known limitation, surfaced in the settings UI. */
	note?: string;
}

/**
 * Grammars present in the CDN package but deliberately not offered.
 *
 * Recorded with reasons rather than silently omitted: without this list the next
 * person to look would reasonably assume they were forgotten, and would re-add the
 * ones that actively break.
 */
export const EXCLUDED_GRAMMARS: ReadonlyArray<{ id: string; reason: string }> = [
	{
		id: "yaml",
		reason:
			"Loads and reports ABI 13, then throws from inside wasm during parse (unresolved external-scanner import). Since the failure happens at parse time rather than load time, a successful download would not reveal it.",
	},
	{ id: "elm", reason: "Language.load() fails outright with this engine version." },
	{ id: "ql", reason: "Language.load() fails outright with this engine version." },
	{
		id: "embedded_template",
		reason: "A 5 KB stub grammar with no useful declaration structure.",
	},
	{ id: "objc", reason: "7.7 MB for a niche language; not worth the download budget." },
	{ id: "tlaplus", reason: "Specialised formal-specification language; 4.9 MB." },
	{ id: "systemrdl", reason: "Specialised hardware-description language." },
	{ id: "rescript", reason: "Niche; no declaration table and unverified heuristics." },
	{ id: "elisp", reason: "Niche; s-expression structure does not map to the outline model." },
];

export const GRAMMAR_MANIFEST: readonly GrammarManifestEntry[] = [
	{
		id: "typescript",
		label: "TypeScript",
		wasmName: "typescript",
		sha256: "8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f",
		bytes: 2_342_690,
		extensions: [".ts", ".mts", ".cts"],
		tier: "verified",
		abi: 14,
	},
	{
		id: "tsx",
		label: "TypeScript (TSX)",
		wasmName: "tsx",
		sha256: "6aa3b2c70e76f5d48eafef1093e9c4de383e13f2fdde2f4e9b98a378f6a8f1b6",
		bytes: 2_411_272,
		extensions: [".tsx"],
		tier: "verified",
		abi: 14,
	},
	{
		id: "javascript",
		label: "JavaScript",
		wasmName: "javascript",
		sha256: "63812b9e275d26851264734868d27a1656bd44a2ef6eb3e85e6b03728c595ab5",
		bytes: 647_334,
		extensions: [".js", ".jsx", ".mjs", ".cjs"],
		tier: "verified",
		abi: 14,
	},
	{
		id: "python",
		label: "Python",
		wasmName: "python",
		sha256: "9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b",
		bytes: 476_105,
		extensions: [".py", ".pyi"],
		tier: "verified",
		abi: 14,
	},
	{
		id: "go",
		label: "Go",
		wasmName: "go",
		sha256: "9963ca89b616eaf04b08a43bc1fb0f07b85395bec313330851f1f1ead2f755b6",
		bytes: 235_957,
		extensions: [".go"],
		tier: "verified",
		abi: 14,
	},
	{
		id: "rust",
		label: "Rust",
		wasmName: "rust",
		sha256: "4409921a70d0aa5bec7d1d7ce809a557a8ee1cf6ace901e3ac6a76e62cfea903",
		bytes: 818_756,
		extensions: [".rs"],
		tier: "verified",
		abi: 14,
	},
	{
		id: "java",
		label: "Java",
		wasmName: "java",
		sha256: "637aac4415fb39a211a4f4292d63c66b5ce9c32fa2cd35464af4f681d91b9a1f",
		bytes: 430_239,
		extensions: [".java"],
		tier: "verified",
		abi: 14,
	},
	{
		id: "c",
		label: "C",
		wasmName: "c",
		sha256: "056b25072382f72deee2c64ec238ffc4bb8cf42844ef21502c0e70f03a8a0d66",
		bytes: 792_959,
		extensions: [".c", ".h"],
		tier: "verified",
		abi: 14,
	},
	{
		id: "cpp",
		label: "C++",
		wasmName: "cpp",
		sha256: "f6afdf53bfd6de76557bb7edb624a3a3869e14d9a83b78433f93617ecee42527",
		bytes: 4_662_978,
		extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
		tier: "verified",
		abi: 14,
	},
	{
		id: "c_sharp",
		label: "C#",
		wasmName: "c_sharp",
		sha256: "6266a7e32d68a3459104d994dc848df15d5672b0ea8e86d327274b694f8e6991",
		bytes: 3_978_594,
		extensions: [".cs"],
		tier: "verified",
		abi: 13,
	},
	{
		id: "php",
		label: "PHP",
		wasmName: "php",
		sha256: "55bb617b6f01e14bab997861f0b20a2420cf6ba3199ffeb295b9ec398966d8a3",
		bytes: 812_594,
		extensions: [".php"],
		tier: "verified",
		abi: 14,
	},
	{
		id: "ruby",
		label: "Ruby",
		wasmName: "ruby",
		sha256: "93a5022855314cdb45458c7bb026a24a0ebc3a5ff6439e542e881f14dfa13a39",
		bytes: 2_106_447,
		extensions: [".rb", ".rake", ".gemspec"],
		tier: "verified",
		abi: 14,
	},
	{
		id: "kotlin",
		label: "Kotlin",
		wasmName: "kotlin",
		sha256: "b5cb00c8d06ed0f10f1dbe497205b437809d7e87db1f638721a8cfb30e044449",
		bytes: 4_052_705,
		extensions: [".kt", ".kts"],
		tier: "verified",
		abi: 14,
	},
	{
		id: "swift",
		label: "Swift",
		wasmName: "swift",
		sha256: "41c4fdb2249a3aa6d87eed0d383081ff09725c2248b4977043a43825980ffcc7",
		bytes: 3_147_876,
		extensions: [".swift"],
		tier: "verified",
		abi: 13,
	},
	// ── generic tier: parse correctly, but structure comes from cross-language rules ──
	{
		id: "bash",
		label: "Shell",
		wasmName: "bash",
		sha256: "807dcdb1380a59befb112ed8fbd3d3872c7fadaf5903a769282b50973b30696d",
		bytes: 1_400_214,
		extensions: [".sh", ".bash", ".zsh"],
		tier: "generic",
		abi: 14,
		note: "Function definitions are detected; shell has little other declaration structure.",
	},
	{
		id: "scala",
		label: "Scala",
		wasmName: "scala",
		sha256: "160cfbb8ff7220886e99ed9699abceb6d837b4cd28993b9282c7f445a0554abd",
		bytes: 215_264,
		extensions: [".scala", ".sc"],
		tier: "generic",
		abi: 13,
	},
	{
		id: "zig",
		label: "Zig",
		wasmName: "zig",
		sha256: "59cc4531aa661e2de4c5bc04e4045b6bdd5d2bfa75045cbda5f673102d140eef",
		bytes: 690_754,
		extensions: [".zig"],
		tier: "generic",
		abi: 14,
	},
	{
		id: "dart",
		label: "Dart",
		wasmName: "dart",
		sha256: "7f5364e4256cf7e55efd01dd52421ef2663caa8061b82659b7e4bf61064545ec",
		bytes: 984_666,
		extensions: [".dart"],
		tier: "generic",
		abi: 15,
	},
	{
		id: "solidity",
		label: "Solidity",
		wasmName: "solidity",
		sha256: "160745e470f234cae903a9ba445d19e758d0b02e1197401fc765976c6254d2b6",
		bytes: 423_940,
		extensions: [".sol"],
		tier: "generic",
		abi: 14,
	},
	{
		id: "ocaml",
		label: "OCaml",
		wasmName: "ocaml",
		sha256: "60849b6320ee956233d77b017c65c45660e507d03ae70aa1bd5783458e2e9e18",
		bytes: 5_018_068,
		extensions: [".ml", ".mli"],
		tier: "generic",
		abi: 14,
	},
	{
		id: "css",
		label: "CSS",
		wasmName: "css",
		sha256: "5fc615467b1b98420ed7517e5bf9e1f88468132dd903d842dfb13714f6a1cb0c",
		bytes: 98_133,
		extensions: [".css", ".scss"],
		tier: "generic",
		abi: 14,
		note: "Rule selectors are not declarations; expect a sparse outline. `print` is usually the better mode.",
	},
	{
		id: "html",
		label: "HTML",
		wasmName: "html",
		sha256: "11b3405c1543fb012f5ed7f8ee73125076dce8b168301e1e787e4c717da6b456",
		bytes: 18_468,
		extensions: [".html", ".htm"],
		tier: "generic",
		abi: 14,
		note: "Markup has no declarations; useful mainly so mixed-language files parse at all.",
	},
	{
		id: "vue",
		label: "Vue",
		wasmName: "vue",
		sha256: "6244521bb3fb60f34ce5f677f2af81facb2c38691193985ca5fa85e1b6f29250",
		bytes: 23_895,
		extensions: [".vue"],
		tier: "generic",
		abi: 14,
		note: "Only the SFC block structure is parsed; script contents need the JS/TS grammar and are not descended into.",
	},
	{
		id: "json",
		label: "JSON",
		wasmName: "json",
		sha256: "fdb5219abe058369e16897aaa11eecf47ef4f546752c3ddbac339cdd89e1e667",
		bytes: 5_961,
		extensions: [".json", ".jsonc"],
		tier: "generic",
		abi: 14,
		note: "Data, not code. Included because `print` addressing plus a valid parse is still useful.",
	},
	{
		id: "toml",
		label: "TOML",
		wasmName: "toml",
		sha256: "7849ac8ce9d10a4684ca189ea8ad3654c20c38acb2d674a014a164398cbd37a2",
		bytes: 25_436,
		extensions: [".toml"],
		tier: "generic",
		abi: 13,
		note: "Data, not code.",
	},
	{
		id: "lua",
		label: "Lua",
		wasmName: "lua",
		sha256: "75ef809136d610068c5b2135741d89f5df62690a3d55169203351cb7cc85727d",
		bytes: 43_539,
		extensions: [".lua"],
		tier: "generic",
		abi: 13,
		note: "This grammar's node names do not follow the conventions the generic rules rely on, so declarations are mostly NOT detected. Parsing works; the outline will be near-empty.",
	},
	{
		id: "elixir",
		label: "Elixir",
		wasmName: "elixir",
		sha256: "82e91b9759ddca30d8978ebbfa8e347b4451b64c931f9ae62112e6db9b8fac20",
		bytes: 1_617_756,
		extensions: [".ex", ".exs"],
		tier: "generic",
		abi: 14,
		note: "Elixir models `defmodule`/`def` as ordinary calls, so the generic rules cannot identify declarations. Parsing works; the outline will be near-empty.",
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
