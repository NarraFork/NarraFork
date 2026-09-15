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
import { logger } from "../../logger";
import { narraforkDir } from "../../settings";
import {
	GRAMMAR_MANIFEST,
	GRAMMAR_PACKAGE_VERSION,
	type GrammarManifestEntry,
	getGrammarEntry,
} from "./grammar-manifest";

/** Cache directory for downloaded grammar wasm files. */
export const GRAMMAR_DIR = join(narraforkDir, "grammars");

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

/** Whether a grammar is present in the local cache. */
export function isGrammarInstalled(languageId: string): boolean {
	if (!getGrammarEntry(languageId)) return false;
	return existsSync(grammarCachePath(languageId));
}

export interface GrammarStatus {
	id: string;
	label: string;
	extensions: string[];
	installed: boolean;
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
			installed: sizeBytes !== undefined,
			...(sizeBytes !== undefined ? { sizeBytes } : {}),
			expectedBytes: entry.bytes,
			version: GRAMMAR_PACKAGE_VERSION,
			// Size is a cheap proxy here on purpose: hashing every grammar on every
			// settings page load would read ~7 MB off disk for a status list.
			...(sizeBytes !== undefined && sizeBytes !== entry.bytes ? { digestMismatch: true } : {}),
		});
	}
	return results;
}

/** Read a cached grammar's bytes, verifying the digest first. */
export async function readInstalledGrammar(languageId: string): Promise<Uint8Array | null> {
	const entry = getGrammarEntry(languageId);
	if (!entry) return null;
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

/** Delete a cached grammar. Returns false when nothing was there. */
export function removeGrammar(languageId: string): boolean {
	if (!getGrammarEntry(languageId)) return false;
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
