/**
 * pretext-document-restore.test.ts — the cross-switch RESTORE path.
 *
 * `usePretextDocument` builds its coordinator in a `useMemo` and the narrator
 * route mounts the panel under `key={narratorId}`, so every switch destroyed the
 * document and re-fetched the tail page (283KB-1.3MB on long histories) before
 * anything could paint. The restore path adopts the previous window from
 * `pretext-document-cache` and commits its layout synchronously.
 *
 * Three properties are pinned, and the last two are what keep the optimisation
 * honest:
 *   1. a revisit paints from cache WITHOUT waiting for the network;
 *   2. it still revalidates, so a document that changed while away is refreshed
 *      rather than silently served stale forever;
 *   3. a first visit (cold cache) is unaffected.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { clearPretextDocumentCache } from "./pretext-document-cache";
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

function page(seqs: readonly number[], messageVersion = 3): PretextDocumentPageResult {
	return {
		messages: seqs.map((seq) => message(seq, `body ${seq}`)),
		minSeq: seqs.length > 0 ? Math.min(...seqs) : null,
		maxSeq: seqs.length > 0 ? Math.max(...seqs) : null,
		hasNext: false,
		hasPrev: false,
		messageVersion,
		pruneBoundaryMessageId: null,
		prunedPercent: null,
	};
}

/** Controllable transport: counts calls and can be held open to observe first paint. */
let fetchCalls = 0;
let nextPage: () => PretextDocumentPageResult = () => page([0, 1]);
let gate: { promise: Promise<void>; release: () => void } | null = null;

function openGate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	gate = { promise, release };
}

const LOAD_OPTIONS = {
	fetchPage: async () => {
		fetchCalls++;
		if (gate) await gate.promise;
		return nextPage();
	},
};

function readCurrentView(): PretextDocumentView {
	return { scrollTop: 0, viewportHeight: 720, pinnedToBottom: true };
}

let renders: UsePretextDocumentResult[] = [];

function makeHarness(narratorId: string) {
	return function Harness() {
		renders.push(
			usePretextDocument(narratorId, {
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
	};
}

let restoreDom: (() => void) | null = null;
let restoreCanvas: (() => void) | null = null;
let roots: Root[] = [];
let containers: HTMLDivElement[] = [];

async function mount(narratorId: string): Promise<Root> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	containers.push(container);
	roots.push(root);
	root.render(createElement(makeHarness(narratorId), {}));
	await settle();
	return root;
}

function unmount(root: Root) {
	root.unmount();
	roots = roots.filter((entry) => entry !== root);
}

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
	fetchCalls = 0;
	gate = null;
	nextPage = () => page([0, 1]);
	clearPretextDocumentCache();
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
	clearPretextDocumentCache();
});

describe("pretext document restore across a narrator switch", () => {
	test("a first visit has nothing to restore and loads normally", async () => {
		await mount("n1");
		expect(latest().status).toBe("ready");
		expect(latest().messages.map((item) => item.seq)).toEqual([0, 1]);
		expect(fetchCalls).toBe(1);
	});

	test("a revisit paints from cache before the network resolves", async () => {
		const first = await mount("n1");
		expect(latest().status).toBe("ready");
		unmount(first);
		await settle();

		// Hold the transport open: anything painted while it is blocked came from
		// the cache, which is exactly the property under test.
		fetchCalls = 0;
		openGate();
		renders = [];
		await mount("n1");

		// A committed `index` plus a full item set is what the shell actually gates
		// its canvas on (hasRenderableExactLayout) — NOT `status`, which is
		// legitimately "loading" here because the revalidation fetch is in flight
		// behind the gate. That distinction is the whole point: the reader sees their
		// history while the refresh runs underneath.
		const restored = latest();
		expect(restored.index).toBeDefined();
		expect(restored.messages.map((item) => item.seq)).toEqual([0, 1]);
		expect(restored.items.length).toBe(restored.manifest?.items.length ?? -1);
		expect(restored.items.length).toBeGreaterThan(0);

		gate?.release();
		gate = null;
		await settle();
		expect(latest().status).toBe("ready");
	});

	test("a revisit still revalidates, adopting content that changed while away", async () => {
		const first = await mount("n1");
		expect(latest().messages.map((item) => item.seq)).toEqual([0, 1]);
		unmount(first);
		await settle();

		// The narrator gained a message (and a version) while the reader was away.
		fetchCalls = 0;
		nextPage = () => page([0, 1, 2], 4);
		renders = [];
		await mount("n1");
		await settle();

		expect(fetchCalls).toBeGreaterThan(0);
		expect(latest().status).toBe("ready");
		expect(latest().messages.map((item) => item.seq)).toEqual([0, 1, 2]);
		expect(latest().messageVersion).toBe(4);
	});

	test("a different narrator is never served another's cached document", async () => {
		const first = await mount("n1");
		expect(latest().messages.map((item) => item.seq)).toEqual([0, 1]);
		unmount(first);
		await settle();

		nextPage = () => page([7, 8], 5);
		renders = [];
		await mount("n2");
		await settle();

		expect(latest().messages.map((item) => item.seq)).toEqual([7, 8]);
	});
});
