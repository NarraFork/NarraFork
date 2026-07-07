import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	isNarratorSubject,
	isSyntheticSubjectId,
	onPanelDragEnd,
	onPanelDragMove,
	type PanelDragState,
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
