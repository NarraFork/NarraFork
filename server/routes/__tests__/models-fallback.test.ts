import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression tests for the model-list fallback logic on the provider "test"
 * pages. The core bug: when several candidate URLs are tried in order, only the
 * LAST candidate's error surfaced, hiding the real (configured) endpoint's
 * error. These tests lock in:
 *   1. OpenAI buildModelsUrls: a suggest-safe `${baseUrl}/v1/models` candidate
 *      is generated (carrying suggestBaseUrl) while origin-based candidates are
 *      informational only (no suggestBaseUrl).
 *   2. Anthropic fetchAnthropicModels: when every candidate fails, the thrown
 *      error aggregates all attempts with the CONFIGURED URL listed first.
 */

type BuildModelsUrls = (baseUrl: string) => Array<{ url: string; suggestBaseUrl?: string }>;
type FetchAnthropicModels = (config: {
	id: string;
	name: string;
	baseUrl?: string;
	apiKey?: string;
	officialApi?: boolean;
}) => Promise<{ models: Array<{ id: string }>; resolvedBaseUrl?: string }>;

let buildModelsUrls: BuildModelsUrls;
let fetchAnthropicModels: FetchAnthropicModels;
let testHome = "";
let originalNarraforkHome: string | undefined;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
	// Both route modules transitively initialise the DB layer at import time,
	// which resolves its data dir from NARRAFORK_HOME (NOT process.env.HOME —
	// node's os.homedir() reads the system passwd entry, so overriding HOME would
	// not isolate it). Point it at a fresh temp dir so the test uses its own empty
	// SQLite file instead of contending for the real ~/.narrafork instance lock.
	originalNarraforkHome = process.env.NARRAFORK_HOME;
	testHome = mkdtempSync(join(tmpdir(), "narrafork-models-fallback-"));
	process.env.NARRAFORK_HOME = testHome;

	const openaiMod = await import("../openai");
	buildModelsUrls = openaiMod.buildModelsUrls as unknown as BuildModelsUrls;
	const anthropicMod = await import("../anthropic");
	fetchAnthropicModels = anthropicMod.fetchAnthropicModels as unknown as FetchAnthropicModels;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	if (originalNarraforkHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = originalNarraforkHome;
	if (testHome) rmSync(testHome, { recursive: true, force: true });
});

describe("buildModelsUrls (OpenAI) suggest-safety", () => {
	test("adds a suggest-safe baseUrl + /v1/models candidate when /v1 is missing", () => {
		const candidates = buildModelsUrls("https://relay.example.com/api");
		// First is always the configured URL, with no suggestion.
		expect(candidates[0]).toEqual({ url: "https://relay.example.com/api/models" });
		// A suggest-safe candidate appends /v1 to the configured base URL.
		const suggestSafe = candidates.find((c) => c.url === "https://relay.example.com/api/v1/models");
		expect(suggestSafe).toBeDefined();
		expect(suggestSafe?.suggestBaseUrl).toBe("https://relay.example.com/api/v1");
	});

	test("origin-based candidates never carry suggestBaseUrl", () => {
		const candidates = buildModelsUrls("https://relay.example.com/anthropic");
		const originCandidates = candidates.filter(
			(c) => c.url.startsWith("https://relay.example.com/v1/") || c.url.includes("/api/v1/"),
		);
		expect(originCandidates.length).toBeGreaterThan(0);
		for (const c of originCandidates) {
			// Origin-based model-list URLs may live at a different path than chat,
			// so they must never be suggested as the chat base URL.
			if (c.url === "https://relay.example.com/v1/models") {
				// This one equals ${origin}/v1/models — it is origin-based, not the
				// suggest-safe ${baseUrl}/v1 form (base has an /anthropic segment).
				expect(c.suggestBaseUrl).toBeUndefined();
			}
		}
	});

	test("no suggest-safe candidate when base URL already ends with /v1", () => {
		const candidates = buildModelsUrls("https://api.openai.com/v1");
		expect(candidates[0]).toEqual({ url: "https://api.openai.com/v1/models" });
		expect(candidates.every((c) => c.suggestBaseUrl === undefined)).toBe(true);
	});
});

describe("fetchAnthropicModels error aggregation", () => {
	test("aggregates all candidate errors with the configured URL first", async () => {
		// Configured URL returns a meaningful 401; every fallback candidate 404s.
		// The user must see the 401 (their real, controllable error) first.
		const configuredUrl = "https://relay.example.com/anthropic/models";
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === configuredUrl) {
				return new Response('{"error":"invalid api key"}', {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		let thrown: Error | undefined;
		try {
			await fetchAnthropicModels({
				id: "p1",
				name: "Relay",
				baseUrl: "https://relay.example.com/anthropic",
				apiKey: "sk-test",
			});
		} catch (err) {
			thrown = err as Error;
		}

		expect(thrown).toBeDefined();
		const msg = thrown?.message ?? "";
		// The configured endpoint's real 401 error must be present…
		expect(msg).toContain(configuredUrl);
		expect(msg).toContain("401");
		expect(msg).toContain("invalid api key");
		// …and listed before the fallback 404 noise.
		const idx401 = msg.indexOf("401");
		const idx404 = msg.indexOf("404");
		expect(idx401).toBeGreaterThanOrEqual(0);
		if (idx404 >= 0) expect(idx401).toBeLessThan(idx404);
	});

	test("does not suggest an origin-based resolved base URL", async () => {
		// Configured path (and its strip/append variants) 404; only the host-root
		// `${origin}/v1` succeeds. With a two-segment base path (/api/anthropic),
		// the host-root /v1 is NOT reachable by stripping a single trailing
		// segment, so it is added as an origin-based (suggest:false) candidate.
		// Because the model list may live at the host root while chat stays under
		// the sub-path, this success must NOT be surfaced as a baseUrl correction.
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://relay.example.com/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "claude-3" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		const result = await fetchAnthropicModels({
			id: "p2",
			name: "Relay2",
			baseUrl: "https://relay.example.com/api/anthropic",
			apiKey: "sk-test",
		});
		expect(result.models.map((m) => m.id)).toContain("claude-3");
		// Origin-based success is not a safe baseUrl suggestion.
		expect(result.resolvedBaseUrl).toBeUndefined();
	});
});
