import { afterEach, describe, expect, test } from "bun:test";
import { clearToken, setToken } from "./client";
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
