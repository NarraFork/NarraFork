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

	test("old device, directory, and revision pushes never invalidate a switched workspace", () => {
		client.setQueryData(["gitWorkspace", "n1", 2], {
			...makeWorkspace("wk-new"),
			deviceId: "remote",
			contextKey: "new",
			workspaceRevision: 2,
		});
		const invalidate = spyOn(client, "invalidateQueries");
		for (const scope of [
			{ deviceId: "other", workspaceKey: "wk-new", workspaceRevision: 2 },
			{ deviceId: "remote", workspaceKey: "wk-old", workspaceRevision: 2 },
			{ deviceId: "remote", workspaceKey: "wk-new", contextKey: "old", workspaceRevision: 1 },
		])
			invalidateGitStatusPushQueries(client, "n1", "old-chapter", scope);
		expect(invalidate).not.toHaveBeenCalled();
		invalidateGitStatusPushQueries(client, "n1", null, {
			deviceId: "remote",
			workspaceKey: "wk-new",
			contextKey: "new",
			workspaceRevision: 2,
		});
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys).toContainEqual(["gitStatus", "wk-new"]);
		expect(
			keys.some(
				(key) =>
					key?.[0] === "gitWorkspace" ||
					key?.[0] === "gitCommitDetail" ||
					key?.[0] === "gitCommitDiff",
			),
		).toBe(false);
	});

	test("repository identity filters live facts without reprobing or invalidating immutable previews", () => {
		client.setQueryData(["gitWorkspace", "n1", 2], {
			...makeWorkspace("wk-new"),
			deviceId: "remote",
			workspaceRevision: 2,
			contextKey: "current",
		});
		const invalidate = spyOn(client, "invalidateQueries");
		invalidateGitStatusPushQueries(client, "n1", null, {
			deviceId: "remote",
			workspaceKey: "wk-new",
			repositoryKey: "replaced-repository",
			workspaceRevision: 2,
		});
		expect(invalidate).not.toHaveBeenCalled();
		invalidateGitStatusPushQueries(client, "n1", null, {
			deviceId: "remote",
			workspaceKey: "wk-new",
			repositoryKey: "repo-1",
			workspaceRevision: 2,
		});
		expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toEqual([
			["gitStatus", "wk-new"],
			["gitModifications", "wk-new"],
			["gitDiff", "wk-new"],
			["gitLog", "wk-new"],
			["gitStashList", "wk-new"],
		]);
	});

	test("cached old revisions of the same root do not authorize late pushes", () => {
		client.setQueryData(["gitWorkspace", "n1", 1], {
			...makeWorkspace("same-root"),
			deviceId: "remote",
			contextKey: "old",
			workspaceRevision: 1,
		});
		client.setQueryData(["gitWorkspace", "n1", 2], {
			...makeWorkspace("same-root"),
			deviceId: "remote",
			contextKey: "new",
			workspaceRevision: 2,
		});
		client.setQueryData(["workspaceContext", "n1"], {
			deviceId: "remote",
			contextKey: "new",
			revision: 2,
		});
		const invalidate = spyOn(client, "invalidateQueries");
		invalidateGitStatusPushQueries(client, "n1", null, {
			deviceId: "remote",
			workspaceKey: "same-root",
			contextKey: "old",
			workspaceRevision: 1,
		});
		expect(invalidate).not.toHaveBeenCalled();
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
