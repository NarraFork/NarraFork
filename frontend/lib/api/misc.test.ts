import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./index";

describe("misc APIs", () => {
	const g = globalThis as typeof globalThis & {
		localStorage?: Storage;
		fetch: typeof fetch;
	};
	const originalFetch = g.fetch;
	const originalLocalStorage = g.localStorage;

	afterEach(() => {
		Object.defineProperty(g, "fetch", { value: originalFetch, configurable: true });
		if (originalLocalStorage === undefined) {
			Reflect.deleteProperty(g, "localStorage");
		} else {
			Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
		}
	});

	function installEnvironment(response: Response) {
		Object.defineProperty(g, "localStorage", {
			value: {
				getItem: () => null,
				setItem: () => {},
				removeItem: () => {},
			},
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () => response,
			configurable: true,
		});
	}

	test("sends optional search sort without changing legacy requests", async () => {
		installEnvironment(new Response());
		const urls: string[] = [];
		Object.defineProperty(g, "fetch", {
			value: async (input: string) => {
				urls.push(input);
				return Response.json({ results: [] });
			},
			configurable: true,
		});
		await api.search("中文", "chapters", "time");
		await api.search("ab", "messages", "relevance");
		await api.search("legacy", "chapters");
		expect(urls[0]).toContain("q=%E4%B8%AD%E6%96%87&entities=chapters&sort=time");
		expect(urls[1]).toContain("q=ab&entities=messages&sort=relevance");
		expect(urls[2]).toContain("q=legacy&entities=chapters");
		expect(urls[2]).not.toContain("sort=");
	});

	test("preserves search degraded metadata", async () => {
		installEnvironment(
			new Response(
				JSON.stringify({
					results: [],
					degraded: true,
					fallbacks: [{ entity: "chapters", from: "fts5", to: "like", reason: "fts_query_failed" }],
					searchMetadata: {
						degraded: true,
						mode: "degraded-like-fallback",
						ftsReady: false,
						shortQuery: false,
						requestedEntities: ["chapters"],
						fallbacks: [
							{ entity: "chapters", from: "fts5", to: "like", reason: "fts_query_failed" },
						],
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const response = await api.search("AlphaBeta", "chapters");
		expect(response.degraded).toBe(true);
		expect(response.searchMetadata?.mode).toBe("degraded-like-fallback");
		expect(response.searchMetadata?.fallbacks?.[0]?.reason).toBe("fts_query_failed");
	});

	test("preserves additive backend search metadata and entity arrays", async () => {
		installEnvironment(
			new Response(
				JSON.stringify({
					results: [
						{
							type: "chapter",
							id: "c_search_large_title",
							title: "auroraanchor Chapter North",
							snippet: "auroraanchor ranking fixture",
							matchField: "title",
							matchScore: 999,
						},
					],
					projects: [{ id: "p_search_fixture", name: "Search Fixture Project" }],
					chapters: [{ id: "c_search_large_title", type: "chapter" }],
					narrators: [],
					degraded: false,
					fallbacks: [],
					searchMetadata: {
						degraded: false,
						mode: "fts5-with-like-fallback",
						ftsReady: true,
						shortQuery: false,
						requestedEntities: ["chapters", "messages", "narrators"],
						fallbacks: [],
						backendDiagnostic: "ignored-by-frontend",
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const response = await api.search("auroraanchor", "chapters,messages,narrators");
		expect(response.results).toHaveLength(1);
		expect(response.degraded).toBe(false);
		expect(response.fallbacks).toEqual([]);
		expect(response.searchMetadata?.ftsReady).toBe(true);
		expect(response.searchMetadata?.backendDiagnostic).toBe("ignored-by-frontend");
		expect("projects" in response).toBe(true);
		expect("chapters" in response).toBe(true);
		expect("narrators" in response).toBe(true);
	});

	test("surfaces structured storage cleanup errors", async () => {
		installEnvironment(
			new Response(
				JSON.stringify({
					code: "STORAGE_CLEANUP_WORKTREES_UNSUPPORTED",
					reason: "Storage cleanup does not remove git worktrees on this backend",
				}),
				{
					status: 403,
					statusText: "Forbidden",
					headers: { "content-type": "application/json" },
				},
			),
		);

		await expect(api.cleanupStorage("worktrees")).rejects.toThrow(
			"Storage cleanup does not remove git worktrees on this backend",
		);
	});

	test("surfaces structured runtime cleanup errors", async () => {
		installEnvironment(
			new Response(
				JSON.stringify({
					code: "RUNTIME_CLEANUP_CONTAINERS_UNSUPPORTED",
					reason: "Runtime cleanup is limited to safe semantics on this backend",
				}),
				{
					status: 403,
					statusText: "Forbidden",
					headers: { "content-type": "application/json" },
				},
			),
		);

		await expect(api.cleanupRuntime("containers")).rejects.toThrow(
			"Runtime cleanup is limited to safe semantics on this backend",
		);
	});

	test("surfaces structured database cleanup errors", async () => {
		installEnvironment(
			new Response(
				JSON.stringify({
					code: "STORAGE_DATABASE_CLEANUP_DISABLED",
					reason: "Database vacuum is disabled on this backend",
				}),
				{
					status: 403,
					statusText: "Forbidden",
					headers: { "content-type": "application/json" },
				},
			),
		);

		await expect(
			api.cleanupDatabase({ target: "apiRequestDumps", olderThanDays: 7 }),
		).rejects.toThrow("Database vacuum is disabled on this backend");
	});

	test("surfaces structured notification webhook errors", async () => {
		for (const tc of [
			{
				provider: "dingtalk",
				code: "NOTIFICATION_DINGTALK_WEBHOOK_FAILED",
				call: () => api.testDingtalkWebhook("https://example.test/dingtalk"),
			},
			{
				provider: "feishu",
				code: "NOTIFICATION_FEISHU_WEBHOOK_FAILED",
				call: () => api.testFeishuWebhook("https://example.test/feishu"),
			},
		]) {
			const diagnostic = `${tc.provider} upstream returned 500`;
			installEnvironment(
				new Response(
					JSON.stringify({
						ok: false,
						code: tc.code,
						reason: diagnostic,
						error: diagnostic,
						message: diagnostic,
					}),
					{
						status: 502,
						statusText: "Bad Gateway",
						headers: { "content-type": "application/json" },
					},
				),
			);

			await expect(tc.call()).rejects.toThrow(diagnostic);
		}
	});
});
