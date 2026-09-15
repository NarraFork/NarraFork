/**
 * Per-language parser pool.
 *
 * `Language.load` compiles a wasm module and a `Parser` binds to one language, so
 * both are cached per language id rather than rebuilt per tool call. Parsing a
 * 2000-line file is milliseconds; loading a 2.4 MB grammar is not.
 *
 * A failed load is cached as a negative result. If a grammar's ABI does not match
 * the engine, retrying on every call would repay the same multi-megabyte load for
 * the same failure — the provider degrades to a heuristic outline instead.
 */
import { logger } from "../../logger";
import { getGrammarEntry } from "./grammar-manifest";
import { isGrammarInstalled, readInstalledGrammar } from "./grammar-store";
import {
	createTreeSitterParser,
	loadTreeSitterLanguage,
	type ParserInstance,
} from "./tree-sitter-runtime";

/** Why a language is unavailable, phrased for the model. */
export type ParserUnavailableReason = "unknown-language" | "not-installed" | "load-failed";

export interface ParserLease {
	ok: true;
	parser: ParserInstance;
	languageId: string;
}

export interface ParserUnavailable {
	ok: false;
	reason: ParserUnavailableReason;
	detail?: string;
}

export type ParserResult = ParserLease | ParserUnavailable;

const parsers = new Map<string, ParserInstance>();
const inFlight = new Map<string, Promise<ParserResult>>();
const failed = new Map<string, string>();

/**
 * Obtain a parser for a language.
 *
 * Never downloads: a missing grammar returns `not-installed` so the caller can
 * degrade and tell the user where to install it. Putting a CDN fetch on the tool
 * path would block the agent on the network and make outbound requests the model
 * never asked for.
 */
export async function acquireParser(languageId: string): Promise<ParserResult> {
	if (!getGrammarEntry(languageId)) {
		return { ok: false, reason: "unknown-language" };
	}

	const cached = parsers.get(languageId);
	if (cached) return { ok: true, parser: cached, languageId };

	const priorFailure = failed.get(languageId);
	if (priorFailure) {
		return { ok: false, reason: "load-failed", detail: priorFailure };
	}

	if (!isGrammarInstalled(languageId)) {
		return { ok: false, reason: "not-installed" };
	}

	const pending = inFlight.get(languageId);
	if (pending) return pending;

	const promise = loadParser(languageId).finally(() => {
		inFlight.delete(languageId);
	});
	inFlight.set(languageId, promise);
	return promise;
}

async function loadParser(languageId: string): Promise<ParserResult> {
	try {
		const bytes = await readInstalledGrammar(languageId);
		if (!bytes) {
			// Present but unreadable or digest-mismatched. Not a hard failure: a
			// re-download from the settings page fixes it, so this must not be cached
			// as permanently broken.
			return {
				ok: false,
				reason: "not-installed",
				detail: "cached grammar failed verification",
			};
		}
		const language = await loadTreeSitterLanguage(bytes);
		const parser = await createTreeSitterParser(language);
		parsers.set(languageId, parser);
		return { ok: true, parser, languageId };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		failed.set(languageId, detail);
		logger.warn("Failed to load tree-sitter grammar", { languageId, error: detail });
		return { ok: false, reason: "load-failed", detail };
	}
}

/**
 * Drop a cached parser so the next call reloads it.
 *
 * Called after a download or delete in the settings page: without this, removing a
 * grammar would keep working until restart and re-downloading a broken one would
 * stay broken.
 */
export function invalidateParser(languageId: string): void {
	parsers.delete(languageId);
	failed.delete(languageId);
}

/** Language ids with a live parser. Diagnostics only. */
export function loadedParserLanguages(): string[] {
	return [...parsers.keys()];
}
