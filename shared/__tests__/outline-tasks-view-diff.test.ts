/**
 * What changed between two injections of the current-tasks view (`outline-tasks-view-diff.ts`):
 * the comparison of two state tables, and the changes a row stores once the server has read the
 * few tasks only their blocks can speak for.
 *
 * Pure: no database, no DOM.
 */
import { describe, expect, test } from "bun:test";
import {
	boundOutlineTasksViewStates,
	coerceOutlineTasksViewDisplay,
	OUTLINE_TASKS_VIEW_DISPLAY_LIMITS,
	type OutlineTasksViewDisplay,
	type OutlineTasksViewState,
} from "../outline-task-notice";
import {
	diffOutlineTasksViews,
	type OutlineTasksViewFact,
	outlineTasksViewDeltasToRead,
	settleOutlineTasksViewChanges,
} from "../outline-tasks-view-diff";

type States = Partial<Record<OutlineTasksViewState, string[]>>;

/** A view listing the titled tasks (`address: title`) under the states of `states`. */
function view(
	states: States,
	titles: Record<string, string> = {},
	extra: Partial<OutlineTasksViewDisplay> = {},
): OutlineTasksViewDisplay {
	const listed = (state: OutlineTasksViewState) =>
		(states[state] ?? [])
			.filter((address) => titles[address] !== undefined)
			.map((address) => ({ address, title: titles[address] as string }));
	return {
		doing: listed("doing"),
		waiting: listed("waiting"),
		next: listed("todo").slice(0, 1),
		...(listed("delegated").length > 0 ? { delegated: listed("delegated") } : {}),
		counts: {
			doing: states.doing?.length ?? 0,
			waiting: states.waiting?.length ?? 0,
			todo: states.todo?.length ?? 0,
		},
		states,
		...extra,
	};
}

const kinds = (previous: OutlineTasksViewDisplay | null, next: OutlineTasksViewDisplay | null) =>
	(diffOutlineTasksViews(previous, next) ?? []).map((d) => `${d.address}:${d.kind}`);

describe("diffOutlineTasksViews", () => {
	test("nothing to compare with: a view without a state table (an old row) on either side", () => {
		const old = { ...view({ doing: ["s/a"] }), states: undefined };
		expect(diffOutlineTasksViews(old, view({ doing: ["s/a"] }))).toBeNull();
		expect(diffOutlineTasksViews(view({ doing: ["s/a"] }), old)).toBeNull();
		// A removed view is a known, empty list: comparable on both sides.
		expect(diffOutlineTasksViews(null, null)).toEqual([]);
	});

	test("every transition between the four states has its kind", () => {
		const cases: Array<[OutlineTasksViewState, OutlineTasksViewState, string]> = [
			["todo", "doing", "started"],
			["waiting", "doing", "started"],
			["delegated", "doing", "returned"],
			["doing", "todo", "requeued"],
			["waiting", "todo", "unblocked"],
			["delegated", "todo", "returned"],
			["doing", "waiting", "waiting"],
			["todo", "waiting", "waiting"],
			["delegated", "waiting", "waiting"],
			["doing", "delegated", "delegated"],
			["todo", "delegated", "delegated"],
			["waiting", "delegated", "delegated"],
		];
		for (const [from, to, kind] of cases) {
			expect(diffOutlineTasksViews(view({ [from]: ["s/a"] }), view({ [to]: ["s/a"] }))).toEqual([
				{ address: "s/a", kind: kind as never, from },
			]);
		}
	});

	test("a task not listed before: added as a to-do or waiting, started or delegated otherwise", () => {
		const before = view({ doing: ["s/keep"] });
		expect(
			kinds(
				before,
				view({ doing: ["s/keep", "s/d"], delegated: ["s/g"], waiting: ["s/w"], todo: ["s/t"] }),
			),
		).toEqual(["s/d:started", "s/g:delegated", "s/w:added", "s/t:added"]);
		// From an empty list (the view had been removed): the same.
		expect(kinds(null, view({ doing: ["s/d"], todo: ["s/t"] }))).toEqual([
			"s/d:started",
			"s/t:added",
		]);
	});

	test("a task that left the list is gone, with where it was and its title when listed", () => {
		const before = view({ doing: ["s/a"], todo: ["s/b", "s/c"] }, { "s/a": "Add tests" });
		expect(diffOutlineTasksViews(before, view({ todo: ["s/c"] }))).toEqual([
			{ address: "s/a", kind: "gone", from: "doing", title: "Add tests", sure: true },
			{ address: "s/b", kind: "gone", from: "todo", sure: true },
		]);
		// The view went away altogether.
		expect(kinds(before, null)).toEqual(["s/a:gone", "s/b:gone", "s/c:gone"]);
	});

	test("the same states in another order are no change (a moved task is the same task)", () => {
		const before = view({ doing: ["s/a", "s/b"], todo: ["s/c", "s/d"] });
		const after = view({ doing: ["s/b", "s/a"], todo: ["s/d", "s/c"] });
		expect(diffOutlineTasksViews(before, after)).toEqual([]);
		expect(diffOutlineTasksViews(before, before)).toEqual([]);
	});

	test("a new title on a task both views list is a rename, never a removal and an addition", () => {
		const before = view({ doing: ["s/a"], todo: ["s/b"] }, { "s/a": "Fix it", "s/b": "Ship" });
		const after = view({ doing: ["s/a"], todo: ["s/b"] }, { "s/a": "Fix the race", "s/b": "Ship" });
		expect(diffOutlineTasksViews(before, after)).toEqual([
			{ address: "s/a", kind: "renamed", from: "doing", title: "Fix the race" },
		]);
		// With a state change too, the state change is the news; the row carries the new title.
		const started = view({ doing: ["s/a", "s/b"] }, { "s/a": "Fix it", "s/b": "Ship it now" });
		expect(diffOutlineTasksViews(before, started)).toEqual([
			{ address: "s/b", kind: "started", from: "todo", title: "Ship it now" },
		]);
		// A task only one of the views titled cannot be said to be renamed.
		const untitled = view({ doing: ["s/a"], todo: ["s/b"] }, { "s/b": "Ship" });
		expect(diffOutlineTasksViews(before, untitled)).toEqual([]);
	});

	test("a cut PREVIOUS table: a to-do missing from it is not reported as added", () => {
		const before = view({ doing: ["s/a"], todo: ["s/b"] }, {}, { statesMore: true });
		const after = view({ doing: ["s/a", "s/x"], waiting: ["s/w"], todo: ["s/b", "s/new"] });
		// Past the cut there were only to-dos: one in progress now did start, one waiting does wait.
		expect(kinds(before, after)).toEqual(["s/x:started", "s/w:waiting"]);
	});

	test("a cut NEXT table: a task missing from it is gone only if its block says so", () => {
		const before = view({ doing: ["s/a"], todo: ["s/b"] });
		const after = view({ doing: ["s/c"] }, {}, { statesMore: true });
		expect(diffOutlineTasksViews(before, after)).toEqual([
			{ address: "s/c", kind: "started" },
			{ address: "s/a", kind: "gone", from: "doing", sure: false },
			{ address: "s/b", kind: "gone", from: "todo", sure: false },
		]);
	});
});

describe("settleOutlineTasksViewChanges", () => {
	const facts = (entries: Record<string, OutlineTasksViewFact>) => new Map(Object.entries(entries));

	test("what left the list is done, cancelled or removed as its block says", () => {
		const deltas = diffOutlineTasksViews(
			view({ doing: ["s/a", "s/b"], todo: ["s/c", "s/d"] }),
			view({ doing: ["s/e"] }, { "s/e": "Fix the race" }),
		);
		const settled = settleOutlineTasksViewChanges(
			deltas ?? [],
			facts({
				"s/a": { fate: "done", title: "Add tests" },
				"s/b": { fate: "cancelled", title: "Old idea" },
				"s/c": { fate: "removed", title: "Typo" },
				"s/d": { fate: "open", title: "Someone else's now" },
			}),
		);
		// The most telling first: finished, started, cancelled, then the rest.
		expect(settled).toEqual({
			changes: [
				{ address: "s/a", kind: "done", from: "doing", title: "Add tests" },
				{ address: "s/e", kind: "started", title: "Fix the race" },
				{ address: "s/b", kind: "cancelled", from: "doing", title: "Old idea" },
				{ address: "s/c", kind: "removed", from: "todo", title: "Typo" },
				{ address: "s/d", kind: "unlisted", from: "todo", title: "Someone else's now" },
			],
			changed: 5,
		});
	});

	test("more changes than a row names: the first five named, all counted", () => {
		const addresses = Array.from({ length: 9 }, (_, i) => `s/t${i}`);
		const titles = Object.fromEntries(addresses.map((a) => [a, `Task ${a}`]));
		const deltas = diffOutlineTasksViews(
			view({ todo: addresses }),
			view({ doing: addresses }, titles),
		);
		const settled = settleOutlineTasksViewChanges(deltas ?? []);
		expect(settled.changed).toBe(9);
		expect(settled.changes.map((c) => c.address)).toEqual(addresses.slice(0, 5));
		expect(settled.changes).toHaveLength(OUTLINE_TASKS_VIEW_DISPLAY_LIMITS.changes);
	});

	test("a change nobody titled is counted, never named by its address", () => {
		const deltas = diffOutlineTasksViews(view({ todo: ["s/a"] }), view({ todo: ["s/a", "s/b"] }));
		expect(settleOutlineTasksViewChanges(deltas ?? [])).toEqual({ changes: [], changed: 1 });
		// Its block read gives it a name.
		expect(
			settleOutlineTasksViewChanges(deltas ?? [], facts({ "s/b": { fate: "open", title: "New" } })),
		).toEqual({ changes: [{ address: "s/b", kind: "added", title: "New" }], changed: 1 });
	});

	test("a cut next table never reports a task as gone on absence alone", () => {
		const before = view({ doing: ["s/a"], todo: ["s/b", "s/c", "s/d"] }, { "s/a": "Add tests" });
		const after = view({ doing: ["s/x"] }, { "s/x": "X" }, { statesMore: true });
		const deltas = diffOutlineTasksViews(before, after) ?? [];
		// Nothing read: only the task that is on the new list changed.
		expect(settleOutlineTasksViewChanges(deltas)).toEqual({
			changes: [{ address: "s/x", kind: "started", title: "X" }],
			changed: 1,
		});
		// Read: the finished one is finished; the one still open is simply past the cut.
		const settled = settleOutlineTasksViewChanges(
			deltas,
			facts({ "s/a": { fate: "done", title: "Add tests" }, "s/b": { fate: "open", title: "B" } }),
		);
		expect(settled.changes.map((c) => `${c.address}:${c.kind}`)).toEqual([
			"s/a:done",
			"s/x:started",
		]);
		expect(settled.changed).toBe(2);
		// With a whole table the unread ones did leave the list.
		const whole = diffOutlineTasksViews(before, view({ doing: ["s/x"] }, { "s/x": "X" })) ?? [];
		expect(settleOutlineTasksViewChanges(whole).changed).toBe(5);
	});

	test("the blocks worth reading: what left the list first, then the untitled, five at most", () => {
		const before = view({ doing: ["s/a"], todo: ["s/b"] }, { "s/a": "A" });
		const after = view({ doing: ["s/c", "s/d"], todo: ["s/e"] }, { "s/c": "C" });
		const deltas = diffOutlineTasksViews(before, after) ?? [];
		// s/c is titled by the view; s/d and s/e are not; s/a and s/b left.
		expect(outlineTasksViewDeltasToRead(deltas)).toEqual(["s/a", "s/b", "s/d", "s/e"]);
		expect(outlineTasksViewDeltasToRead(deltas, 3)).toEqual(["s/a", "s/b", "s/d"]);
		const many = diffOutlineTasksViews(
			view({ todo: Array.from({ length: 40 }, (_, i) => `s/g${i}`) }),
			null,
		);
		expect(outlineTasksViewDeltasToRead(many ?? [])).toHaveLength(5);
	});
});

describe("the state table's bounds", () => {
	test("at most sixty addresses, the to-dos cut first; a cut table says so", () => {
		const list = (prefix: string, n: number) =>
			Array.from({ length: n }, (_, i) => `s/${prefix}${i}`);
		const bounded = boundOutlineTasksViewStates({
			doing: list("d", 30),
			delegated: list("g", 20),
			waiting: list("w", 5),
			todo: list("t", 30),
		});
		expect(bounded.cut).toBe(true);
		expect(bounded.states.doing).toHaveLength(30);
		expect(bounded.states.delegated).toHaveLength(20);
		expect(bounded.states.waiting).toHaveLength(5);
		expect(bounded.states.todo).toEqual(list("t", 5));
		const whole = boundOutlineTasksViewStates({ doing: list("d", 30), todo: list("t", 30) });
		expect(whole.cut).toBe(false);
		expect(Object.values(whole.states).flat()).toHaveLength(
			OUTLINE_TASKS_VIEW_DISPLAY_LIMITS.states,
		);
	});

	test("an address is kept once (its first state), junk is dropped", () => {
		const bounded = boundOutlineTasksViewStates({
			doing: ["s/a", "s/a", 7, "", "x".repeat(81)],
			todo: ["s/a", "s/b"],
			elsewhere: ["s/z"],
		});
		expect(bounded).toEqual({ states: { doing: ["s/a"], todo: ["s/b"] }, cut: false });
	});

	test("a stored display reads back bounded; the cut is remembered and never under-reported", () => {
		const raw = {
			doing: [],
			waiting: [],
			next: [],
			counts: { doing: 0, waiting: 0, todo: 70 },
			states: { todo: Array.from({ length: 70 }, (_, i) => `s/t${i}`) },
			changes: [
				{ address: "s/a", title: "Add tests", kind: "done", from: "doing" },
				{ address: "s/b", title: "B", kind: "exploded" },
				{ address: "s/c", title: "C", kind: "started", from: "nowhere" },
				...Array.from({ length: 9 }, (_, i) => ({ address: `s/x${i}`, title: "X", kind: "added" })),
			],
			changed: 2,
		};
		const read = coerceOutlineTasksViewDisplay(raw);
		expect(read?.states?.todo).toHaveLength(60);
		expect(read?.statesMore).toBe(true);
		// Five entries read, the unknown kind dropped, the unknown `from` dropped.
		expect(read?.changes).toEqual([
			{ address: "s/a", title: "Add tests", kind: "done", from: "doing" },
			{ address: "s/c", title: "C", kind: "started" },
			{ address: "s/x0", title: "X", kind: "added" },
			{ address: "s/x1", title: "X", kind: "added" },
		]);
		// The count is never below what is named.
		expect(read?.changed).toBe(4);
		// A row written before tables and changes existed has neither.
		const old = coerceOutlineTasksViewDisplay({ doing: [], counts: {} });
		expect(old && "states" in old).toBe(false);
		expect(old && "changes" in old).toBe(false);
		expect(old && "changed" in old).toBe(false);
	});
});
