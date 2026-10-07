import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";

// useGit.ts's import chain touches browser globals at module load; install a
// minimal DOM first so the pure invalidation helper can be imported directly.
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
});

mock.module("./useNarrator", () => ({ useNarrator: () => ({ data: undefined }) }));
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		addListener: () => ({}),
		removeListener: () => {},
		onConnectionChange: () => () => {},
	},
}));

const { QueryClient } = await import("@tanstack/react-query");
const { invalidateGitStatusPushQueries } = await import("./useGit");

let client: InstanceType<typeof QueryClient>;

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

function makeWorkspace(workspaceKey: string, chapterId?: string) {
	return {
		state: "ready",
		workspaceKey,
		repositoryKey: "repo-1",
		chapterId: chapterId ?? null,
		capabilities: { read: true, write: true },
	};
}

describe("invalidateGitStatusPushQueries", () => {
	test("invalidates the live facts for the narrator's workspace and chapter keys", () => {
		client.setQueryData(["gitWorkspace", "n1", 0], makeWorkspace("wk-1", "c1"));
		const invalidate = spyOn(client, "invalidateQueries");
		invalidateGitStatusPushQueries(client, "n1", "c1");
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		for (const prefix of ["gitStatus", "gitModifications", "gitDiff", "gitLog", "gitStashList"]) {
			expect(keys).toContainEqual([prefix, "wk-1"]);
			expect(keys).toContainEqual([prefix, "c1"]);
		}
	});

	test("a chapter-less push still invalidates the workspace bar query", () => {
		client.setQueryData(["gitWorkspace", "n1", 0], makeWorkspace("wk-1"));
		const invalidate = spyOn(client, "invalidateQueries");
		invalidateGitStatusPushQueries(client, "n1", null);
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys).toContainEqual(["gitStatus", "wk-1"]);
		expect(keys.some((key) => key?.[1] === undefined || key?.[1] === null)).toBe(false);
	});

	test("without a cached workspace or chapter there is nothing to invalidate", () => {
		const invalidate = spyOn(client, "invalidateQueries");
		invalidateGitStatusPushQueries(client, "n1", null);
		expect(invalidate).not.toHaveBeenCalled();
	});

	test("never re-probes the workspace itself on a push", () => {
		client.setQueryData(["gitWorkspace", "n1", 0], makeWorkspace("wk-1", "c1"));
		const invalidate = spyOn(client, "invalidateQueries");
		invalidateGitStatusPushQueries(client, "n1", "c1");
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey?.[0]);
		expect(keys).not.toContain("gitWorkspace");
		expect(keys).not.toContain("gitCommitDetail");
	});

	test("other narrators' workspaces stay untouched", () => {
		client.setQueryData(["gitWorkspace", "n1", 0], makeWorkspace("wk-1"));
		client.setQueryData(["gitWorkspace", "n2", 0], makeWorkspace("wk-2"));
		const invalidate = spyOn(client, "invalidateQueries");
		invalidateGitStatusPushQueries(client, "n1", null);
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys.some((key) => key?.[1] === "wk-2")).toBe(false);
	});
});
