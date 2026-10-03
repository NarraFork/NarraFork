import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	cancelDrag,
	endDrag,
	getPanelDrag,
	isNarratorSubject,
	isSyntheticSubjectId,
	moveDrag,
	onPanelDragEnd,
	onPanelDragMove,
	type PanelDragState,
	startDetachedPanelDrag,
	startDragManual,
	startPanelDrag,
} from "./panel-drag";

/**
 * Regression coverage for isSyntheticSubjectId.
 *
 * Bug it guards (found via the dock drag visualization): dragging a tool panel
 * (spec/git/terminal/…) inside the dock emits a synthetic subject id like
 * "__spec__". The narrator page's drag-to-split drop zone must ignore these, or
 * it wrongly lights the "create workspace" overlay and, on release, builds a
 * bogus workspace leaf referencing a non-existent narrator id.
 */
describe("isSyntheticSubjectId", () => {
	test("recognizes the tool-panel synthetic markers", () => {
		for (const id of [
			"__spec__",
			"__git__",
			"__terminal__",
			"__filemod__",
			"__details__",
			"__browser__",
			"__webview__",
		]) {
			expect(isSyntheticSubjectId(id)).toBe(true);
		}
	});

	test("treats real narrator ids as NOT synthetic", () => {
		// nanoid-style ids never start/end with the double-underscore fence.
		for (const id of ["MDxNbNyf9Ni04Fj-hSZek", "abc123", "narr_1", "n-__weird-but-real"]) {
			expect(isSyntheticSubjectId(id)).toBe(false);
		}
	});

	test("edge cases: partial or empty fences are not synthetic", () => {
		expect(isSyntheticSubjectId("")).toBe(false);
		expect(isSyntheticSubjectId("__")).toBe(false); // length < 4
		expect(isSyntheticSubjectId("__x")).toBe(false); // no trailing fence
		expect(isSyntheticSubjectId("x__")).toBe(false); // no leading fence
		expect(isSyntheticSubjectId("spec__")).toBe(false);
		expect(isSyntheticSubjectId("__spec")).toBe(false);
	});

	test("minimal valid fence '____' is synthetic (length 4)", () => {
		expect(isSyntheticSubjectId("____")).toBe(true);
	});
});

/**
 * Coverage for the explicit subject classification (`subjectKind`) that
 * supersedes id-shape parsing. Consumers gate workspace creation / narrator
 * materialisation on `isNarratorSubject`.
 */
describe("isNarratorSubject", () => {
	const state = (over: Partial<PanelDragState>): PanelDragState => ({
		id: "narr_1",
		title: "T",
		x: 0,
		y: 0,
		...over,
	});

	test("explicit subjectKind wins over id shape", () => {
		// A real-looking id explicitly marked as a tool is NOT a narrator.
		expect(isNarratorSubject(state({ id: "narr_1", subjectKind: "tool" }))).toBe(false);
		// A synthetic-looking id explicitly marked narrator IS a narrator.
		expect(isNarratorSubject(state({ id: "__weird__", subjectKind: "narrator" }))).toBe(true);
	});

	test("falls back to id-shape inference when subjectKind is absent", () => {
		expect(isNarratorSubject(state({ id: "narr_1" }))).toBe(true);
		expect(isNarratorSubject(state({ id: "__spec__" }))).toBe(false);
	});
});

describe("manual drag completion", () => {
	const ends: Array<PanelDragState | null> = [];
	let offEnd: () => void;

	beforeEach(() => {
		ends.length = 0;
		offEnd = onPanelDragEnd((state) => {
			expect(getPanelDrag()).toBeNull();
			ends.push(state);
		});
	});

	afterEach(() => {
		offEnd();
		cancelDrag();
	});

	test("cancellation sends null rather than committing the final state", () => {
		startDragManual("narr_1", "T", 10, 20);
		moveDrag(30, 40);
		cancelDrag();
		expect(ends).toEqual([null]);
		expect(getPanelDrag()).toBeNull();
		moveDrag(50, 60);
		expect(getPanelDrag()).toBeNull();
	});

	test("normal completion still returns and emits the final state", () => {
		startDragManual("narr_1", "T", 10, 20);
		moveDrag(30, 40);
		const final = endDrag();
		expect(final).toEqual({ id: "narr_1", title: "T", x: 30, y: 40 });
		expect(ends).toEqual([final]);
		expect(getPanelDrag()).toBeNull();
	});

	test("repeated cancellation is safe and a subsequent drag still commits", () => {
		cancelDrag();
		expect(ends).toEqual([]);
		startDragManual("narr_1", "T", 10, 20);
		cancelDrag();
		cancelDrag();
		expect(ends).toEqual([null]);
		startDragManual("narr_2", "Next", 50, 60);
		const final = endDrag();
		expect(final).toEqual({ id: "narr_2", title: "Next", x: 50, y: 60 });
		expect(ends).toEqual([null, final]);
	});
});

describe("startPanelDrag subject classification", () => {
	// Reuse the document stub pattern from the threshold suite.
	type Handler = (e: unknown) => void;
	let handlers: Map<string, Set<Handler>>;
	// biome-ignore lint/suspicious/noExplicitAny: swapping the global document stub
	let prevDocument: any;
	const dispatch = (type: string, clientX: number, clientY: number) => {
		for (const h of handlers.get(type) ?? []) h({ clientX, clientY });
	};
	beforeEach(() => {
		handlers = new Map();
		// biome-ignore lint/suspicious/noExplicitAny: reading the global for restore
		prevDocument = (globalThis as any).document;
		// biome-ignore lint/suspicious/noExplicitAny: minimal document stub
		(globalThis as any).document = {
			body: { style: {} as Record<string, string> },
			addEventListener: (type: string, fn: Handler) => {
				if (!handlers.has(type)) handlers.set(type, new Set());
				handlers.get(type)?.add(fn);
			},
			removeEventListener: (type: string, fn: Handler) => {
				handlers.get(type)?.delete(fn);
			},
		};
	});
	afterEach(() => {
		// biome-ignore lint/suspicious/noExplicitAny: restore global
		(globalThis as any).document = prevDocument;
	});

	test("immediate release uses pointerup coordinates, not the last hover", () => {
		const ends: Array<PanelDragState | null> = [];
		const offEnd = onPanelDragEnd((state) => ends.push(state));
		try {
			startPanelDrag({ panelId: "p1", id: "narr_1", title: "T", x: 0, y: 0 });
			dispatch("pointermove", 40, 20);
			dispatch("pointerup", 900, 700);
			expect(ends).toHaveLength(1);
			expect(ends[0]).toMatchObject({ panelId: "p1", x: 900, y: 700 });
			expect(getPanelDrag()).toBeNull();
		} finally {
			offEnd();
			cancelDrag();
		}
	});

	test("pointercancel clears a live drag without committing its hover", () => {
		const ends: Array<PanelDragState | null> = [];
		const offEnd = onPanelDragEnd((state) => ends.push(state));
		try {
			startPanelDrag({ panelId: "p1", id: "narr_1", title: "T", x: 0, y: 0 });
			dispatch("pointermove", 40, 20);
			dispatch("pointercancel", 40, 20);
			dispatch("pointerup", 40, 20);
			expect(ends).toEqual([null]);
			expect(getPanelDrag()).toBeNull();
			expect(document.body.style.cursor).toBe("");
			expect(document.body.style.userSelect).toBe("");
		} finally {
			offEnd();
			cancelDrag();
		}
	});

	test("explicit subjectKind=tool is carried into the drag state", () => {
		let final: PanelDragState | null = null;
		const offEnd = onPanelDragEnd((s) => {
			final = s;
		});
		startPanelDrag({
			panelId: "__spec__",
			id: "__spec__",
			title: "Spec",
			x: 0,
			y: 0,
			subjectKind: "tool",
		});
		dispatch("pointermove", 40, 0); // cross threshold
		dispatch("pointerup", 40, 0);
		expect(final).not.toBeNull();
		expect(final).toMatchObject({ subjectKind: "tool" });
		if (final) expect(isNarratorSubject(final)).toBe(false);
		offEnd();
	});

	test("omitted subjectKind is inferred from id shape (narrator id → narrator)", () => {
		let final: PanelDragState | null = null;
		const offEnd = onPanelDragEnd((s) => {
			final = s;
		});
		startPanelDrag({ panelId: "p1", id: "narr_1", title: "T", x: 0, y: 0 });
		dispatch("pointermove", 40, 0);
		dispatch("pointerup", 40, 0);
		expect(final).toMatchObject({ subjectKind: "narrator" });
		offEnd();
	});

	test("surfaceId / toolKind / resourceId are carried through", () => {
		let final: PanelDragState | null = null;
		const offEnd = onPanelDragEnd((s) => {
			final = s;
		});
		startPanelDrag({
			panelId: "ndock-file",
			id: "__file__",
			title: "a.ts",
			subjectKind: "tool",
			surfaceId: "chap_1",
			toolKind: "file",
			resourceId: "/repo/a.ts",
			x: 0,
			y: 0,
		});
		dispatch("pointermove", 40, 0);
		dispatch("pointerup", 40, 0);
		expect(final).toMatchObject({
			surfaceId: "chap_1",
			toolKind: "file",
			resourceId: "/repo/a.ts",
		});
		offEnd();
	});

	/**
	 * A detached canvas panel dragged back into a dock.
	 *
	 * It must arrive WITHOUT a panelId: `useDockviewDnd` routes any drag carrying
	 * one to `dropExistingPanel` (an in-surface rearrangement), so a detached panel
	 * with a panelId would be mistaken for a same-kind panel already in the target
	 * dock and the merge would silently do nothing.
	 */
	test("startDetachedPanelDrag carries no panelId and no surfaceId", () => {
		let final: PanelDragState | null = null;
		const offEnd = onPanelDragEnd((s) => {
			final = s;
		});
		startDetachedPanelDrag({
			id: "detached_1",
			title: "Terminal",
			toolKind: "terminal",
			x: 0,
			y: 0,
		});
		dispatch("pointermove", 40, 0);
		dispatch("pointerup", 40, 0);
		expect(final).not.toBeNull();
		expect(final).toMatchObject({
			id: "detached_1",
			toolKind: "terminal",
			subjectKind: "tool",
		});
		// The absence of these two is the whole point: a panelId would route the drag
		// back into `dropExistingPanel` and the merge would silently do nothing.
		expect(final).not.toHaveProperty("panelId");
		expect(final).not.toHaveProperty("surfaceId");
		offEnd();
	});

	test("a detached panel is not mistaken for a narrator subject", () => {
		// Guards the consumers that only act on real narrators: the narrator page's
		// create-workspace drop zone and the workspace's narrator materialisation
		// both gate on isNarratorSubject. A detached panel id is a plain nanoid
		// (not a `__marker__`), so only the explicit subjectKind keeps them out.
		let final: PanelDragState | null = null;
		const offEnd = onPanelDragEnd((s) => {
			final = s;
		});
		startDetachedPanelDrag({
			id: "MDxNbNyf9Ni04Fj-hSZek",
			title: "Browser",
			toolKind: "browser",
			x: 0,
			y: 0,
		});
		dispatch("pointermove", 40, 0);
		dispatch("pointerup", 40, 0);
		expect(final).not.toBeNull();
		if (final) expect(isNarratorSubject(final)).toBe(false);
		offEnd();
	});
});

/**
 * Regression coverage for the drag ACTIVATION THRESHOLD.
 *
 * Bug it guards: pointerdown on a draggable header used to activate a drag
 * immediately, swallowing the subsequent click — so a panel's close button
 * became unclickable. A drag must only become "live" after the pointer travels
 * past a small threshold; a release below it is a plain click (no drag-end).
 *
 * The panel-drag singleton reads a global `document`; we install a tiny stub so
 * the real listeners run without a full DOM.
 */
describe("drag activation threshold", () => {
	type Handler = (e: unknown) => void;
	let handlers: Map<string, Set<Handler>>;
	// biome-ignore lint/suspicious/noExplicitAny: swapping the global document stub
	let prevDocument: any;

	const dispatch = (type: string, clientX: number, clientY: number) => {
		for (const h of handlers.get(type) ?? []) h({ clientX, clientY });
	};

	beforeEach(() => {
		handlers = new Map();
		// biome-ignore lint/suspicious/noExplicitAny: reading the global for restore
		prevDocument = (globalThis as any).document;
		// biome-ignore lint/suspicious/noExplicitAny: minimal document stub
		(globalThis as any).document = {
			body: { style: {} as Record<string, string> },
			addEventListener: (type: string, fn: Handler) => {
				if (!handlers.has(type)) handlers.set(type, new Set());
				handlers.get(type)?.add(fn);
			},
			removeEventListener: (type: string, fn: Handler) => {
				handlers.get(type)?.delete(fn);
			},
		};
	});

	afterEach(() => {
		// biome-ignore lint/suspicious/noExplicitAny: restore global
		(globalThis as any).document = prevDocument;
	});

	const arm = () => startPanelDrag({ panelId: "p1", id: "narr_1", title: "T", x: 100, y: 100 });

	test("cancel clears an armed pointer drag without activating or submitting it", () => {
		const ends: Array<PanelDragState | null> = [];
		const offEnd = onPanelDragEnd((state) => ends.push(state));
		arm();
		cancelDrag();
		for (const listeners of handlers.values()) expect(listeners.size).toBe(0);
		dispatch("pointermove", 140, 100);
		dispatch("pointerup", 140, 100);
		expect(getPanelDrag()).toBeNull();
		expect(ends).toEqual([]);
		startDragManual("narr_2", "Next", 10, 20);
		expect(endDrag()).toMatchObject({ id: "narr_2" });
		offEnd();
	});

	test("cancel clears live pointer listeners, styles and ownership without a drop", () => {
		const ends: Array<PanelDragState | null> = [];
		const offEnd = onPanelDragEnd((state) => ends.push(state));
		arm();
		dispatch("pointermove", 140, 100);
		// endDrag continues to defer pointer-owned drags to their document listener.
		expect(endDrag()).toBeNull();
		expect(getPanelDrag()).not.toBeNull();
		expect(ends).toEqual([]);
		cancelDrag();
		cancelDrag();
		expect(getPanelDrag()).toBeNull();
		expect(document.body.style.userSelect).toBe("");
		expect(document.body.style.cursor).toBe("");
		for (const listeners of handlers.values()) expect(listeners.size).toBe(0);
		dispatch("pointerup", 140, 100);
		expect(ends).toEqual([null]);
		arm();
		dispatch("pointermove", 150, 100);
		dispatch("pointerup", 150, 100);
		expect(ends[1]).toMatchObject({ id: "narr_1", x: 150 });
		offEnd();
	});

	test("release within threshold → click (no drag-end fired)", () => {
		let ended = 0;
		let moved = 0;
		const offEnd = onPanelDragEnd(() => ended++);
		const offMove = onPanelDragMove(() => moved++);
		arm();
		// Tiny jitter (< 5px) then release.
		dispatch("pointermove", 102, 101);
		dispatch("pointerup", 102, 101);
		expect(moved).toBe(0);
		expect(ended).toBe(0); // treated as a click, not a drag
		offEnd();
		offMove();
	});

	test("movement past threshold → drag activates and fires move + end", () => {
		const moves: Array<{ x: number; y: number }> = [];
		let final: unknown = "unset";
		const offMove = onPanelDragMove((s) => moves.push({ x: s.x, y: s.y }));
		const offEnd = onPanelDragEnd((s) => {
			final = s;
		});
		arm();
		dispatch("pointermove", 100, 100); // 0px — still pending
		expect(moves).toHaveLength(0);
		dispatch("pointermove", 120, 100); // 20px — crosses threshold, activates
		dispatch("pointermove", 130, 110); // subsequent live move
		dispatch("pointerup", 130, 110);
		expect(moves.length).toBeGreaterThanOrEqual(2);
		// First emitted move is the activation point.
		expect(moves[0]).toEqual({ x: 120, y: 100 });
		expect(final).toMatchObject({ id: "narr_1", panelId: "p1", x: 130, y: 110 });
		offMove();
		offEnd();
	});
});
