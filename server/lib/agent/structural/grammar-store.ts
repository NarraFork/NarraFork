/**
 * On-demand tree-sitter grammar download + cache.
 *
 * Mirrors the shape of `helper-binaries.ts` (cache dir, sha256 verification,
 * timeout, size cap, failure cache, atomic rename) but pulls from a public CDN
 * instead of the update server, because the grammars are published as npm package
 * files rather than NarraFork artifacts.
 *
 * Two deliberate constraints:
 *
 * 1. **Downloads never happen inside a tool call.** StructView degrades to a
 *    heuristic outline and tells the model which grammar is missing. Downloading
 *    on the tool path would put a multi-megabyte network fetch on the agent's
 *    critical path and make outbound requests the model did not ask for.
 * 2. **A digest mismatch is fatal for that download**, not a warning. This is
 *    executable wasm from a CDN; "probably fine" is not an option.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
// Bun rewrites this to a real file path in dev and inside the packaged binary — the same
// mechanism bash-analyze.ts uses to reach this grammar.
import embeddedBashWasm from "tree-sitter-bash/tree-sitter-bash.wasm" with { type: "file" };
import { logger } from "../../logger";
import { narraforkDir } from "../../settings";
import {
	GRAMMAR_MANIFEST,
	GRAMMAR_PACKAGE_VERSION,
	type GrammarManifestEntry,
	type GrammarTier,
	getGrammarEntry,
} from "./grammar-manifest";
import { createTreeSitterParser, loadTreeSitterLanguage } from "./tree-sitter-runtime";

/** Cache directory for downloaded grammar wasm files. */
export const GRAMMAR_DIR = join(narraforkDir, "grammars");

/**
 * Embedded grammar assets, by language id.
 *
 * Deliberately a lookup rather than a computed path: an embedded asset has to be a static
 * import for Bun to include it in the binary, so building the specifier at runtime would
 * resolve to something that was never packaged.
 */
const BUILTIN_GRAMMAR_ASSETS: Record<string, string> = {
	bash: embeddedBashWasm,
};

/** Read a builtin grammar's embedded bytes. */
async function readBuiltinGrammar(languageId: string): Promise<Uint8Array | null> {
	const asset = BUILTIN_GRAMMAR_ASSETS[languageId];
	if (!asset) return null;
	try {
		return new Uint8Array(await Bun.file(asset).arrayBuffer());
	} catch (err) {
		logger.warn("Failed to read embedded grammar", { languageId, error: String(err) });
		return null;
	}
}

const DEFAULT_CDN_TEMPLATE =
	"https://unpkg.com/tree-sitter-wasms@{version}/out/tree-sitter-{name}.wasm";
const FALLBACK_CDN_TEMPLATE =
	"https://cdn.jsdelivr.net/npm/tree-sitter-wasms@{version}/out/tree-sitter-{name}.wasm";

const DOWNLOAD_TIMEOUT_MS = 60_000;
/** No pinned grammar is anywhere near this; it only bounds a hostile response. */
const MAX_GRAMMAR_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_FAILURE_CACHE_MS = 30_000;

const downloadFailureCache = new Map<string, number>();

/** Local cache path for a language's grammar, whether or not it exists yet. */
export function grammarCachePath(languageId: string): string {
	return join(GRAMMAR_DIR, `tree-sitter-${languageId}.wasm`);
}

/** Whether a grammar is available: shipped in the binary, or present in the local cache. */
export function isGrammarInstalled(languageId: string): boolean {
	const entry = getGrammarEntry(languageId);
	if (!entry) return false;
	// A builtin grammar's bytes live in the executable, so there is nothing on disk to
	// look for. Checking the cache would report shell as missing while it is in fact
	// always loadable, and offer a download that would fetch a second copy.
	if (entry.builtin) return true;
	return existsSync(grammarCachePath(languageId));
}

export interface GrammarStatus {
	id: string;
	label: string;
	extensions: string[];
	/** Exact (hand-written table) vs rule-based structure. */
	tier: GrammarTier;
	/** Known limitation for this language, shown in the settings UI. */
	note?: string;
	/** Language ABI observed when this grammar was verified. */
	abi: number;
	installed: boolean;
	/**
	 * Shipped in the binary: always available, never downloaded, cannot be removed.
	 * The settings UI shows these without a download or delete action.
	 */
	builtin?: boolean;
	/** Actual on-disk size when installed. */
	sizeBytes?: number;
	/** Expected size from the manifest, shown before download. */
	expectedBytes: number;
	version: string;
	/**
	 * Set when the cached file's digest no longer matches the manifest — a version
	 * bump or a tampered/truncated file. Surfaced instead of silently ignored so the
	 * user can re-download rather than wonder why parsing degraded.
	 */
	digestMismatch?: boolean;
}

/** Status of every allow-listed grammar, for the settings page. */
export async function listGrammarStatus(): Promise<GrammarStatus[]> {
	const results: GrammarStatus[] = [];
	for (const entry of GRAMMAR_MANIFEST) {
		const path = grammarCachePath(entry.id);
		let sizeBytes: number | undefined;
		try {
			sizeBytes = statSync(path).size;
		} catch {
			sizeBytes = undefined;
		}
		results.push({
			id: entry.id,
			label: entry.label,
			extensions: entry.extensions,
			tier: entry.tier,
			...(entry.note ? { note: entry.note } : {}),
			abi: entry.abi,
			// Builtin grammars are always available and have no cache file to measure.
			installed: entry.builtin === true || sizeBytes !== undefined,
			...(entry.builtin ? { builtin: true } : {}),
			...(sizeBytes !== undefined ? { sizeBytes } : {}),
			expectedBytes: entry.bytes,
			version: GRAMMAR_PACKAGE_VERSION,
			// Size is a cheap proxy here on purpose: hashing every grammar on every
			// settings page load would read ~7 MB off disk for a status list.
			// Skipped for builtins: the manifest digest describes the CDN build, so
			// comparing it against a stray cache file would flag a phantom mismatch.
			...(!entry.builtin && sizeBytes !== undefined && sizeBytes !== entry.bytes
				? { digestMismatch: true }
				: {}),
		});
	}
	return results;
}

/**
 * Read a grammar's bytes: from the embedded asset for a builtin, otherwise from the
 * cache after verifying its digest.
 */
export async function readInstalledGrammar(languageId: string): Promise<Uint8Array | null> {
	const entry = getGrammarEntry(languageId);
	if (!entry) return null;

	if (entry.builtin) {
		const bytes = await readBuiltinGrammar(entry.id);
		if (bytes) return bytes;
		// Fall through: a packaging error should not make shell unparseable if a cached
		// copy happens to exist.
		logger.warn("Builtin grammar unavailable; falling back to cache", { languageId });
	}

	const path = grammarCachePath(languageId);
	if (!existsSync(path)) return null;

	try {
		const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
		if (!verifyDigest(bytes, entry)) {
			logger.warn("Cached tree-sitter grammar failed digest verification", {
				languageId,
				path,
				size: bytes.byteLength,
			});
			return null;
		}
		return bytes;
	} catch (err) {
		logger.warn("Failed to read cached tree-sitter grammar", {
			languageId,
			error: String(err),
		});
		return null;
	}
}

export interface DownloadGrammarResult {
	ok: boolean;
	languageId: string;
	path?: string;
	sizeBytes?: number;
	error?: string;
}

export interface DownloadGrammarOptions {
	/** Reuse a valid cached copy instead of re-downloading. Defaults to true. */
	useCache?: boolean;
	/** Ignore the recent-failure cache (explicit user retry). */
	bypassFailureCache?: boolean;
	/** Override the URL templates, e.g. for an intranet mirror. */
	urlTemplates?: string[];
	/** Injected for tests so the suite never touches the network. */
	fetchImpl?: typeof fetch;
	/**
	 * Load and parse-test the grammar before caching it. Defaults to true; only tests
	 * that supply synthetic bytes turn it off.
	 */
	verifyParse?: boolean;
}

/**
 * Download a grammar into the cache directory.
 *
 * Tries each CDN template in order and returns the first verified success. A
 * digest or size mismatch discards the bytes and moves on; it never falls back to
 * "install it anyway".
 */
export async function downloadGrammar(
	languageId: string,
	options: DownloadGrammarOptions = {},
): Promise<DownloadGrammarResult> {
	const entry = getGrammarEntry(languageId);
	if (!entry) {
		return { ok: false, languageId, error: `Unknown grammar: ${languageId}` };
	}

	// Nothing to fetch: the bytes are already in the executable. Reported as success
	// because the caller's goal ("make this grammar usable") is already satisfied.
	if (entry.builtin) {
		return { ok: true, languageId: entry.id, path: "<built in>", sizeBytes: 0 };
	}

	const path = grammarCachePath(entry.id);
	if (options.useCache !== false && existsSync(path)) {
		const cached = await readInstalledGrammar(entry.id);
		if (cached) {
			return { ok: true, languageId: entry.id, path, sizeBytes: cached.byteLength };
		}
	}

	if (options.bypassFailureCache) {
		downloadFailureCache.delete(entry.id);
	} else if (isFailureCached(entry.id)) {
		return {
			ok: false,
			languageId: entry.id,
			error: "A recent download attempt failed; retry in a moment.",
		};
	}

	const templates = options.urlTemplates ?? [DEFAULT_CDN_TEMPLATE, FALLBACK_CDN_TEMPLATE];
	const doFetch = options.fetchImpl ?? fetch;
	const errors: string[] = [];

	for (const template of templates) {
		const url = template
			.replaceAll("{version}", GRAMMAR_PACKAGE_VERSION)
			.replaceAll("{name}", entry.wasmName);
		try {
			const bytes = await fetchGrammarBytes(doFetch, url);
			if (!verifyDigest(bytes, entry)) {
				errors.push(`${url}: digest/size mismatch (rejected)`);
				logger.warn("Rejected tree-sitter grammar download after digest mismatch", {
					languageId: entry.id,
					url,
					size: bytes.byteLength,
					expectedBytes: entry.bytes,
				});
				continue;
			}
			// Verify the grammar actually PARSES before keeping it. A correct digest only
			// proves we received the intended bytes, not that the engine can run them: the
			// YAML grammar loads, reports its ABI, and then throws from inside wasm on the
			// first parse. Discovering that during a tool call would mean a crash on the
			// single-threaded server, where tree-sitter's synchronous wasm parse cannot yield.
			// This check runs only on the explicit user-triggered download path.
			if (options.verifyParse !== false) {
				const failure = await verifyGrammarParses(bytes);
				if (failure) {
					errors.push(`${url}: downloaded but unusable (${failure})`);
					logger.warn("Rejected tree-sitter grammar that failed its parse check", {
						languageId: entry.id,
						url,
						error: failure,
					});
					continue;
				}
			}

			writeAtomically(path, bytes);
			logger.info("Downloaded tree-sitter grammar", {
				languageId: entry.id,
				url,
				size: bytes.byteLength,
			});
			return { ok: true, languageId: entry.id, path, sizeBytes: bytes.byteLength };
		} catch (err) {
			errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	rememberFailure(entry.id);
	return { ok: false, languageId: entry.id, error: errors.join("; ") };
}

/**
 * Delete a cached grammar. Returns false when nothing was there.
 *
 * A builtin grammar cannot be removed: its bytes are in the executable, so deleting
 * would free nothing while breaking bash command analysis.
 */
export function removeGrammar(languageId: string): boolean {
	const entry = getGrammarEntry(languageId);
	if (!entry || entry.builtin) return false;
	const path = grammarCachePath(languageId);
	if (!existsSync(path)) return false;
	try {
		unlinkSync(path);
		logger.info("Removed tree-sitter grammar", { languageId, path });
		return true;
	} catch (err) {
		logger.warn("Failed to remove tree-sitter grammar", { languageId, error: String(err) });
		return false;
	}
}

/** Total bytes used by the grammar cache. */
export async function grammarCacheSize(): Promise<number> {
	try {
		const entries = await readdir(GRAMMAR_DIR, { withFileTypes: true });
		let total = 0;
		for (const dirent of entries) {
			if (!dirent.isFile()) continue;
			try {
				total += statSync(join(GRAMMAR_DIR, dirent.name)).size;
			} catch {
				// Raced with a delete; skip.
			}
		}
		return total;
	} catch {
		return 0;
	}
}

// ── internals ────────────────────────────────────────────────────────

async function fetchGrammarBytes(doFetch: typeof fetch, url: string): Promise<Uint8Array> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
	try {
		const resp = await doFetch(url, { signal: controller.signal });
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

		const declared = Number(resp.headers.get("content-length") ?? 0);
		if (declared > MAX_GRAMMAR_BYTES) {
			throw new Error(`declared size ${declared} exceeds ${MAX_GRAMMAR_BYTES} byte cap`);
		}

		const bytes = new Uint8Array(await resp.arrayBuffer());
		if (bytes.byteLength > MAX_GRAMMAR_BYTES) {
			throw new Error(`size ${bytes.byteLength} exceeds ${MAX_GRAMMAR_BYTES} byte cap`);
		}
		return bytes;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Load the grammar and parse a trivial input, returning an error string on failure.
 *
 * Deliberately catches everything: the failure being guarded against originates inside
 * wasm and surfaces as an ordinary `TypeError`, so a narrow catch would let it through.
 * A grammar that cannot parse a two-character document will not parse a real file, and
 * keeping it would arm a crash for a later tool call.
 */
async function verifyGrammarParses(bytes: Uint8Array): Promise<string | null> {
	try {
		const language = await loadTreeSitterLanguage(bytes);
		const parser = await createTreeSitterParser(language);
		const tree = parser.parse("x\n");
		if (!tree) return "parser returned no tree";
		try {
			// Touching the root is part of the check: some failures only appear when the
			// tree is walked rather than when it is created.
			void tree.rootNode.type;
		} finally {
			tree.delete();
		}
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

function verifyDigest(bytes: Uint8Array, entry: GrammarManifestEntry): boolean {
	if (bytes.byteLength !== entry.bytes) return false;
	const digest = createHash("sha256").update(bytes).digest("hex");
	return digest === entry.sha256.toLowerCase();
}

function writeAtomically(path: string, bytes: Uint8Array): void {
	mkdirSync(GRAMMAR_DIR, { recursive: true });
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temp, bytes);
		renameSync(temp, path);
	} catch (err) {
		try {
			unlinkSync(temp);
		} catch {
			// Best-effort cleanup of the failed temp file.
		}
		throw err;
	}
}

function rememberFailure(languageId: string): void {
	downloadFailureCache.set(languageId, Date.now() + DOWNLOAD_FAILURE_CACHE_MS);
}

function isFailureCached(languageId: string): boolean {
	const until = downloadFailureCache.get(languageId);
	if (!until) return false;
	if (until <= Date.now()) {
		downloadFailureCache.delete(languageId);
		return false;
	}
	return true;
}

/** Clear the failure cache. Test-only. */
export function clearGrammarFailureCache(): void {
	downloadFailureCache.clear();
}
