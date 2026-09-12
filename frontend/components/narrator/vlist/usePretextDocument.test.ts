/**
 * usePretextDocument.test.ts — the FONT- and TYPOGRAPHY-generation subscriptions.
 *
 * This hook is the only mount point for the font-generation mechanism that
 * `katex-runtime` (observation) and `prepared-markdown-cache` (the generation
 * itself) implement, and for the user-driven typography generation in
 * `@shared/pretext-layout/typography`. Without the subscriptions both sides are
 * dead code: the generation advances, the caches are dropped, and the COMMITTED
 * layout keeps its baked wrap points — measurement and render diverge, which is
 * the single failure the exact list exists to prevent.
 *
 * The typography case is the one users actually hit: the settings panel is meant
 * to be dragged while watching the transcript, so a missing subscription here is
 * a slider that visibly does nothing.
 *
 * Two properties are pinned, and the second matters as much as the first:
 *   1. a generation change rebuilds the committed layout;
 *   2. the effect unsubscribes, and exactly ONE subscriber exists per mounted
 *      hook — a leaked listener retains a released coordinator (and its whole
 *      document) for the lifetime of the tab, and React 19 StrictMode mounts every
 *      effect twice, so "subscribe without cleanup" is not a theoretical bug.
 *
 * The subscriber count is observed through the `getCurrentView` callback: the
 * coordinator invokes it exactly once per `invalidateFontDependentLayout` call, so
 * the call delta across a generation bump IS the number of live subscribers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import { resetTypographyForTest, setTypography } from "@shared/pretext-layout/typography";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { bumpFontRevisionForTest } from "./katex-runtime";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { measureCache } from "./measure-cache";
import type { PretextDocumentView, UsePretextDocumentResult } from "./usePretextDocument";
import { usePretextDocument } from "./usePretextDocument";

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
] as const;

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
	};
	for (const key of DOM_GLOBAL_KEYS) {
		const descriptor = previous.get(key);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) {
				(globalThis as Record<string, unknown>)[key] = values[key];
			}
			continue;
		}
		Object.defineProperty(globalThis, key, {
			configurable: true,
			enumerable: descriptor?.enumerable ?? true,
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
			const current = Object.getOwnPropertyDescriptor(globalThis, key);
			if (current && !current.configurable) {
				if ("writable" in current && current.writable && "value" in descriptor) {
					(globalThis as Record<string, unknown>)[key] = descriptor.value;
				}
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

function message(seq: number, text: string): TreeMessage {
	return {
		id: `m-${seq}`,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		createdAt: "2026-07-23T00:00:00.000Z",
		children: [],
		seq,
	} as TreeMessage;
}

function page(): PretextDocumentPageResult {
	return {
		messages: [message(0, "# a body\n\nsome prose"), message(1, "another body")],
		minSeq: 0,
		maxSeq: 1,
		hasNext: false,
		hasPrev: false,
		messageVersion: 3,
	};
}

/** Stable across renders, so the hook's build/subscribe effects do not re-run. */
const LOAD_OPTIONS = { fetchPage: async () => page() };

/** Live-view reads, counted: one per invalidateFontDependentLayout call. */
let viewCalls = 0;
function readCurrentView(): PretextDocumentView {
	viewCalls++;
	return { scrollTop: 0, viewportHeight: 720, pinnedToBottom: true };
}

let renders: UsePretextDocumentResult[] = [];

function Harness() {
	renders.push(
		usePretextDocument("n1", {
			lod: 5,
			widthBucket: "860",
			contentWidth: 860,
			viewportHeight: 720,
			scrollTop: 0,
			pinnedToBottom: true,
			getCurrentView: readCurrentView,
			loadOptions: LOAD_OPTIONS,
		}),
	);
	return null;
}

let restoreDom: (() => void) | null = null;
let restoreCanvas: (() => void) | null = null;
let roots: Root[] = [];
let containers: HTMLDivElement[] = [];

/** Mount one more independent instance of the hook; returns its root. */
async function mount(): Promise<Root> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	containers.push(container);
	roots.push(root);
	root.render(createElement(Harness, {}));
	await settle();
	return root;
}

/** The most recent hook result. */
function latest(): UsePretextDocumentResult {
	const last = renders.at(-1);
	if (!last) throw new Error("hook never rendered");
	return last;
}

beforeEach(() => {
	restoreDom = installDom();
	restoreCanvas = installCanvasStub();
	renders = [];
	roots = [];
	containers = [];
	viewCalls = 0;
});

afterEach(async () => {
	for (const root of roots) root.unmount();
	roots = [];
	await settle();
	for (const container of containers) container.remove();
	containers = [];
	restoreCanvas?.();
	restoreCanvas = null;
	restoreDom?.();
	restoreDom = null;
});

describe("usePretextDocument font-generation subscription", () => {
	test("a generation change rebuilds the committed layout exactly once", async () => {
		await mount();
		expect(latest().status).toBe("ready");
		const before = latest().index;
		expect(before).toBeDefined();

		// Cleared so the repopulation below is attributable to THIS rebuild.
		measureCache.clear();
		const viewCallsBefore = viewCalls;
		bumpFontRevisionForTest();
		await settle();

		// Exactly one live subscriber: a leaked one from an earlier mount (or a
		// StrictMode double-invoke without cleanup) would show up as 2+.
		expect(viewCalls - viewCallsBefore).toBe(1);
		// A NEW index object: the stale one carried heights derived from prepared
		// handles baked against the previous face.
		expect(latest().index).not.toBe(before);
		expect(latest().status).toBe("ready");
		expect(measureCache.size).toBeGreaterThan(0);
	});

	test("unmount unsubscribes, so a later font swap does not touch a released layout", async () => {
		const root = await mount();
		expect(latest().status).toBe("ready");
		root.unmount();
		roots = roots.filter((entry) => entry !== root);
		await settle();

		measureCache.clear();
		const viewCallsBefore = viewCalls;
		bumpFontRevisionForTest();
		await settle();

		expect(viewCalls - viewCallsBefore).toBe(0);
		// Nothing rebuilt: the released coordinator was not driven at all.
		expect(measureCache.size).toBe(0);
	});

	test("a remount (StrictMode's double invoke) leaves exactly one subscriber", async () => {
		const first = await mount();
		first.unmount();
		roots = roots.filter((entry) => entry !== first);
		await settle();
		await mount();
		expect(latest().status).toBe("ready");

		const viewCallsBefore = viewCalls;
		bumpFontRevisionForTest();
		await settle();

		expect(viewCalls - viewCallsBefore).toBe(1);
	});
});

describe("usePretextDocument typography subscription", () => {
	afterEach(() => {
		// The generation gates caches that are cleared alongside it, so rewinding is
		// safe here and keeps each test independent.
		resetTypographyForTest();
	});

	test("a typography change rebuilds the committed layout exactly once", async () => {
		await mount();
		expect(latest().status).toBe("ready");
		const before = latest().index;
		expect(before).toBeDefined();

		measureCache.clear();
		const viewCallsBefore = viewCalls;
		setTypography({ fontScalePercent: 130 });
		await settle();

		// One live subscriber, same contract as the font case.
		expect(viewCalls - viewCallsBefore).toBe(1);
		// A NEW index: the old heights were measured at the previous font scale, so
		// serving them would leave the transcript predicting 14px rows while the
		// render layer paints 18.2px ones.
		expect(latest().index).not.toBe(before);
		expect(latest().status).toBe("ready");
		expect(measureCache.size).toBeGreaterThan(0);
	});

	test("a no-op write does not rebuild", async () => {
		await mount();
		expect(latest().status).toBe("ready");
		const before = latest().index;

		const viewCallsBefore = viewCalls;
		// Already the active value: re-measuring every message here would make
		// dragging a slider across a value it already holds cost a full rebuild.
		setTypography({ fontScalePercent: 100 });
		await settle();

		expect(viewCalls - viewCallsBefore).toBe(0);
		expect(latest().index).toBe(before);
	});

	test("unmount unsubscribes, so a later change does not touch a released layout", async () => {
		const root = await mount();
		expect(latest().status).toBe("ready");
		root.unmount();
		roots = roots.filter((entry) => entry !== root);
		await settle();

		measureCache.clear();
		const viewCallsBefore = viewCalls;
		setTypography({ paragraphScalePercent: 150 });
		await settle();

		expect(viewCalls - viewCallsBefore).toBe(0);
		expect(measureCache.size).toBe(0);
	});
});
