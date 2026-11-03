/**
 * The project board's queries (outline P2 PR 5; review round 1 S5): one query per page of spaces,
 * so window focus and the half-minute timer re-read the first page only, never the pages loaded
 * with "More sessions"; a person's own change re-reads every loaded page once. When a refresh
 * moves where a page ends, the pages after it are read again from its new end (review round 2
 * S1): no session shows twice or goes missing.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: false,
});
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: { addListener: () => ({}), removeListener: () => {} },
}));
const { QueryClient, QueryClientProvider, focusManager } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../lib/api");
const { PROJECT_BOARD_REFRESH_MS, invalidateTaskBoards, useProjectTaskBoard } = await import(
	"./useTaskBoard"
);

let root: Root;
let client: InstanceType<typeof QueryClient>;
const reads: Array<string | null> = [];
/** The sessions the project has now, two a page (the cursor is the last id of a page). */
let sessions: string[] | null = null;
let board: ReturnType<typeof useProjectTaskBoard> | undefined;

function Harness() {
	board = useProjectTaskBoard("p1");
	return null;
}

async function flush() {
	for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
	reads.length = 0;
	sessions = null;
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	spyOn(api, "getProjectTaskBoard").mockImplementation(async (_projectId, cursor) => {
		reads.push(cursor);
		if (sessions) {
			const ids = sessions.filter((id) => cursor === null || id > cursor).slice(0, 2);
			const more = sessions.some((id) => id > (ids.at(-1) ?? ""));
			return {
				scope: { kind: "project", projectId: "p1" },
				sections: ids.map((id) => ({ space: { id } }) as never),
				canAdd: false,
				nextCursor: more ? (ids.at(-1) ?? null) : null,
				me: { userId: "u1", name: "u1" },
			};
		}
		return {
			scope: { kind: "project", projectId: "p1" },
			sections: [],
			canAdd: false,
			nextCursor: cursor === null ? "c1" : cursor === "c1" ? "c2" : null,
			me: { userId: "u1", name: "u1" },
		};
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	root.render(
		<QueryClientProvider client={client}>
			<Harness />
		</QueryClientProvider>,
	);
	await flush();
});

afterEach(async () => {
	root.unmount();
	client.clear();
	mock.restore();
	await flush();
});

test("pages load on demand; only the first refreshes on its own", async () => {
	expect(reads).toEqual([null]);
	expect(board?.hasNextPage).toBe(true);
	board?.fetchNextPage();
	await flush();
	board?.fetchNextPage();
	await flush();
	expect(reads).toEqual([null, "c1", "c2"]);
	expect(board?.pages).toHaveLength(3);
	expect(board?.hasNextPage).toBe(false);

	// What each page's query refreshes on.
	const options = client
		.getQueryCache()
		.findAll({ queryKey: ["task-board", "project", "p1"] })
		.map((query) => {
			const observer = query.observers[0]?.options;
			return [query.queryKey[3], observer?.refetchInterval, observer?.refetchOnWindowFocus];
		});
	expect(options).toEqual([
		["", PROJECT_BOARD_REFRESH_MS, true],
		["c1", false, false],
		["c2", false, false],
	]);

	// The window gains focus once the first page is stale: the first page only.
	await client
		.getQueryCache()
		.find({ queryKey: ["task-board", "project", "p1", ""] })
		?.invalidate();
	focusManager.setFocused(false);
	focusManager.setFocused(true);
	await flush();
	expect(reads.filter((cursor) => cursor === "c1" || cursor === "c2")).toEqual(["c1", "c2"]);
	focusManager.setFocused(undefined);

	// A person's own change: every loaded page once.
	reads.length = 0;
	invalidateTaskBoards(client);
	await flush();
	expect([...reads].sort()).toEqual(["c1", "c2", null].sort());
});

test("a refresh that moves where the first page ends re-reads the pages after it", async () => {
	sessions = ["s1", "s2", "s3", "s4"];
	await client.resetQueries();
	await flush();
	board?.fetchNextPage();
	await flush();
	const shown = () =>
		(board?.pages ?? []).flatMap((page) =>
			page.sections.map((section) => (section as { space: { id: string } }).space.id),
		);
	expect(shown()).toEqual(["s1", "s2", "s3", "s4"]);
	const refreshFirst = async () => {
		await client
			.getQueryCache()
			.find({ queryKey: ["task-board", "project", "p1", ""] })
			?.fetch();
		await flush();
	};
	// s2 is archived: the first page now ends at s3 (review round 2 probe: s3 showed twice).
	sessions = ["s1", "s3", "s4"];
	await refreshFirst();
	expect(shown()).toEqual(["s1", "s3", "s4"]);
	// A new session lands inside the first page: its old last session moves to the next page.
	sessions = ["s1", "s10", "s3", "s4"].sort();
	await refreshFirst();
	expect(shown()).toEqual(["s1", "s10", "s3", "s4"]);
	expect(board?.hasNextPage).toBe(false);
});
