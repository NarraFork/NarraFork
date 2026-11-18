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

	test.each([
		"https://github.com/anthropics/skills/tree/main/skills/frontend-design",
		"https://gitee.com/owner/repo/raw/main/SKILL.md",
		"https://gitlab.com/owner/repo/-/raw/main/SKILL.md",
		"http://example.com/SKILL.md",
	])("creates a skill from %s in the selected scope with POST JSON and AbortSignal", async (url) => {
		installEnvironment(new Response());
		const calls: { path: string; options: RequestInit }[] = [];
		const skill = {
			name: "frontend-design",
			description: "Design skills",
			location: ".narrafork/skills/frontend-design",
			content: "# Design",
			files: ["SKILL.md", "scripts/build.ts", "assets/example.png"],
		};
		Object.defineProperty(g, "fetch", {
			value: async (path: string, options: RequestInit) => {
				calls.push({ path, options });
				return Response.json(skill, { status: 201 });
			},
			configurable: true,
		});
		const signal = new AbortController().signal;
		const data = { url };
		expect(await api.importProjectSkill("project/中文 ?", data, signal)).toEqual(skill);
		expect(await api.importGlobalSkill(data, signal)).toEqual(skill);
		expect(calls.map(({ path }) => path)).toEqual([
			"/api/skills/import?projectId=project%2F%E4%B8%AD%E6%96%87%20%3F",
			"/api/skills/global/import",
		]);
		for (const { options } of calls) {
			expect(options.method).toBe("POST");
			expect(options.signal).toBe(signal);
			expect(JSON.parse(options.body as string)).toEqual(data);
			expect(new Headers(options.headers).get("Content-Type")).toBe("application/json");
		}
	});

	test("preserves import validation, authorization, conflict and timeout errors", async () => {
		for (const status of [400, 403, 409, 504]) {
			for (const scope of ["project", "global"]) {
				const message = `Import failed with ${status}`;
				installEnvironment(Response.json({ error: message }, { status }));
				const data = { url: "https://github.com/owner/repo/tree/main/skill" };
				const request =
					scope === "project" ? api.importProjectSkill("p1", data) : api.importGlobalSkill(data);
				await expect(request).rejects.toMatchObject({ status, message });
			}
		}
	});

	test("forwards import cancellation to transport without retrying", async () => {
		installEnvironment(new Response());
		const controller = new AbortController();
		let calls = 0;
		Object.defineProperty(g, "fetch", {
			value: (_path: string, options: RequestInit) => {
				calls++;
				return new Promise<Response>((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
						once: true,
					});
				});
			},
			configurable: true,
		});
		const request = api.importGlobalSkill(
			{ url: "https://github.com/o/r/tree/main" },
			controller.signal,
		);
		controller.abort();
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(1);
	});

	test.each([
		"https://gitee.com/owner/repo/raw/main/SKILL.md",
		"https://gitlab.com/owner/repo/-/raw/main/SKILL.md",
		"http://example.com/skill.md",
		"https://github.com/owner/repo/tree/main/skill",
	])("updates the encoded skill and scope from %s with only URL JSON and signal", async (url) => {
		installEnvironment(new Response());
		const calls: { path: string; options: RequestInit }[] = [];
		const result = {
			name: "skill/中文 ?",
			description: "Example",
			location: ".narrafork/skills/example",
			content: "# Example",
			files: ["SKILL.md"],
			disabled: true,
			canUpdateFromUrl: true,
		};
		Object.defineProperty(g, "fetch", {
			value: async (path: string, options: RequestInit) => {
				calls.push({ path, options });
				return Response.json(result);
			},
			configurable: true,
		});
		const signal = new AbortController().signal;
		const data = { url };
		expect(
			await api.updateProjectSkillFromUrl("project/中文 ?", result.name, data, signal),
		).toEqual(result);
		expect(await api.updateGlobalSkillFromUrl(result.name, data, signal)).toEqual(result);
		expect(calls.map(({ path }) => path)).toEqual([
			"/api/skills/skill%2F%E4%B8%AD%E6%96%87%20%3F/update-from-url?projectId=project%2F%E4%B8%AD%E6%96%87%20%3F",
			"/api/skills/global/skill%2F%E4%B8%AD%E6%96%87%20%3F/update-from-url",
		]);
		for (const { options } of calls) {
			expect(options.method).toBe("POST");
			expect(options.signal).toBe(signal);
			expect(JSON.parse(options.body as string)).toEqual(data);
			expect(new Headers(options.headers).get("Content-Type")).toBe("application/json");
		}
	});

	test("preserves URL update validation, permission, missing-skill, conflict and timeout errors", async () => {
		for (const status of [400, 403, 404, 409, 504]) {
			for (const scope of ["project", "global"]) {
				const message = `Update failed with ${status}`;
				installEnvironment(Response.json({ error: message }, { status }));
				const data = { url: "https://example.com/SKILL.md" };
				const request =
					scope === "project"
						? api.updateProjectSkillFromUrl("p1", "example", data)
						: api.updateGlobalSkillFromUrl("example", data);
				await expect(request).rejects.toMatchObject({ status, message });
			}
		}
	});

	test.each([
		"project",
		"global",
	])("cancels %s URL update transport without retrying", async (scope) => {
		installEnvironment(new Response());
		const controller = new AbortController();
		let calls = 0;
		Object.defineProperty(g, "fetch", {
			value: (_path: string, options: RequestInit) => {
				calls++;
				return new Promise<Response>((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
						once: true,
					});
				});
			},
			configurable: true,
		});
		const data = { url: "https://example.com/SKILL.md" };
		const request =
			scope === "project"
				? api.updateProjectSkillFromUrl("p1", "example", data, controller.signal)
				: api.updateGlobalSkillFromUrl("example", data, controller.signal);
		controller.abort();
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(1);
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
