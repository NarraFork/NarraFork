/**
 * DiffBody.reveal.test.tsx — the truncation footer's second job: a scroll
 * sentinel that progressively reveals the rows the initial paint budget left
 * out.
 *
 * ── The bug this locks down ─────────────────────────────────────────────────
 *
 * The diff body paints at most `diffRenderRowLimit(cap)` rows (56 at the 200px
 * Edit cap) to bound the node count, then prints "… N more rows not shown".
 * Unlike a server-side PREFIX body — whose `useAutoLoadOnScroll` fetches the
 * rest once the reader scrolls past halfway — the notice was TERMINAL: the
 * reader scrolled to the end of the painted window and nothing more ever
 * loaded, even though every row was already local. The remaining rows were
 * only reachable through the fullscreen viewer.
 *
 * The fix grows the painted window by one base budget each time an
 * IntersectionObserver sees the notice scroll into view. These tests mount the
 * real component (linkedom + createRoot) behind a controllable observer stub
 * and assert the window grows on intersection, stays put off-screen, and
 * terminates with the notice gone once every row is painted.
 *
 * Height neutrality (why this cannot move measured geometry) is NOT re-asserted
 * here: it follows from the measure layer, which returns exactly `cap` for any
 * body the budget can truncate — see measure-diff.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { computeDiff } from "@shared/pretext-layout/diff-core";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { __TEST__DiffLines } from "./RenderToolCall";

const DOM_GLOBAL_KEYS = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"IS_REACT_ACT_ENVIRONMENT",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"matchMedia",
	"IntersectionObserver",
] as const;

type FakeEntry = { isIntersecting: boolean };
type FakeCallback = (entries: FakeEntry[]) => void;
type FakeOptions = { root?: unknown } | undefined;

/** Live observer callbacks; disconnect() removes, mirroring the real lifecycle. */
let liveObservers: FakeCallback[] = [];
/**
 * Options every observer was CONSTRUCTED with.
 *
 * Recorded because the stub is driven by hand: `fireSentinel` decides visibility,
 * so nothing about the real intersection maths is exercised and a missing `root`
 * cannot fail any of the growth assertions. Without a root the browser measures
 * against the viewport and ignores the capped box's own `overflow` clipping, which
 * fires every batch at once — the node ceiling and the user-action gate both stop
 * holding, invisibly. So the construction argument is asserted directly.
 */
let observerOptions: FakeOptions[] = [];

class FakeIntersectionObserver {
	private readonly cb: FakeCallback;
	private readonly options: FakeOptions;
	constructor(cb: unknown, options?: unknown) {
		this.cb = cb as FakeCallback;
		this.options = options as FakeOptions;
	}
	observe() {
		liveObservers.push(this.cb);
		observerOptions.push(this.options);
	}
	unobserve() {}
	disconnect() {
		liveObservers = liveObservers.filter((cb) => cb !== this.cb);
	}
}

/** Deliver one observer notification to every live sentinel. */
function fireSentinel(isIntersecting: boolean) {
	for (const cb of [...liveObservers]) cb([{ isIntersecting }]);
}

function installDom(): () => void {
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of DOM_GLOBAL_KEYS) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: false,
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			setTimeout(() => callback(Date.now()), 0) as unknown as number,
		cancelAnimationFrame: (handle: number) => clearTimeout(handle),
		matchMedia: () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		}),
		IntersectionObserver: FakeIntersectionObserver,
	};
	for (const key of DOM_GLOBAL_KEYS) {
		Object.defineProperty(globalThis, key, {
			configurable: true,
			enumerable: previous.get(key)?.enumerable ?? true,
			writable: true,
			value: values[key],
		});
	}
	return () => {
		for (const key of [...DOM_GLOBAL_KEYS].reverse()) {
			const descriptor = previous.get(key);
			if (!descriptor) {
				delete (globalThis as Record<string, unknown>)[key];
				continue;
			}
			Object.defineProperty(globalThis, key, descriptor);
		}
	};
}

async function settle() {
	for (let turn = 0; turn < 4; turn++) {
		for (let i = 0; i < 6; i++) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

let restoreDom: (() => void) | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
	restoreDom = installDom();
	liveObservers = [];
	observerOptions = [];
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	root?.unmount();
	root = null;
	await settle();
	container?.remove();
	container = null;
	restoreDom?.();
	restoreDom = null;
});

/** A `rows`-per-side diff: every line changes, so the row count is 2×rows. */
function bigDiff(rows: number) {
	const oldStr = Array.from({ length: rows }, (_, i) => `old ${i}`).join("\n");
	const newStr = Array.from({ length: rows }, (_, i) => `new ${i}`).join("\n");
	return { oldStr, newStr };
}

/** Mount the structured diff body the way the tool card does (cap 200 → 56 rows). */
async function mountDiff(totalRowsPerSide: number) {
	if (!root) throw new Error("harness is not initialized");
	const { oldStr, newStr } = bigDiff(totalRowsPerSide);
	const lines = computeDiff(oldStr, newStr, 1);
	const text = lines
		.map((l) => `${l.type === "removed" ? "-" : l.type === "added" ? "+" : " "}${l.content}`)
		.join("\n");
	root.render(
		createElement(
			MantineProvider,
			{ forceColorScheme: "dark" },
			__TEST__DiffLines({
				text,
				lang: undefined,
				data: { diffLines: lines, cap: 200 },
			}),
		),
	);
	await settle();
}

const paintedRows = () => Array.from(container?.querySelectorAll("[data-diff-row]") ?? []).length;
const noticeText = () => container?.textContent ?? "";

describe("diff progressive reveal (scroll sentinel)", () => {
	it("paints only the initial budget until the sentinel intersects", async () => {
		await mountDiff(250); // 500 rows total
		// 200px / 15px per line ≈ 14 visible rows × 4 screens of overscan = 56.
		expect(paintedRows()).toBe(56);
		expect(noticeText()).toContain("444 more rows not shown");
	});

	it("grows the window by one base budget each time the sentinel appears", async () => {
		await mountDiff(250);
		fireSentinel(true);
		await settle();
		expect(paintedRows()).toBe(112);
		expect(noticeText()).toContain("388 more rows not shown");
		fireSentinel(true);
		await settle();
		expect(paintedRows()).toBe(168);
	});

	it("ignores a sentinel that left the visible region", async () => {
		await mountDiff(250);
		fireSentinel(false);
		await settle();
		expect(paintedRows()).toBe(56);
	});

	it("terminates with every row painted and the notice gone", async () => {
		await mountDiff(250);
		// 444 hidden rows at +56 per reach → 8 reaches reveal the rest.
		for (let i = 0; i < 8; i++) {
			fireSentinel(true);
			await settle();
		}
		expect(paintedRows()).toBe(500);
		expect(noticeText()).not.toContain("more rows not shown");
	});

	it("applies the same reveal to the plain +/- fallback body", async () => {
		if (!root) throw new Error("harness is not initialized");
		const text = Array.from({ length: 400 }, (_, i) => `+line ${i}`).join("\n");
		root.render(
			createElement(
				MantineProvider,
				{ forceColorScheme: "dark" },
				__TEST__DiffLines({ text, lang: undefined, data: { cap: 200 } }),
			),
		);
		await settle();
		const fallbackRows = () =>
			Array.from(container?.querySelectorAll("div") ?? []).filter((d) =>
				(d.getAttribute("style") ?? "").includes("pre-wrap"),
			).length;
		expect(fallbackRows()).toBe(56);
		fireSentinel(true);
		await settle();
		expect(fallbackRows()).toBe(112);
	});

	it("observes nothing when the whole body fits the initial budget", async () => {
		await mountDiff(3); // 6 rows — under the 56-row budget
		expect(paintedRows()).toBe(6);
		expect(noticeText()).not.toContain("more rows not shown");
		expect(liveObservers).toHaveLength(0);
	});

	/**
	 * The observer must be scoped to the CAPPED BOX, not the viewport.
	 *
	 * With the default root, the browser ignores the ancestor `overflow` that hides
	 * the unpainted rows: a 200px box fully inside the viewport reports its footer as
	 * intersecting while the box itself has scrolled nowhere, so every batch fires in
	 * a chain until all 500 rows are painted. Both the node ceiling and the
	 * "one batch per reader scroll" gate stop holding, with no error to show for it.
	 *
	 * Asserted on the CONSTRUCTION argument because this stub is hand-driven — the
	 * growth assertions above pass either way.
	 */
	it("scopes the observer to a root instead of the viewport", async () => {
		await mountDiff(250);
		expect(observerOptions).toHaveLength(1);
		const options = observerOptions[0];
		// The key must be passed explicitly. linkedom reports no layout, so
		// findVerticalScrollParent legitimately resolves to null here; what this pins
		// is that the root is SUPPLIED (from the resolved scrollport) rather than
		// omitted, which is the difference between box- and viewport-relative
		// intersection. findVerticalScrollParent's own resolution is covered by
		// hooks/useSwipeMenu.scroll-parent.test.ts.
		expect(options).not.toBeUndefined();
		expect(options && "root" in options).toBe(true);
	});
});
