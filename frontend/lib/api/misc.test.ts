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

	test("builds sectioned search requests, leaving defaults out of the URL", async () => {
		installEnvironment(new Response());
		const urls: string[] = [];
		Object.defineProperty(g, "fetch", {
			value: async (input: string) => {
				urls.push(input);
				return Response.json({ sections: {} });
			},
			configurable: true,
		});
		await api.searchSections({ q: "中文" }, ["sessions", "knowledge"]);
		await api.searchSections(
			{
				q: "wider",
				sort: "time",
				include: ["subagents", "tools"],
				projectId: "p1",
				from: "2026-10-01T00:00:00.000Z",
				mine: true,
				fullHistory: true,
				cursor: "abc",
				limit: 20,
			},
			["sessions"],
		);
		expect(urls[0]).toContain("/search?q=%E4%B8%AD%E6%96%87&sections=sessions%2Cknowledge");
		for (const absent of ["sort=", "include=", "projectId=", "mine=", "history=", "cursor="]) {
			expect(urls[0]).not.toContain(absent);
		}
		const second = new URL(urls[1] as string, "http://x").searchParams;
		expect(Object.fromEntries(second)).toEqual({
			q: "wider",
			sort: "time",
			include: "subagents,tools",
			projectId: "p1",
			from: "2026-10-01T00:00:00.000Z",
			mine: "1",
			history: "all",
			cursor: "abc",
			limit: "20",
			sections: "sessions",
		});
	});

	test("requests one session's hits by narrator", async () => {
		installEnvironment(new Response());
		const urls: string[] = [];
		Object.defineProperty(g, "fetch", {
			value: async (input: string) => {
				urls.push(input);
				return Response.json({ hits: [], nextCursor: null });
			},
			configurable: true,
		});
		const response = await api.searchSessionHits("n/1", { q: "kestrel", sort: "time" });
		expect(response).toEqual({ hits: [], nextCursor: null });
		expect(urls[0]).toContain("/search/sessions/n%2F1/hits?q=kestrel&sort=time");
	});

	test("history cleanup API keeps target, exact cutoff and AbortSignal across its four endpoints", async () => {
		installEnvironment(new Response());
		const calls: { path: string; options: RequestInit }[] = [];
		Object.defineProperty(g, "fetch", {
			value: async (path: string, options: RequestInit) => {
				calls.push({ path, options });
				return Response.json({}, { status: path.endsWith("/cleanup") ? 202 : 200 });
			},
			configurable: true,
		});
		const signal = new AbortController().signal;
		const input = { target: "messageHistory" as const, cutoffAt: "2026-02-14T16:00:00.000Z" };
		await api.getStorageHistoryJobs(signal);
		await api.previewStorageHistory(input, signal);
		await api.cleanupStorageHistory(input, signal);
		await api.cancelStorageHistory("messageHistory", signal);
		expect(calls.map(({ path }) => path)).toEqual([
			"/api/storage/database/history/jobs",
			"/api/storage/database/history/preview",
			"/api/storage/database/history/cleanup",
			"/api/storage/database/history/cancel",
		]);
		for (const { options } of calls) expect(options.signal).toBe(signal);
		expect(calls[0].options.body).toBeUndefined();
		for (const index of [1, 2]) {
			expect(calls[index].options.method).toBe("POST");
			expect(JSON.parse(calls[index].options.body as string)).toEqual(input);
		}
		expect(JSON.parse(calls[3].options.body as string)).toEqual({ target: "messageHistory" });
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
			api.cleanupDatabase({ target: "toolCallPayloads", olderThanDays: 7 }),
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
