/**
 * Grammar management for structural parsing (`/api/grammars`).
 *
 * tree-sitter grammars are downloaded on demand rather than bundled (each is
 * 0.2–2.4 MB), so installing one is an explicit user action on the settings page —
 * never something a tool call triggers behind the model's back.
 *
 * Any authenticated user may install or remove grammars: the cache is a shared
 * parser asset like ripgrep, not instance configuration, and gating it on admin
 * would leave non-admin users permanently stuck with heuristic outlines. The
 * `:lang` parameter is checked against the manifest allow-list before it reaches
 * the filesystem, so it can never name a path of the caller's choosing.
 */
import { Hono } from "hono";
import {
	clearOutlineCache,
	downloadGrammar,
	grammarCacheSize,
	invalidateParser,
	isKnownGrammarLanguage,
	listGrammarStatus,
	removeGrammar,
} from "../lib/agent/structural";
import { ValidationError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";

export const grammarRoutes = new Hono();

grammarRoutes.use("/*", requireAuth);

function requireKnownLanguage(lang: string | undefined): string {
	if (!lang || !isKnownGrammarLanguage(lang)) {
		throw new ValidationError(`Unknown grammar language: ${lang ?? "(missing)"}`);
	}
	return lang;
}

/** GET /api/grammars — supported languages, install state, cache size. */
grammarRoutes.get("/", async (c) => {
	const [grammars, cacheBytes] = await Promise.all([listGrammarStatus(), grammarCacheSize()]);
	return c.json({ grammars, cacheBytes });
});

/** POST /api/grammars/:lang/download — fetch, verify and cache one grammar. */
grammarRoutes.post("/:lang/download", async (c) => {
	const lang = requireKnownLanguage(c.req.param("lang"));
	// bypassFailureCache: this is an explicit user retry, so a previous timeout must
	// not short-circuit the attempt they just asked for.
	const result = await downloadGrammar(lang, { bypassFailureCache: true });
	if (!result.ok) {
		return c.json({ ok: false, error: result.error ?? "Download failed" }, 502);
	}
	// A freshly downloaded grammar has to displace the negative cache entry left by
	// earlier calls, or parsing stays degraded until the process restarts.
	invalidateParser(lang);
	clearOutlineCache();
	return c.json({ ok: true, languageId: result.languageId, sizeBytes: result.sizeBytes });
});

/** DELETE /api/grammars/:lang — drop the cached grammar. */
grammarRoutes.delete("/:lang", async (c) => {
	const lang = requireKnownLanguage(c.req.param("lang"));
	const removed = removeGrammar(lang);
	invalidateParser(lang);
	clearOutlineCache();
	return c.json({ ok: true, removed });
});
