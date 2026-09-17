import { afterEach, describe, expect, test } from "bun:test";
import { clearToken, setToken } from "./client";
import { type GitTarget, gitTargetKey } from "./git";
import { api } from "./index";

describe("git APIs", () => {
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

	function installLocalStorage(): Map<string, string> {
		const store = new Map<string, string>();
		Object.defineProperty(g, "localStorage", {
			value: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => {
					store.set(key, value);
				},
				removeItem: (key: string) => store.delete(key),
			},
			configurable: true,
		});
		return store;
	}

	test("narrator routes preserve all suffixes and pin every write to the observed workspace", async () => {
		installLocalStorage();
		setToken("git-token");
		const calls: Array<{ url: string; body?: string; signal?: AbortSignal | null }> = [];
		Object.defineProperty(g, "fetch", {
			configurable: true,
			value: async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					url: String(input),
					body: typeof init?.body === "string" ? init.body : undefined,
					signal: init?.signal,
				});
				return Response.json({});
			},
		});
		const target: GitTarget = {
			narratorId: "independent",
			workspaceKey: "device-a:/repo",
			repositoryKey: "device-a:/repo/.git",
			canWrite: true,
		};
		const controller = new AbortController();
		await api.getGitWorkspace("independent", controller.signal);
		await api.getGitStatus(target, controller.signal);
		await api.getGitModifications(
			target,
			{ scope: "uncommitted", projection: "byFile" },
			controller.signal,
		);
		await api.getGitDiff(target, "sub/file one.ts", true, controller.signal);
		await api.getGitLog(target, 50, 50, controller.signal);
		await api.getGitStashList(target, controller.signal);
		await api.gitStage(target, { all: true });
		await api.gitUnstage(target, { files: ["file"] });
		await api.gitCommit(target, "message");
		await api.gitDiscard(target, { files: ["file"] });
		await api.gitStash(target, { action: "push" });
		await api.gitStash(target, { action: "pop", index: 0 });
		await api.gitStash(target, { action: "drop", index: 0 });
		await api.gitReset(target, "HEAD", "soft");
		await api.gitAiCommitMessage(target);
		expect(calls.every((call) => call.url.startsWith("/api/narrators/independent/git/"))).toBe(
			true,
		);
		controller.abort();
		expect(calls.slice(0, 6).every((call) => call.signal?.aborted)).toBe(true);
		expect(
			calls
				.slice(1, 6)
				.every(
					(call) =>
						new URL(call.url, "http://localhost").searchParams.get("workspaceKey") ===
						"device-a:/repo",
				),
		).toBe(true);
		expect(
			calls
				.slice(6)
				.every((call) => JSON.parse(call.body ?? "{}").workspaceKey === "device-a:/repo"),
		).toBe(true);
		expect(gitTargetKey({ ...target, narratorId: "another" })).toBe(gitTargetKey(target));
		expect(gitTargetKey({ ...target, workspaceKey: "device-b:/repo" })).not.toBe(
			gitTargetKey(target),
		);
		expect(() => api.gitStage({ ...target, canWrite: false }, { all: true })).toThrow("read-only");
		clearToken();
	});

	test("a stale workspace conflict is surfaced without replaying the write", async () => {
		installLocalStorage();
		let calls = 0;
		Object.defineProperty(g, "fetch", {
			configurable: true,
			value: async () => {
				calls++;
				return Response.json({ error: "Workspace changed" }, { status: 409 });
			},
		});
		await expect(
			api.gitCommit({ narratorId: "n", workspaceKey: "old", canWrite: true }, "message"),
		).rejects.toMatchObject({ status: 409 });
		expect(calls).toBe(1);
	});

	test("routes all git panel API calls without throwing", async () => {
		installLocalStorage();
		setToken("git-token");
		const calls: Array<{ url: string; method: string; body?: string; authorization?: string }> = [];
		const summary = {
			hasChanges: true,
			staged: 1,
			unstaged: 1,
			untracked: 1,
			files: [
				{
					status: " M",
					path: "src/file one.txt",
					linesAdded: 2,
					linesRemoved: 1,
					stagedLinesAdded: 0,
					stagedLinesRemoved: 0,
					unstagedLinesAdded: 2,
					unstagedLinesRemoved: 1,
				},
			],
			totalFiles: 1,
			headSha: "abcdef123456",
			branch: "main",
			linesAdded: 2,
			linesRemoved: 1,
		};

		Object.defineProperty(g, "fetch", {
			value: async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				calls.push({
					url,
					method: init?.method ?? "GET",
					body: typeof init?.body === "string" ? init.body : undefined,
					authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
				});
				let payload: unknown = summary;
				if (url.includes("/git/diff")) {
					payload = { diff: "diff --git a/src/file one.txt b/src/file one.txt", truncated: false };
				} else if (url.endsWith("/git/stash/list")) {
					payload = [{ index: 0, message: "stash change", date: "2026-06-09T00:00:00Z" }];
				} else if (url.endsWith("/git/stash")) {
					payload = { hasConflicts: false, status: summary };
				} else if (url.includes("/git/log")) {
					payload = [
						{
							sha: "abcdef123456",
							shortSha: "abcdef1",
							message: "base",
							author: "Test User",
							date: "2026-06-09T00:00:00Z",
						},
					];
				} else if (url.endsWith("/git/ai-commit-message")) {
					payload = { message: "fix: update file" };
				} else if (url.endsWith("/git/commit")) {
					payload = { commitSha: "abcdef123456", status: summary };
				}
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			configurable: true,
		});

		const chapterId = "chapter-1";
		expect((await api.getGitStatus(chapterId)).hasChanges).toBe(true);
		expect((await api.gitStage(chapterId, { all: true })).staged).toBe(1);
		expect((await api.gitUnstage(chapterId, { files: ["src/file one.txt"] })).unstaged).toBe(1);
		expect((await api.gitCommit(chapterId, "fix: update file")).commitSha).toBe("abcdef123456");
		expect((await api.gitDiscard(chapterId, { files: ["src/file one.txt"] })).totalFiles).toBe(1);
		expect((await api.getGitDiff(chapterId, "src/file one.txt", true)).truncated).toBe(false);
		expect((await api.getGitStashList(chapterId))[0]?.message).toBe("stash change");
		expect((await api.gitStash(chapterId, { action: "apply", index: 0 })).hasConflicts).toBe(false);
		expect((await api.getGitLog(chapterId, 5, 1))[0]?.shortSha).toBe("abcdef1");
		expect((await api.gitReset(chapterId, "HEAD~1", "soft")).branch).toBe("main");
		expect((await api.gitAiCommitMessage(chapterId)).message).toBe("fix: update file");

		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			"GET /api/chapters/chapter-1/git/status",
			"POST /api/chapters/chapter-1/git/stage",
			"POST /api/chapters/chapter-1/git/unstage",
			"POST /api/chapters/chapter-1/git/commit",
			"POST /api/chapters/chapter-1/git/discard",
			"GET /api/chapters/chapter-1/git/diff?file=src%2Ffile%20one.txt&staged=true",
			"GET /api/chapters/chapter-1/git/stash/list",
			"POST /api/chapters/chapter-1/git/stash",
			"GET /api/chapters/chapter-1/git/log?limit=5&skip=1",
			"POST /api/chapters/chapter-1/git/reset",
			"POST /api/chapters/chapter-1/git/ai-commit-message",
		]);
		expect(calls.every((call) => call.authorization === "Bearer git-token")).toBe(true);
		expect(calls.find((call) => call.url.endsWith("/git/reset"))?.body).toBe(
			JSON.stringify({ target: "HEAD~1", mode: "soft" }),
		);
		clearToken();
	});
});
