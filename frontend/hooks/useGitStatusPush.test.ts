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
const { invalidateGitStatusPushQueries, invalidateWorkspaceQueries, GIT_LIVE_FACT_QUERIES } =
	await import("./useGit");

let client: InstanceType<typeof QueryClient>;

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

function makeWorkspace(workspaceKey: string) {
	return {
		state: "ready",
		workspaceKey,
		repositoryKey: "repo-1",
		capabilities: { read: true, write: true },
	};
}

describe("ordinary Git refresh preserves ownership snapshots", () => {
	test.each([
		true,
		false,
	])("manual=%s refresh never broadly invalidates ChangeLists facts", (manual) => {
		client.setQueryData(["gitWorkspace", "n1", 0], makeWorkspace("wk-1"));
		client.setQueryData(["gitDiff", "wk-1"], { diff: "native" });
		const keys = [
			["gitStagingLists", "wk-1", "n1", "alice"],
			["gitStagingFiles", "wk-1", "A", "n1", "alice", "v1"],
			["gitStagingDiff", "wk-1", "A", "n1", "alice", "v1"],
		];
		for (const key of keys) client.setQueryData(key, { snapshot: "retained" });
		invalidateWorkspaceQueries(
			client,
			{ narratorId: "n1", workspaceKey: "wk-1", repositoryKey: "repo-1", canWrite: true },
			manual,
		);
		for (const key of keys) {
			expect(client.getQueryState(key)?.isInvalidated).toBe(false);
			expect(client.getQueryData(key)).toEqual({ snapshot: "retained" });
		}
		expect(client.getQueryState(["gitDiff", "wk-1"])?.isInvalidated).toBe(true);
	});
	test("legacy generic live facts do not take ownership invalidation away from its observation stream", () => {
		expect(GIT_LIVE_FACT_QUERIES.some((prefix) => prefix.startsWith("gitStaging"))).toBe(false);
	});
});

describe("invalidateGitStatusPushQueries", () => {
	test("invalidates only header facts for the narrator's workspace key", () => {
		client.setQueryData(["gitWorkspace", "n1", 0], makeWorkspace("wk-1"));
		const invalidate = spyOn(client, "invalidateQueries");
		invalidateGitStatusPushQueries(client, "n1");
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys).toEqual([
			["gitStatus", "wk-1"],
			["gitLineStats", "wk-1"],
		]);
	});

	test("100 header pushes preserve page, diff, history, stash and changelist caches", () => {
		client.setQueryData(["gitWorkspace", "n1", 0], makeWorkspace("wk-1"));
		const prefixes = [
			"gitStatusPages",
			"gitStatusPageStats",
			"gitModifications",
			"gitDiff",
			"gitLog",
			"gitStashList",
			"gitStagingLists",
			"gitStagingFiles",
		];
		for (const prefix of prefixes) client.setQueryData([prefix, "wk-1"], { snapshotId: "stable" });
		for (let index = 0; index < 100; index++) invalidateGitStatusPushQueries(client, "n1");
		for (const prefix of prefixes) {
			expect(client.getQueryState([prefix, "wk-1"])?.isInvalidated).toBe(false);
			expect(client.getQueryData([prefix, "wk-1"])).toEqual({ snapshotId: "stable" });
		}
	});

	test("a push invalidates the workspace bar query", () => {
		client.setQueryData(["gitWorkspace", "n1", 0], makeWorkspace("wk-1"));
		const invalidate = spyOn(client, "invalidateQueries");
		invalidateGitStatusPushQueries(client, "n1");
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys).toContainEqual(["gitStatus", "wk-1"]);
		expect(keys.some((key) => key?.[1] === undefined || key?.[1] === null)).toBe(false);
	});

	test("without a cached workspace there is nothing to invalidate", () => {
		const invalidate = spyOn(client, "invalidateQueries");
		invalidateGitStatusPushQueries(client, "n1");
		expect(invalidate).not.toHaveBeenCalled();
	});

	test("never re-probes the workspace itself on a push", () => {
		client.setQueryData(["gitWorkspace", "n1", 0], makeWorkspace("wk-1"));
		const invalidate = spyOn(client, "invalidateQueries");
		invalidateGitStatusPushQueries(client, "n1");
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey?.[0]);
		expect(keys).not.toContain("gitWorkspace");
		expect(keys).not.toContain("gitCommitDetail");
	});

	test("other narrators' workspaces stay untouched", () => {
		client.setQueryData(["gitWorkspace", "n1", 0], makeWorkspace("wk-1"));
		client.setQueryData(["gitWorkspace", "n2", 0], makeWorkspace("wk-2"));
		const invalidate = spyOn(client, "invalidateQueries");
		invalidateGitStatusPushQueries(client, "n1");
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys.some((key) => key?.[1] === "wk-2")).toBe(false);
	});
});
