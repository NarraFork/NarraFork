import { describe, expect, test } from "bun:test";
import type {
	BackgroundTaskListDelta,
	BackgroundTaskListItem,
	BackgroundTaskListPage,
} from "@shared/background-task-list";
import {
	applyBackgroundTaskDelta,
	flattenBackgroundTaskList,
	toBackgroundTaskListState,
} from "./background-task-list-state";

const EPOCH = "epoch-a";

function item(id: string, overrides: Partial<BackgroundTaskListItem> = {}): BackgroundTaskListItem {
	return {
		id,
		type: "bash",
		status: "running",
		effectiveStatus: "running",
		currentNarratorStatus: null,
		activeChildTaskCount: 0,
		canCancelActiveWork: true,
		command: `cmd-${id}`,
		exitCode: null,
		toolUseId: null,
		subagentNarratorId: null,
		subagentType: null,
		alias: null,
		title: null,
		output: null,
		outputBytes: 0,
		outputTruncated: false,
		outputPreviewTruncated: false,
		startedAt: `2026-01-01T00:00:0${id.length}Z`,
		completedAt: null,
		createdAt: `2026-01-01T00:00:00.00${id}Z`,
		legacy: false,
		...overrides,
	};
}

function page(
	tasks: BackgroundTaskListItem[],
	overrides: Partial<BackgroundTaskListPage> = {},
): BackgroundTaskListPage {
	return {
		listEpoch: EPOCH,
		version: 1,
		activeCount: tasks.filter((t) => t.effectiveStatus === "running").length,
		activeTasks: tasks.filter((t) => t.effectiveStatus === "running"),
		activeTruncated: false,
		tasks,
		nextCursor: null,
		...overrides,
	};
}

function delta(overrides: Partial<BackgroundTaskListDelta> = {}): BackgroundTaskListDelta {
	return { listEpoch: EPOCH, version: 2, activeCount: 1, ...overrides };
}

describe("applyBackgroundTaskDelta", () => {
	// A restart mints a new epoch, and versions from two processes are not
	// comparable. Applying such a frame would silently mix two servers' views.
	test("refetches when the server epoch differs", () => {
		const state = toBackgroundTaskListState([page([item("1")])]);
		const outcome = applyBackgroundTaskDelta(state, delta({ listEpoch: "epoch-b" }));
		expect(outcome).toEqual({ kind: "refetch", reason: "epoch" });
	});

	test("refetches when the server says the change is not expressible incrementally", () => {
		const state = toBackgroundTaskListState([page([item("1")])]);
		const outcome = applyBackgroundTaskDelta(state, delta({ invalidate: true, version: 2 }));
		expect(outcome).toEqual({ kind: "refetch", reason: "invalidate" });
	});

	// The whole point of the version: a lost frame must be DETECTED, not absorbed.
	// Absorbing it would leave the list permanently missing a change, and every
	// later delta would then also look like a gap — with no user-visible signal.
	test("refetches on a version gap rather than applying a frame out of sequence", () => {
		const state = toBackgroundTaskListState([page([item("1")])]);
		const outcome = applyBackgroundTaskDelta(state, delta({ version: 4 }));
		expect(outcome).toEqual({ kind: "refetch", reason: "gap" });
	});

	test("ignores an exact duplicate of the frame already applied", () => {
		const state = toBackgroundTaskListState([page([item("1")], { version: 5 })]);
		expect(applyBackgroundTaskDelta(state, delta({ version: 5 }))).toEqual({
			kind: "ignored",
			reason: "stale-version",
		});
	});

	// The server's per-parent version lives in a bounded LRU: once a parent is
	// evicted its next frame restarts at 1. Dismissing a lower version as a
	// duplicate would drop that frame AND every frame after it — the panel would
	// freeze permanently with no signal, which is the one failure mode this whole
	// versioning scheme exists to avoid.
	test("refetches when the server's version went backwards (evicted counter)", () => {
		const state = toBackgroundTaskListState([page([item("1")], { version: 5 })]);
		for (const version of [4, 1]) {
			expect(applyBackgroundTaskDelta(state, delta({ version }))).toEqual({
				kind: "refetch",
				reason: "version-reset",
			});
		}
	});

	test("applies a status change in place and advances the version", () => {
		const running = item("1");
		const state = toBackgroundTaskListState([page([running], { version: 7 })]);
		const finished = item("1", {
			status: "completed",
			effectiveStatus: "completed",
			canCancelActiveWork: false,
			output: "done",
		});
		const outcome = applyBackgroundTaskDelta(
			state,
			delta({ version: 8, activeCount: 0, upsert: finished }),
		);
		expect(outcome.kind).toBe("applied");
		if (outcome.kind !== "applied") return;
		expect(outcome.state.version).toBe(8);
		expect(outcome.state.activeCount).toBe(0);
		// The row left the active set, and the page copy now reflects the new status.
		expect(outcome.state.activeTasks).toHaveLength(0);
		expect(outcome.state.pages[0]?.tasks[0]?.effectiveStatus).toBe("completed");
		// Page 0 carries the coordinate, so a cache round-trip cannot regress it.
		expect(outcome.state.pages[0]?.version).toBe(8);
		expect(outcome.state.pages[0]?.activeCount).toBe(0);
	});

	// With polling gone, a created task that produced no delta would simply never
	// appear until something else happened to refresh the list.
	test("inserts a task the client has never seen", () => {
		const state = toBackgroundTaskListState([page([item("1")], { version: 3 })]);
		const created = item("2", { createdAt: "2026-01-01T00:00:09.000Z" });
		const outcome = applyBackgroundTaskDelta(
			state,
			delta({ version: 4, activeCount: 2, upsert: created }),
		);
		expect(outcome.kind).toBe("applied");
		if (outcome.kind !== "applied") return;
		expect(outcome.state.pages[0]?.tasks.map((t) => t.id)).toContain("2");
		expect(outcome.state.activeTasks.map((t) => t.id)).toContain("2");
		// Newest first: the later createdAt sorts ahead.
		expect(outcome.state.pages[0]?.tasks[0]?.id).toBe("2");
	});

	// A row older than the loaded window must NOT be appended to page 0: doing so
	// would place it before rows the client has not fetched yet, i.e. out of order.
	test("does not append an out-of-window older task to a partially loaded page", () => {
		const state = toBackgroundTaskListState([
			page([item("5"), item("4")], { version: 2, nextCursor: "cursor-1" }),
		]);
		const older = item("0", { createdAt: "2025-01-01T00:00:00.000Z" });
		const outcome = applyBackgroundTaskDelta(
			state,
			delta({ version: 3, activeCount: 1, upsert: older }),
		);
		expect(outcome.kind).toBe("applied");
		if (outcome.kind !== "applied") return;
		expect(outcome.state.pages[0]?.tasks.map((t) => t.id)).toEqual(["5", "4"]);
	});

	test("appends an older task when the loaded window reaches the end of the list", () => {
		const state = toBackgroundTaskListState([page([item("5")], { version: 2, nextCursor: null })]);
		const older = item("0", { createdAt: "2025-01-01T00:00:00.000Z" });
		const outcome = applyBackgroundTaskDelta(
			state,
			delta({ version: 3, activeCount: 2, upsert: older }),
		);
		expect(outcome.kind).toBe("applied");
		if (outcome.kind !== "applied") return;
		expect(outcome.state.pages[0]?.tasks.map((t) => t.id)).toEqual(["5", "0"]);
	});

	// A reaped row whose removal the client never hears about stays on screen with
	// cancel/output actions that now 404.
	test("removes reaped rows from every loaded page and from the active set", () => {
		const state = toBackgroundTaskListState([
			page([item("3"), item("2")], { version: 1, nextCursor: "c" }),
			page([item("1")], { version: 1 }),
		]);
		const outcome = applyBackgroundTaskDelta(
			state,
			delta({ version: 2, activeCount: 1, removeIds: ["2", "1"] }),
		);
		expect(outcome.kind).toBe("applied");
		if (outcome.kind !== "applied") return;
		expect(flattenBackgroundTaskList(outcome.state).map((t) => t.id)).toEqual(["3"]);
		expect(outcome.state.activeTasks.map((t) => t.id)).toEqual(["3"]);
	});

	test("refetches when there is no cached state to patch", () => {
		expect(applyBackgroundTaskDelta(null, delta())).toEqual({ kind: "refetch", reason: "gap" });
	});
});

describe("flattenBackgroundTaskList", () => {
	// The active set is a separate unpaged read, so a row can appear in both. The
	// active copy is the fresher one and must win, or a task that just started
	// running would render with its stale terminal badge.
	test("prefers the active copy of a row that also appears in a page", () => {
		const stale = item("1", { effectiveStatus: "completed", canCancelActiveWork: false });
		const fresh = item("1", { effectiveStatus: "continued", canCancelActiveWork: true });
		const state = toBackgroundTaskListState([
			page([stale], { activeTasks: [fresh], activeCount: 1 }),
		]);
		const flat = flattenBackgroundTaskList(state);
		expect(flat).toHaveLength(1);
		expect(flat[0]?.effectiveStatus).toBe("continued");
	});

	test("de-duplicates across pages and sorts newest first", () => {
		const state = toBackgroundTaskListState([
			page([item("3"), item("2")], { activeTasks: [], activeCount: 0, nextCursor: "c" }),
			page([item("2"), item("1")], { activeTasks: [], activeCount: 0 }),
		]);
		expect(flattenBackgroundTaskList(state).map((t) => t.id)).toEqual(["3", "2", "1"]);
	});
});
