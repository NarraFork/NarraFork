/**
 * useGitGraphHeight — clamping and the drag's host-imposed ceiling.
 *
 * The defect these pin: the drag clamped only against the GLOBAL maximum, so in a
 * short dock panel it kept accepting input past the height the panel could show.
 * The handle followed the cursor, the chart did not grow, and the persisted
 * preference ended up describing a size the user never saw.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	__resetGitGraphHeightCache,
	clampGitGraphHeight,
	GIT_GRAPH_HEIGHT_DEFAULT,
	GIT_GRAPH_HEIGHT_MAX,
	GIT_GRAPH_HEIGHT_MIN,
	startGitGraphHeightResize,
} from "./useGitGraphHeight";

const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const store = new Map<string, string>();
	Object.assign(window, {
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
			clear: () => store.clear(),
		},
	});
	for (const key of ["window", "document", "localStorage"] as const) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	Object.defineProperties(globalThis, {
		window: { configurable: true, writable: true, value: window },
		document: { configurable: true, writable: true, value: window.document },
		localStorage: { configurable: true, writable: true, value: window.localStorage },
	});
	return window;
}

function restoreDom() {
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
}

/**
 * Drive one drag gesture and collect every height it published.
 *
 * `deltas` are cursor movements in px; NEGATIVE means the cursor moved up, which
 * is the direction that GROWS the chart (content sits below the handle).
 */
function drag(
	window: Window & typeof globalThis,
	opts: { startHeight: number; maxHeight?: number },
	deltas: number[],
): number[] {
	const published: number[] = [];
	const startY = 500;
	startGitGraphHeightResize(
		{ clientY: startY, pointerId: 7, preventDefault: () => {} },
		{
			workspaceKey: "ws-1",
			startHeight: opts.startHeight,
			setHeight: (value) => published.push(value),
			...(opts.maxHeight !== undefined ? { maxHeight: opts.maxHeight } : {}),
		},
	);
	for (const delta of deltas) {
		const event = new window.Event("pointermove") as Event & {
			pointerId?: number;
			clientY?: number;
		};
		event.pointerId = 7;
		event.clientY = startY + delta;
		window.dispatchEvent(event);
	}
	const up = new window.Event("pointerup") as Event & { pointerId?: number };
	up.pointerId = 7;
	window.dispatchEvent(up);
	return published;
}

describe("clampGitGraphHeight", () => {
	test("keeps a value inside the global bounds and rounds it", () => {
		expect(clampGitGraphHeight(240.4)).toBe(240);
		expect(clampGitGraphHeight(GIT_GRAPH_HEIGHT_MIN - 50)).toBe(GIT_GRAPH_HEIGHT_MIN);
		expect(clampGitGraphHeight(GIT_GRAPH_HEIGHT_MAX + 50)).toBe(GIT_GRAPH_HEIGHT_MAX);
	});

	test("falls back to the default for a non-finite value", () => {
		// A corrupted stored pref must not become NaN px. Infinity takes the same branch
		// (it is not finite), which is the safer read: a garbage value means "no stated
		// preference", not "as tall as possible".
		expect(clampGitGraphHeight(Number.NaN)).toBe(GIT_GRAPH_HEIGHT_DEFAULT);
		expect(clampGitGraphHeight(Number.POSITIVE_INFINITY)).toBe(GIT_GRAPH_HEIGHT_DEFAULT);
	});
});

describe("startGitGraphHeightResize — host ceiling", () => {
	let window: Window & typeof globalThis;

	beforeEach(() => {
		window = installDom() as unknown as Window & typeof globalThis;
		__resetGitGraphHeightCache();
	});

	afterEach(() => {
		restoreDom();
	});

	test("stops at the host ceiling instead of the global maximum", () => {
		// Dragging up 400px from 200 would reach 600 → clamped to 560 globally. The host
		// only has room for 260, and that is where it must stop.
		const published = drag(window, { startHeight: 200, maxHeight: 260 }, [-100, -250, -400]);
		expect(published.length).toBeGreaterThan(0);
		expect(Math.max(...published)).toBe(260);
	});

	test("still shrinks freely below the ceiling", () => {
		const published = drag(window, { startHeight: 300, maxHeight: 320 }, [60, 200]);
		expect(published).toContain(240);
		// The global floor still applies on the way down.
		expect(Math.min(...published)).toBeGreaterThanOrEqual(GIT_GRAPH_HEIGHT_MIN);
	});

	test("clamps the drag's own starting height to the ceiling", () => {
		// A stored preference taller than the host: the gesture must continue from what
		// is actually on screen, or the first pointermove jumps.
		const published = drag(window, { startHeight: 540, maxHeight: 200 }, [-10]);
		expect(Math.max(...published)).toBe(200);
	});

	test("allows the global maximum when no ceiling is given", () => {
		const published = drag(window, { startHeight: 400 }, [-400]);
		expect(Math.max(...published)).toBe(GIT_GRAPH_HEIGHT_MAX);
	});

	test("never lets a ceiling below the floor collapse the strip", () => {
		// A host too short for both panes yields a negative budget upstream; the floor wins.
		const published = drag(window, { startHeight: 300, maxHeight: 10 }, [-50, 400]);
		expect(Math.max(...published)).toBe(GIT_GRAPH_HEIGHT_MIN);
		expect(Math.min(...published)).toBe(GIT_GRAPH_HEIGHT_MIN);
	});

	test("ignores pointermove from a different pointer", () => {
		const published: number[] = [];
		startGitGraphHeightResize(
			{ clientY: 500, pointerId: 1, preventDefault: () => {} },
			{
				workspaceKey: "ws-1",
				startHeight: 240,
				setHeight: (value) => published.push(value),
				maxHeight: 400,
			},
		);
		const event = new window.Event("pointermove") as Event & {
			pointerId?: number;
			clientY?: number;
		};
		event.pointerId = 99;
		event.clientY = 400;
		window.dispatchEvent(event);
		expect(published).toEqual([]);
	});
});
