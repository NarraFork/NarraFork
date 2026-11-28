import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
	userAgentMode?: "custom" | "narrafork" | "codex" | "claude-code";
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
}) => Promise<{ models: Array<{ id: string }>; resolvedBaseUrl?: string }>;
type FetchOpenaiModels = (config: {
	id: string;
	name: string;
	baseUrl?: string;
	apiKey?: string;
	apiMode?: string;
	userAgentMode?: "custom" | "narrafork" | "codex" | "claude-code";
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
	dynamicHeaders?: () => Record<string, string>;
}) => Promise<{ models: Array<{ id: string }> }>;

let buildModelsUrls: BuildModelsUrls;
let fetchAnthropicModels: FetchAnthropicModels;
let fetchOpenaiModels: FetchOpenaiModels;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
	// Reuse the isolated home owned by tests/preload.ts. Creating a second DB
	// here duplicates migrations and leaves its Windows watcher handles outside
	// the standard test teardown.
	if (process.env.NARRAFORK_TEST !== "1" || !process.env.NARRAFORK_HOME) {
		throw new Error("Model catalog tests require the isolated tests/preload.ts environment");
	}

	const openaiMod = await import("../openai");
	buildModelsUrls = openaiMod.buildModelsUrls as unknown as BuildModelsUrls;
	fetchOpenaiModels = openaiMod.fetchOpenaiModels as unknown as FetchOpenaiModels;
	const anthropicMod = await import("../anthropic");
	fetchAnthropicModels = anthropicMod.fetchAnthropicModels as unknown as FetchAnthropicModels;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
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

describe("fetchOpenaiModels OpenCode session headers", () => {
	test("adds a process-stable session header to the OpenCode model request", async () => {
		let captured = new Headers();
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			captured = new Headers(init?.headers);
			return new Response(JSON.stringify({ data: [{ id: "glm-5.3" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await fetchOpenaiModels({
			id: "opencode-default",
			name: "OpenCode",
			baseUrl: "https://opencode.ai/zen/go/v1",
			apiKey: "sk-test",
		});

		expect(captured.get("authorization")).toBe("Bearer sk-test");
		expect(captured.get("x-opencode-session")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	test("sends an operator-provided session override exactly once", async () => {
		let captured = new Headers();
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			captured = new Headers(init?.headers);
			return new Response(JSON.stringify({ data: [{ id: "glm-5.3" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await fetchOpenaiModels({
			id: "opencode-override",
			name: "OpenCode",
			baseUrl: "https://opencode.ai/zen/go/v1",
			apiKey: "sk-test",
			extraHeaders: { "X-OpenCode-Session": "ses_operator" },
		});

		expect(captured.get("x-opencode-session")).toBe("ses_operator");
		expect(
			[...captured.keys()].filter((key) => key.toLowerCase() === "x-opencode-session"),
		).toHaveLength(1);
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

describe("model catalog identity reaches a real HTTP endpoint", () => {
	for (const protocol of ["anthropic", "responses", "completions"] as const) {
		test(`${protocol} applies UA selection and case-insensitive explicit overrides`, async () => {
			globalThis.fetch = originalFetch;
			const captured: Headers[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					captured.push(request.headers);
					return Response.json({ data: [{ id: "test-model" }] });
				},
			});
			try {
				const config = {
					id: `catalog-${protocol}`,
					name: "Catalog probe",
					apiKey: "default-key",
					baseUrl: `${server.url.origin}/v1`,
					userAgentMode: "custom" as const,
					customUserAgent: "selected/1",
					apiMode: protocol === "responses" ? "codex" : "completions",
					officialApi: true,
				};
				const fetchModels = protocol === "anthropic" ? fetchAnthropicModels : fetchOpenaiModels;
				await fetchModels(config);
				await fetchModels({
					...config,
					extraHeaders: {
						"USER-AGENT": "override/2",
						authorization: "Bearer operator",
						Originator: "custom-originator",
						"Anthropic-Version": "operator-version",
					},
				});
				expect(captured).toHaveLength(2);
				expect(captured[0]?.get("user-agent")).toBe("selected/1");
				expect(captured[1]?.get("user-agent")).toBe("override/2");
				expect(captured[1]?.get("authorization")).toBe("Bearer operator");
				expect(captured[1]?.get("originator")).toBe("custom-originator");
				expect(captured[1]?.get("anthropic-version")).toBe("operator-version");
			} finally {
				await server.stop(true);
			}
		});
	}
});

describe("model catalog dynamic UA respects explicit selection", () => {
	for (const apiMode of ["responses", "codex", "completions"]) {
		test(`${apiMode}: only explicit UA overrides dynamic headers`, async () => {
			globalThis.fetch = originalFetch;
			const captured: Headers[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					captured.push(request.headers);
					return Response.json({ data: [{ id: "test-model" }] });
				},
			});
			try {
				let channel = 0;
				const config = {
					id: "catalog-ua",
					name: "Catalog UA probe",
					apiKey: "default-key",
					baseUrl: `${server.url.origin}/v1`,
					apiMode,
					userAgentMode: "custom" as const,
					customUserAgent: "selected/1",
					extraHeaders: { authorization: "Bearer static" },
					dynamicHeaders: () => ({
						"USER-AGENT": "dynamic/3",
						Authorization: "Bearer dynamic",
						"X-Channel": `live-${++channel}`,
					}),
				};
				await fetchOpenaiModels(config);
				await fetchOpenaiModels({
					...config,
					extraHeaders: { "uSeR-aGeNt": " operator/2 ", authorization: "Bearer static" },
				});
				await fetchOpenaiModels({
					...config,
					userAgentMode: undefined,
					customUserAgent: undefined,
				});
				expect(captured.map((headers) => headers.get("user-agent"))).toEqual([
					"selected/1",
					"operator/2",
					"dynamic/3",
				]);
				expect(captured.map((headers) => headers.get("authorization"))).toEqual([
					"Bearer dynamic",
					"Bearer dynamic",
					"Bearer dynamic",
				]);
				expect(captured.map((headers) => headers.get("x-channel"))).toEqual([
					"live-1",
					"live-2",
					"live-3",
				]);
			} finally {
				await server.stop(true);
			}
		});
	}
});

describe("model catalog fallback keeps its final wire identity", () => {
	for (const protocol of ["anthropic", "responses", "codex", "completions"] as const) {
		test(`${protocol}: configured 404 then /v1 discovery retains one UA and the authentication owner`, async () => {
			globalThis.fetch = originalFetch;
			const requests: Array<{ path: string; method: string; headers: Headers; raw: string }> = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					requests.push({
						path: new URL(request.url).pathname,
						method: request.method,
						headers: request.headers,
						raw: await request.text(),
					});
					if (requests.length === 1)
						return Response.json({ error: { message: "Use /v1/models" } }, { status: 404 });
					return Response.json({ data: [{ id: "wire-model" }] });
				},
			});
			try {
				const config = {
					id: `catalog-fallback-${protocol}`,
					name: "Local catalog fallback",
					apiKey: "fake-catalog-key",
					baseUrl: server.url.origin,
					apiMode: protocol === "anthropic" ? "responses" : protocol,
					officialApi: true,
					userAgentMode: "custom" as const,
					customUserAgent: "selected/1",
					extraHeaders: { "uSeR-aGeNt": " operator/2 ", Authorization: "Bearer operator" },
					dynamicHeaders: () => ({
						"USER-AGENT": "dynamic/default",
						authorization: "Bearer dynamic-owner",
						"X-Channel": "current",
					}),
				};
				const result = await (protocol === "anthropic"
					? fetchAnthropicModels(config)
					: fetchOpenaiModels(config));
				expect(result.models.map((model) => model.id)).toEqual(["wire-model"]);
				expect(requests.map((request) => request.path)).toEqual(["/models", "/v1/models"]);
				for (const request of requests) {
					expect(request.method).toBe("GET");
					expect(request.raw).toBe("");
					expect(request.headers.get("user-agent")).toBe("operator/2");
					expect(
						Array.from(request.headers.keys()).filter((key) => key === "user-agent"),
					).toHaveLength(1);
					expect(request.headers.get("authorization")).toBe(
						protocol === "anthropic" ? "Bearer operator" : "Bearer dynamic-owner",
					);
					if (protocol !== "anthropic") expect(request.headers.get("x-channel")).toBe("current");
				}
			} finally {
				await server.stop(true);
			}
		});
	}
});
