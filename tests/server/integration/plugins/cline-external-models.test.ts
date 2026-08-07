import { afterEach, describe, expect, test } from "bun:test";
import {
	buildCatalog,
	MAX_MODELS,
	type PoolModel,
	resetModelCaches,
	searchPool,
} from "../../../../examples/plugins/cline-external/src/models";

/**
 * The model catalog and the pool search.
 *
 * The load-bearing decision under test: `provider.listModels` serves the user's **enabled
 * set**, never the 300+ model OpenRouter pool, and therefore never paginates and never calls
 * upstream. Both properties are asserted rather than described, because either one silently
 * regressing produces a plugin that works in development and floods the model picker or stalls
 * catalog refresh in production.
 */

afterEach(() => {
	// The pool cache is module state; leaking it between cases would let one test's fixture
	// satisfy another's "no cache" precondition.
	resetModelCaches();
});

function pool(entries: Array<[string, number | undefined]>): PoolModel[] {
	return entries.map(([id, contextLength]) => ({
		id,
		name: id.toUpperCase(),
		...(contextLength === undefined ? {} : { contextLength }),
	}));
}

describe("cline-external models: the catalog is the enabled set", () => {
	test("an empty selection yields an empty, stale catalog rather than an error", () => {
		// This is the normal state right after install: the host refreshes catalogs for every
		// registered provider before the user has chosen anything. An error here would surface as
		// a broken plugin and, during release validation, as a failing package.
		const result = buildCatalog([]);
		expect(result.models).toEqual([]);
		expect(result.stale).toBe(true);
	});

	test("the enabled ids are returned in order", () => {
		const result = buildCatalog(["b/two", "a/one"]);
		expect(result.models.map((model) => model.id)).toEqual(["b/two", "a/one"]);
	});

	test("no cursor is emitted, because there is never a second page", () => {
		// The host follows `nextCursor` when present. Emitting one for a single-page result would
		// make it fetch again for nothing; implementing pagination for a human-sized list would be
		// code that never runs.
		// Widened through `unknown`: `CatalogResult` has no `nextCursor`, which is exactly the
		// property under test, so a direct cast to an index type is rejected.
		const result = buildCatalog(["a", "b", "c"]) as unknown as Record<string, unknown>;
		expect("nextCursor" in result).toBe(false);
	});

	test("a selection longer than the declared page size is truncated", () => {
		// `maxModelPageSize` in the manifest is what the host clamps against, so exceeding it
		// would be rejected. Truncating is visible in the log; returning an over-long page is not.
		const many = Array.from({ length: MAX_MODELS + 7 }, (_, index) => `vendor/model-${index}`);
		const result = buildCatalog(many);
		expect(result.models).toHaveLength(MAX_MODELS);
		expect(result.models[0].id).toBe("vendor/model-0");
	});

	test("the truncation limit matches what the manifest declares", async () => {
		// Two sources of truth by necessity — the manifest is data the host reads, the constant is
		// what the code enforces. This is the assertion that keeps them from drifting.
		const manifest = (await Bun.file("examples/plugins/cline-external/manifest.json").json()) as {
			contributes: { providers: Array<{ limits?: { maxModelPageSize?: number } }> };
		};
		expect(manifest.contributes.providers[0].limits?.maxModelPageSize).toBe(MAX_MODELS);
	});

	test("every model is declared non-reasoning", () => {
		// OpenAI chat/completions cannot return a thinking block, so a continuation is
		// impossible. Claiming otherwise would have the host request one this provider must drop.
		const result = buildCatalog(["anthropic/claude-sonnet-4.6"]);
		expect(result.models[0].capabilities.reasoning).toBe(false);
		expect(result.models[0].capabilities.sessionMode).toBe("stateless");
	});

	test("the catalog version changes with the selection", () => {
		// Lets the host tell a real update from a no-op refresh.
		const first = buildCatalog(["a", "b"]).catalogVersion;
		const second = buildCatalog(["a", "c"]).catalogVersion;
		const same = buildCatalog(["a", "b"]).catalogVersion;
		expect(first).not.toBe(second);
		expect(first).toBe(same);
	});
});

describe("cline-external models: catalog metadata without a network call", () => {
	test("an absent pool cache falls back to a default context window", () => {
		// Catalog refresh runs on a schedule the user never sees. Blocking it on a third-party
		// endpoint would make the provider look broken whenever OpenRouter is slow.
		const result = buildCatalog(["unknown/model"]);
		expect(result.models[0].contextWindow).toBe(128_000);
		expect(result.models[0].displayName).toBe("unknown/model");
	});

	test("buildCatalog performs no fetch at all", async () => {
		// The strongest form of the previous assertion: if it ever starts reaching upstream, this
		// fails rather than merely getting slower.
		const original = globalThis.fetch;
		let called = false;
		globalThis.fetch = ((): Promise<Response> => {
			called = true;
			return Promise.reject(new Error("listModels must not reach the network"));
		}) as unknown as typeof fetch;
		try {
			buildCatalog(["a/b", "c/d"]);
			expect(called).toBe(false);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("cline-external models: pool search", () => {
	const fixture = pool([
		["anthropic/claude-sonnet-4.6", 200_000],
		["anthropic/claude-opus-4.6", 200_000],
		["deepseek/deepseek-chat", 64_000],
		["kwaipilot/kat-coder-pro", undefined],
	]);

	test("all terms must match, so a query narrows rather than widens", () => {
		// An OR match over 300 models returns almost everything and is useless for narrowing,
		// which is why the built-in endpoint uses AND too.
		const result = searchPool(fixture, "claude sonnet", 50);
		expect(result.models.map((model) => model.id)).toEqual(["anthropic/claude-sonnet-4.6"]);
		expect(result.total).toBe(1);
	});

	test("the name is searched as well as the id", () => {
		const result = searchPool(fixture, "DEEPSEEK-CHAT", 50);
		expect(result.models).toHaveLength(1);
	});

	test("an empty query returns the head of the pool with the true total", () => {
		const result = searchPool(fixture, "   ", 2);
		expect(result.models).toHaveLength(2);
		expect(result.total).toBe(fixture.length);
	});

	test("the limit caps results but not the reported total", () => {
		// The settings view shows "N of M"; capping the total would misreport how much was found.
		const result = searchPool(fixture, "anthropic", 1);
		expect(result.models).toHaveLength(1);
		expect(result.total).toBe(2);
	});

	test("no match yields an empty result rather than the whole pool", () => {
		expect(searchPool(fixture, "nonexistent-vendor", 50)).toEqual({ models: [], total: 0 });
	});
});
