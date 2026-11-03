/**
 * The project board's queries (outline P2 PR 5; review round 1 S5): one query per page of spaces,
 * so window focus and the half-minute timer re-read the first page only, never the pages loaded
 * with "More sessions"; a person's own change re-reads every loaded page once.
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
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	spyOn(api, "getProjectTaskBoard").mockImplementation(async (_projectId, cursor) => {
		reads.push(cursor);
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
