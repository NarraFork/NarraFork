/**
 * Guards the flat-order translation behind directory-mode drag and drop.
 *
 * The server only reorders single keys; a directory drag produces a permutation of
 * multi-key units. If `computeRecentTabOrderMoves` emits a sequence whose replay does not
 * converge to the order it promised (`finalTabs`), the sidebar shows the optimistic order
 * for a second and then SNAPS to a different one — the exact failure this function exists
 * to prevent. These tests therefore assert replay-convergence, not just the move list.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import type { RecentTab } from "./recent-tabs-utils";

// Same i18n stub rationale as useRecentTabs.test.ts: useRecentTabs imports the real
// module, and mock.restore() does not undo mock.module process-wide.
const realI18nModule = { ...(await import("../lib/i18n")) };
const testI18n = {
	language: "en",
	resolvedLanguage: "en",
	t: (key: string) => key,
	changeLanguage: async () => testI18n,
};
const testI18nModule = () => ({
	supportedLanguages: ["en", "zh-CN"],
	namespaces: ["common", "narrator"],
	normalizeLanguage: (language: string | null | undefined) => language ?? "en",
	getNamespacesForPath: () => ["common"],
	getInitialNamespaces: () => ["common"],
	ensureI18nNamespaces: async () => {},
	changeAppLanguage: async () => testI18n,
	initI18n: async () => testI18n,
	default: testI18n,
});
mock.module("../lib/i18n", testI18nModule);
mock.module("@frontend/lib/i18n", testI18nModule);

afterAll(() => {
	mock.module("../lib/i18n", () => realI18nModule);
	mock.module("@frontend/lib/i18n", () => realI18nModule);
	mock.restore();
});

const { applyRecentTabMove, computeRecentTabOrderMoves } = await import("./useRecentTabs");

function tab(id: string, overrides: Partial<RecentTab> = {}): RecentTab {
	return {
		type: "narrator",
		id,
		title: `Tab ${id}`,
		lastVisitedAt: 1,
		...overrides,
	} as RecentTab;
}

function keys(tabs: RecentTab[]): string[] {
	return tabs.map((t) => `${t.type}:${t.id}`);
}

/** Replay the emitted moves the way the cache delta path would. */
function replay(tabs: RecentTab[], moves: Array<{ key: string; beforeKey?: string }>): RecentTab[] {
	let work = [...tabs];
	for (const move of moves) {
		if (!move.beforeKey) continue;
		work = applyRecentTabMove(work, move.key, { beforeKey: move.beforeKey });
	}
	return work;
}

describe("computeRecentTabOrderMoves", () => {
	test("is a no-op when the blocks already match the current order", () => {
		const tabs = [tab("a"), tab("b"), tab("c")];
		const { moves, finalTabs } = computeRecentTabOrderMoves(tabs, [
			["narrator:a"],
			["narrator:b"],
			["narrator:c"],
		]);
		expect(moves).toEqual([]);
		expect(keys(finalTabs)).toEqual(["narrator:a", "narrator:b", "narrator:c"]);
	});

	test("moves one tab past a two-member block with a single beforeKey move per displaced member", () => {
		// Visual drag: X drops below the directory group [d1,d2].
		const tabs = [tab("x"), tab("d1"), tab("d2")];
		const blocks = [["narrator:d1", "narrator:d2"], ["narrator:x"]];
		const { moves, finalTabs } = computeRecentTabOrderMoves(tabs, blocks);
		expect(keys(finalTabs)).toEqual(["narrator:d1", "narrator:d2", "narrator:x"]);
		// Convergence: replaying the moves against the ORIGINAL order reaches finalTabs.
		expect(keys(replay(tabs, moves))).toEqual(keys(finalTabs));
		for (const move of moves) expect(move.beforeKey).toBeTruthy();
	});

	test("keeps pinned tabs fixed while movable blocks reorder around them", () => {
		const tabs = [tab("pin", { pinned: true }), tab("a"), tab("b")];
		const blocks = [["narrator:b"], ["narrator:a"]];
		const { moves, finalTabs } = computeRecentTabOrderMoves(tabs, blocks);
		expect(finalTabs[0]?.id).toBe("pin");
		expect(keys(finalTabs)).toEqual(["narrator:pin", "narrator:b", "narrator:a"]);
		expect(keys(replay(tabs, moves))).toEqual(keys(finalTabs));
	});

	test("moves a workspace header with its children glued as one block", () => {
		const tabs = [
			tab("w1", { type: "workspace" }),
			tab("wc1", { workspaceId: "w1" }),
			tab("wc2", { workspaceId: "w1" }),
			tab("x"),
		];
		const blocks = [["narrator:x"], ["workspace:w1", "narrator:wc1", "narrator:wc2"]];
		const { moves, finalTabs } = computeRecentTabOrderMoves(tabs, blocks);
		expect(keys(finalTabs)).toEqual(["narrator:x", "workspace:w1", "narrator:wc1", "narrator:wc2"]);
		// One move: the dragged tab lands before the header, children follow the header
		// via the group semantics.
		expect(moves).toEqual([{ key: "narrator:x", beforeKey: "workspace:w1" }]);
		expect(keys(replay(tabs, moves))).toEqual(keys(finalTabs));
	});

	test("replays to the promised order for a mixed multi-unit drag", () => {
		// dir[a,b] then solo then ws — drag the whole directory group to the bottom.
		const tabs = [
			tab("a", { subtitle: "/w/repo" }),
			tab("solo"),
			tab("w1", { type: "workspace" }),
			tab("wc", { workspaceId: "w1" }),
			tab("b", { subtitle: "/w/repo" }),
		];
		const blocks = [
			["narrator:solo"],
			["workspace:w1", "narrator:wc"],
			["narrator:a", "narrator:b"],
		];
		const { moves, finalTabs } = computeRecentTabOrderMoves(tabs, blocks);
		expect(keys(finalTabs)).toEqual([
			"narrator:solo",
			"workspace:w1",
			"narrator:wc",
			"narrator:a",
			"narrator:b",
		]);
		expect(keys(replay(tabs, moves))).toEqual(keys(finalTabs));
	});

	/**
	 * Reordering WITHIN a directory group must never reach this function: the sidebar routes
	 * that case to the dir-order endpoint instead. This asserts the property that made the
	 * split necessary — expressing an in-group swap as flat moves compresses the group's
	 * members together in the flat order, which moves the GROUP itself (its position is the
	 * position of its first member) even though the user only swapped two rows inside it.
	 */
	test("an in-group swap expressed as flat blocks would move unrelated tabs — hence the split", () => {
		// Flat order interleaves the group's members with an outsider.
		const tabs = [
			tab("d1", { subtitle: "/w/repo" }),
			tab("other"),
			tab("d2", { subtitle: "/w/repo" }),
		];
		// Blocks describe only the in-group swap: [d2,d1] then other.
		const { moves, finalTabs } = computeRecentTabOrderMoves(tabs, [
			["narrator:d2", "narrator:d1"],
			["narrator:other"],
		]);
		expect(moves.length).toBeGreaterThan(0);
		// `other` was dragged nowhere, yet it is no longer between the members.
		expect(keys(finalTabs)).toEqual(["narrator:d2", "narrator:d1", "narrator:other"]);
		expect(keys(replay(tabs, moves))).toEqual(keys(finalTabs));
	});

	test("skips block keys that do not exist in the list instead of emitting junk moves", () => {
		const tabs = [tab("a")];
		const { moves, finalTabs } = computeRecentTabOrderMoves(tabs, [
			["narrator:ghost"],
			["narrator:a"],
		]);
		expect(moves).toEqual([]);
		expect(keys(finalTabs)).toEqual(["narrator:a"]);
	});
});
