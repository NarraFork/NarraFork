import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	HEADER_TITLE_MIN_WIDTH_PX,
	HEADER_TITLE_SLOT_ATTR,
	HEADER_TOOLBAR_FIXED_ATTR,
	HEADER_TOOLBAR_GAP_PX,
	HEADER_TOOLBAR_ITEM_WIDTH_PX,
	resolveHeaderToolbarBudget,
	resolveHeaderToolbarCapacity,
	selectHeaderToolbarEntries,
} from "./narrator-header-toolbar-capacity";
import { NARRATOR_TOOLBAR_ITEMS } from "./narrator-toolbar-items";

const ITEM = HEADER_TOOLBAR_ITEM_WIDTH_PX;
const GAP = HEADER_TOOLBAR_GAP_PX;

/** Width needed to keep `count` entries inline. */
function needFor(count: number): number {
	return count * ITEM + Math.max(0, count - 1) * GAP;
}

describe("resolveHeaderToolbarCapacity", () => {
	test("keeps every entry when the budget covers them", () => {
		expect(resolveHeaderToolbarCapacity({ budgetWidth: needFor(12), itemCount: 12 })).toBe(12);
		// Extra room does not invent entries that do not exist.
		expect(resolveHeaderToolbarCapacity({ budgetWidth: 4000, itemCount: 12 })).toBe(12);
	});

	test("capacity falls one entry at a time as the budget shrinks", () => {
		for (let keep = 12; keep >= 1; keep--) {
			expect(resolveHeaderToolbarCapacity({ budgetWidth: needFor(keep), itemCount: 12 })).toBe(
				keep,
			);
			// One pixel short of the requirement must drop exactly one entry.
			expect(resolveHeaderToolbarCapacity({ budgetWidth: needFor(keep) - 1, itemCount: 12 })).toBe(
				keep - 1,
			);
		}
	});

	test("is a fixed point: feeding the result back at the same budget changes nothing", () => {
		// Regression for the cascade class of bug: the budget must not depend on the
		// current decision, and re-resolving must reproduce the same answer.
		for (const keep of [12, 9, 6, 3, 1]) {
			let capacity = resolveHeaderToolbarCapacity({ budgetWidth: needFor(keep), itemCount: 12 });
			for (let pass = 0; pass < 5; pass++) {
				const next = resolveHeaderToolbarCapacity({
					budgetWidth: needFor(keep),
					itemCount: 12,
					previousCapacity: capacity,
				});
				expect(next).toBe(capacity);
				capacity = next;
			}
		}
	});

	test("restoring an entry requires the hysteresis margin", () => {
		const collapsed = resolveHeaderToolbarCapacity({ budgetWidth: needFor(6), itemCount: 12 });
		expect(collapsed).toBe(6);

		// Just clearing the raw requirement is not enough — this is the width band
		// where a scrollbar appearing and disappearing would otherwise oscillate.
		expect(
			resolveHeaderToolbarCapacity({
				budgetWidth: needFor(7),
				itemCount: 12,
				previousCapacity: collapsed,
			}),
		).toBe(6);

		expect(
			resolveHeaderToolbarCapacity({
				budgetWidth: needFor(7) + 12,
				itemCount: 12,
				previousCapacity: collapsed,
			}),
		).toBe(7);
	});

	test("collapsing is never blocked by hysteresis", () => {
		expect(
			resolveHeaderToolbarCapacity({
				budgetWidth: needFor(3),
				itemCount: 12,
				previousCapacity: 12,
			}),
		).toBe(3);
	});

	test("a budget too small for one entry yields zero, never a negative count", () => {
		for (const budgetWidth of [ITEM - 1, 1, 0, -50, Number.NaN]) {
			expect(resolveHeaderToolbarCapacity({ budgetWidth, itemCount: 12 })).toBe(0);
		}
		expect(resolveHeaderToolbarCapacity({ budgetWidth: 4000, itemCount: 0 })).toBe(0);
	});
});

describe("selectHeaderToolbarEntries", () => {
	const defs = [
		{ id: "a" },
		{ id: "b" },
		{ id: "menu1", selfContained: true },
		{ id: "c" },
		{ id: "menu2", selfContained: true },
	];

	test("an uncapped or generous capacity keeps everything on the row", () => {
		expect(selectHeaderToolbarEntries(defs, null).visible.map((d) => d.id)).toEqual([
			"a",
			"b",
			"menu1",
			"c",
			"menu2",
		]);
		expect(selectHeaderToolbarEntries(defs, 99).hidden).toEqual([]);
	});

	test("collapses activatable entries from the end before any self-contained one", () => {
		// `c` is the last activatable entry, so it goes first even though two
		// self-contained controls sit after it in layout order.
		expect(selectHeaderToolbarEntries(defs, 4).hidden.map((d) => d.id)).toEqual(["c"]);
		expect(selectHeaderToolbarEntries(defs, 3).hidden.map((d) => d.id)).toEqual(["b", "c"]);
		expect(selectHeaderToolbarEntries(defs, 2).hidden.map((d) => d.id)).toEqual(["a", "b", "c"]);
	});

	test("self-contained controls are the last to leave the row", () => {
		// The regression this exists for: those controls cannot be opened from the
		// overflow menu (Mantine v7 has no submenu), so collapsing them first would
		// make the device picker and detail level unreachable on a narrow desktop
		// row — with a menu row that still claims to be "shown in header".
		expect(selectHeaderToolbarEntries(defs, 1).visible.map((d) => d.id)).toEqual(["menu1"]);
		expect(selectHeaderToolbarEntries(defs, 2).visible.map((d) => d.id)).toEqual([
			"menu1",
			"menu2",
		]);
	});

	test("keeps layout order in both lists and never loses or duplicates an entry", () => {
		for (let capacity = 0; capacity <= defs.length; capacity++) {
			const { visible, hidden } = selectHeaderToolbarEntries(defs, capacity);
			expect(visible).toHaveLength(capacity);
			expect(visible.length + hidden.length).toBe(defs.length);
			// Each list is a subsequence of the layout order.
			for (const list of [visible, hidden]) {
				const positions = list.map((def) => defs.findIndex((d) => d.id === def.id));
				expect(positions).toEqual([...positions].sort((a, b) => a - b));
			}
			expect(new Set([...visible, ...hidden].map((d) => d.id)).size).toBe(defs.length);
		}
	});

	test("the real registry's self-contained controls survive a one-slot row", () => {
		// Guards the premise above against the registry rather than a fixture: if
		// `selfContained` were dropped from device / lodlevel / plugins, the rule
		// would silently stop protecting anything.
		const selfContained = NARRATOR_TOOLBAR_ITEMS.filter((def) => def.selfContained === true);
		expect(selfContained.length).toBeGreaterThan(0);

		const { visible } = selectHeaderToolbarEntries(NARRATOR_TOOLBAR_ITEMS, 1);
		expect(visible).toHaveLength(1);
		expect(visible[0]?.selfContained).toBe(true);
	});
});

let restore: (() => void) | undefined;

afterEach(() => {
	restore?.();
	restore = undefined;
});

/**
 * Build a header row whose element widths come from `data-w`, so the budget
 * calculation can be exercised without a layout engine.
 */
function buildRow(html: string): { row: HTMLElement; toolbar: HTMLElement; leading: HTMLElement } {
	const { window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
		configurable: true,
		value(this: HTMLElement) {
			const width = Number(this.getAttribute("data-w")) || 0;
			return {
				x: 0,
				y: 0,
				width,
				height: 40,
				top: 0,
				right: width,
				bottom: 40,
				left: 0,
			} as DOMRect;
		},
	});

	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		writable: true,
		// Only `getComputedStyle` is consulted; linkedom returns an empty
		// declaration, which is exactly the "no explicit padding/gap" case.
		value: window,
	});
	restore = () => {
		if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
	};

	const doc = window.document;
	const row = doc.querySelector("[data-row]") as unknown as HTMLElement;
	const leading = doc.querySelector("[data-leading]") as unknown as HTMLElement;
	const toolbar = doc.querySelector("[data-toolbar]") as unknown as HTMLElement;
	return { row, toolbar, leading };
}

const ROW_HTML = (rowWidth: number, titleSlotWidth: number, fixedCount: number) => `
	<div data-row data-w="${rowWidth}">
		<div data-leading data-w="${rowWidth}">
			<button data-w="28">back</button>
			<div ${HEADER_TITLE_SLOT_ATTR} data-w="${titleSlotWidth}">title</div>
		</div>
		<div data-toolbar data-w="0">
			<div data-w="22">entry</div>
			${Array.from({ length: fixedCount }, () => `<div ${HEADER_TOOLBAR_FIXED_ATTR} data-w="22"></div>`).join("")}
		</div>
	</div>`;

describe("resolveHeaderToolbarBudget", () => {
	test("budgets the title slot by policy, ignoring its measured width", () => {
		// The regression this guards: the title slot is `flex: 1`, so its measured
		// width is whatever the toolbar left over. Measuring it would make the
		// budget a function of its own result.
		const wide = buildRow(ROW_HTML(1000, 900, 1));
		const narrow = buildRow(ROW_HTML(1000, 10, 1));
		const options = { titleSlotMinWidth: HEADER_TITLE_MIN_WIDTH_PX };

		expect(resolveHeaderToolbarBudget({ ...wide, ...options })).toBe(
			resolveHeaderToolbarBudget({ ...narrow, ...options }),
		);
	});

	test("subtracts the row width, leading controls, gaps and fixed trailing controls", () => {
		const { row, toolbar, leading } = buildRow(ROW_HTML(1000, 400, 2));
		const budget = resolveHeaderToolbarBudget({
			row,
			toolbar,
			leading,
			titleSlotMinWidth: HEADER_TITLE_MIN_WIDTH_PX,
		});

		// 1000 − rowGap 10 − back 28 − title 140 − leadingGap 10 − 2 × (22 + 10)
		expect(budget).toBe(1000 - GAP - 28 - HEADER_TITLE_MIN_WIDTH_PX - GAP - 2 * (22 + GAP));
	});

	test("a host that owns the title hands that width to the entries", () => {
		const built = buildRow(ROW_HTML(1000, 400, 1));
		const withTitle = resolveHeaderToolbarBudget({
			...built,
			titleSlotMinWidth: HEADER_TITLE_MIN_WIDTH_PX,
		});
		const hostOwnsTitle = resolveHeaderToolbarBudget({ ...built, titleSlotMinWidth: 0 });

		expect(hostOwnsTitle - withTitle).toBe(HEADER_TITLE_MIN_WIDTH_PX);
	});

	test("an unmeasured row yields no budget rather than a negative one", () => {
		const { row, toolbar, leading } = buildRow(ROW_HTML(0, 0, 1));
		expect(resolveHeaderToolbarBudget({ row, toolbar, leading, titleSlotMinWidth: 140 })).toBe(0);

		const tiny = buildRow(ROW_HTML(40, 0, 3));
		expect(resolveHeaderToolbarBudget({ ...tiny, titleSlotMinWidth: 140 })).toBe(0);
	});
});
