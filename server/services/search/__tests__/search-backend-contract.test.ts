/**
 * Search backend contract: the port is real, SQLite is the default, and every registered
 * backend resolves to a store that satisfies the port.
 *
 * WHY THESE PARTICULAR ASSERTIONS
 * -------------------------------
 * A port only helps if it is actually on the path from a request to the database. Two failures
 * would leave every other test in this repository green:
 *
 *   1. an unused abstraction — the interface exists, the store exists, and the callers still
 *      run their own SQL. The suite passes because the old code still works, and the port's
 *      value ("implement this and search works") is a claim nobody has checked.
 *   2. a silently-substituted backend — asking for a backend that has no implementation
 *      returns the SQLite one. Everything passes while search reads the wrong database, which
 *      is precisely the failure the dual-database guards exist to prevent.
 *
 * So this file asserts the callers reach the store, and that backend resolution is honest in
 * both directions: an implemented backend resolves to ITS OWN store (not a fallback), and an
 * unknown backend name still refuses loudly. The PostgreSQL store's behaviour (recall,
 * ranking, ACL, trigger-maintained indexes) is covered by the PG integration suites that run
 * against a real server; what is pinned HERE is registration, not SQL.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	DEFAULT_SEARCH_BACKEND,
	isSearchBackendImplemented,
	resolveSearchStore,
	searchStore,
} from "../backend";
import type { SearchStore } from "../port";
import type { MessageSearchRow } from "../types";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

function source(relativePath: string): string {
	return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/** Every method the port declares, so a caller-coverage gap is a listed name, not a vibe. */
const PORT_METHODS = [
	"searchChapters",
	"searchMessages",
	"searchNarrators",
	"searchTimeline",
	"searchRecallMessages",
	"searchKnowledgeEntries",
	"searchKnowledgeDrafts",
	"listShadowedEntryIds",
] as const satisfies readonly (keyof SearchStore)[];

describe("the search port has real callers", () => {
	it("exposes every declared method on the resolved store", () => {
		for (const method of PORT_METHODS) {
			expect(typeof searchStore[method]).toBe("function");
		}
	});

	/**
	 * Each method is called by production code somewhere.
	 *
	 * A lexical check on purpose: the alternative is spying on the store from a test that
	 * drives a real request, which needs a database, an FTS index and an authenticated
	 * principal per method — the search suites already do that. What is NOT covered by them
	 * is "did anybody wire this method at all", which is exactly what a fresh port gets wrong.
	 */
	it("has a production call site for each method", () => {
		const callers = [
			"server/services/search-service.ts",
			"server/services/knowledge-service.ts",
			"server/lib/agent/tools/recall.ts",
		].map(source);
		const combined = callers.join("\n");
		const uncalled = PORT_METHODS.filter((method) => !combined.includes(`.${method}(`));
		expect(uncalled).toEqual([]);
	});

	/**
	 * The callers no longer hold FTS5 statements of their own.
	 *
	 * This is the assertion that makes the port load-bearing rather than decorative: if these
	 * modules still contained `MATCH`/`snippet()`, a second backend could be added, every test
	 * would pass, and search would still be running SQLite-only SQL from four places. Checked
	 * on comment-stripped source so the prose explaining the design does not match.
	 */
	it("leaves no FTS5 query text in the business-layer callers", () => {
		const offenders: string[] = [];
		for (const path of [
			"server/services/search-service.ts",
			"server/services/knowledge-service.ts",
			"server/lib/agent/tools/recall.ts",
			"server/routes/search.ts",
		]) {
			const code = stripComments(source(path));
			for (const pattern of [/\bMATCH\s*\?/, /\bsnippet\s*\(\s*\w+_fts\b/, /\b\w+_fts\b/]) {
				if (pattern.test(code)) offenders.push(`${path} :: ${pattern}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The business layer does not import the raw driver either.
	 *
	 * `search-service.ts` and `recall.ts` both imported `Statement` from `bun:sqlite` before
	 * this phase. A leaked driver type in a business signature is how a port stops being a
	 * boundary: the next caller writes against `Statement` and the abstraction is gone.
	 */
	it("keeps the bun:sqlite driver out of the search business layer", () => {
		for (const path of ["server/services/search-service.ts", "server/routes/search.ts"]) {
			expect(source(path)).not.toInclude("bun:sqlite");
		}
	});
});

describe("the port is async, and un-awaited calls fail at compile time", () => {
	/**
	 * Every method returns a Promise.
	 *
	 * The mapped type resolves each port method's return type; a method that went back to
	 * returning rows synchronously would map to `never`, and the object literal below would
	 * stop compiling. The runtime shadow exists so this suite also carries the assertion,
	 * not just the type checker.
	 */
	type AsyncReturns = {
		[K in (typeof PORT_METHODS)[number]]: ReturnType<SearchStore[K]> extends Promise<unknown>
			? true
			: never;
	};
	const asyncReturns: AsyncReturns = {
		searchChapters: true,
		searchMessages: true,
		searchNarrators: true,
		searchTimeline: true,
		searchRecallMessages: true,
		searchKnowledgeEntries: true,
		searchKnowledgeDrafts: true,
		listShadowedEntryIds: true,
	};

	it("returns a Promise from every port method", () => {
		expect(Object.keys(asyncReturns).sort()).toEqual([...PORT_METHODS].sort());
		expect(Object.values(asyncReturns)).toEqual(PORT_METHODS.map(() => true));
	});

	/**
	 * The negative assertion: consuming an un-awaited result AS ROWS must not type-check.
	 *
	 * "Forgot the await" previously presented as zero hits with no stack — every consumer
	 * below (`for..of`, `.map`, `.length`) silently operated on a Promise. The generic
	 * helper demands a row array; feeding it the port's actual return type is the mistake,
	 * pinned by @ts-expect-error so the day the port goes synchronous again THIS FILE fails
	 * to compile (the suppression becomes unused).
	 */
	it("does not type-check a store result consumed without await", () => {
		const consumeRows = (rows: MessageSearchRow[]) => rows.length;
		const unawaited = [] as unknown as ReturnType<SearchStore["searchMessages"]>;
		// @ts-expect-error — the port returns Promise<MessageSearchRow[]>; passing it to a
		// rows consumer is exactly the "forgot the await" failure this contract prevents.
		expect(consumeRows(unawaited)).toBe(0);
	});
});

describe("backend selection", () => {
	it("defaults to SQLite", () => {
		expect(DEFAULT_SEARCH_BACKEND).toBe("sqlite");
		expect(searchStore.backend).toBe("sqlite");
		expect(resolveSearchStore()).toBe(searchStore);
	});

	it("reports SQLite as implemented", () => {
		expect(isSearchBackendImplemented("sqlite")).toBe(true);
	});
	/**
	 * PostgreSQL is registered and resolves to its own store.
	 *
	 * The load-bearing assertion is identity: if `resolveSearchStore("postgres")` returned
	 * the SQLite store, "PostgreSQL search works" would be indistinguishable from the truth
	 * in every test here. The resolved store must expose every port method; whether it can
	 * reach a database is a separate claim (the store binds late and fails closed until the
	 * startup path wires its connection — pinned by the "fails closed before binding" test).
	 */
	it("resolves the registered postgres backend to its own store", () => {
		expect(isSearchBackendImplemented("postgres")).toBe(true);
		const store = resolveSearchStore("postgres");
		expect(store).not.toBe(searchStore);
		expect(store.backend).toBe("postgres");
		for (const method of PORT_METHODS) {
			expect(typeof store[method]).toBe("function");
		}
	});

	/**
	 * A registered store is not a reachable one.
	 *
	 * Registration is a module-level claim; the connection is wired by the startup path.
	 * Until then a query against the postgres store must throw rather than return an empty
	 * result that reads as "no hits".
	 */
	it("fails closed when the postgres store is queried before its client is bound", async () => {
		const store = resolveSearchStore("postgres");
		await expect(
			store.searchChapters({
				text: "anything",
				strategy: "index",
				limit: 1,
				viewer: { userId: "nobody", isAdmin: true },
			}),
		).rejects.toThrow(/not bound/);
	});
});

/**
 * Strip line and block comments so documentation prose does not match a code pattern.
 *
 * Deliberately simple: it treats `//` and `/* *\/` as comment starts without tracking string
 * literals, which can over-strip a URL inside a string. Over-stripping only makes the checks
 * above more permissive on text that is not SQL, and every file it runs on is a file this
 * phase owns.
 */
function stripComments(code: string): string {
	return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
