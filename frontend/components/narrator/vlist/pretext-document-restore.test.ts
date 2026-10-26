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
import { clearToken, setToken } from "@frontend/lib/api/client";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { clearPretextDocumentCache, peekCachedPretextDocument } from "./pretext-document-cache";
import {
	type PretextDocumentFetchPage,
	preloadPretextDocumentTail,
} from "./pretext-document-loader";
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
	return rowWithElements(
		{
			id: `m-${seq}`,
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentText: text,
			toolCalls: [],
			createdAt: "2026-07-23T00:00:00.000Z",
			seq,
		},
		[{ type: "text", text }],
	) as TreeMessage;
}

function page(seqs: readonly number[], messageVersion = 3): PretextDocumentPageResult {
	return {
		messages: seqs.map((seq) => message(seq, `body ${seq}`)),
		minSeq: seqs.length > 0 ? Math.min(...seqs) : null,
		maxSeq: seqs.length > 0 ? Math.max(...seqs) : null,
		hasNext: false,
		hasPrev: false,
		messageVersion,
	};
}

/** Controllable transport: counts calls and can be held open to observe first paint. */
let fetchCalls = 0;
let fetchQueries: Parameters<PretextDocumentFetchPage>[1][] = [];
let locateCalls: string[] = [];
let locateFailure: Error | null = null;
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
	locateMessage: async (_narratorId: string, messageId: string) => {
		locateCalls.push(messageId);
		if (locateFailure) throw locateFailure;
		return { messageId, topLevelMessageId: messageId, seq: Number(messageId.slice(2)) };
	},
	fetchPage: async (_narratorId: string, options: Parameters<PretextDocumentFetchPage>[1]) => {
		fetchCalls++;
		fetchQueries.push(options);
		if (gate) await gate.promise;
		return nextPage();
	},
};

function readCurrentView(): PretextDocumentView {
	return { scrollTop: 0, viewportHeight: 720, pinnedToBottom: true };
}

let renders: UsePretextDocumentResult[] = [];
let contentWidth = 860;
let layoutReady = true;

function makeHarness(narratorId: string) {
	return function Harness() {
		renders.push(
			usePretextDocument(narratorId, {
				lod: 5,
				widthBucket: String(contentWidth),
				contentWidth,
				layoutReady,
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

async function mount(narratorId: string, Harness = makeHarness(narratorId)): Promise<Root> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	containers.push(container);
	roots.push(root);
	root.render(createElement(Harness, {}));
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
	fetchQueries = [];
	locateCalls = [];
	locateFailure = null;
	contentWidth = 860;
	layoutReady = true;
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
	test("a warm server-version-zero window revalidates canonically with no tail transport", async () => {
		nextPage = () => page([0, 1], 0);
		const first = await mount("n1");
		unmount(first);
		await settle();
		expect(peekCachedPretextDocument("n1")?.messageVersion).toBe(0);
		fetchCalls = 0;
		fetchQueries = [];
		locateCalls = [];
		nextPage = () => ({
			...page([0, 1, 2], 1),
			messages: [message(0, "edited head"), message(1, "unchanged"), message(2, "appended")],
		});
		await mount("n1");
		expect(locateCalls).toEqual(["m-0"]);
		expect(fetchCalls).toBe(1);
		expect(fetchQueries.map(({ afterSeq, limit }) => ({ afterSeq, limit }))).toEqual([
			{ afterSeq: -1, limit: 100 },
		]);
		expect(latest().messages.map((entry) => entry.contentText)).toEqual([
			"edited head",
			"unchanged",
			"appended",
		]);
		expect(latest().messageVersion).toBe(1);
	});

	test("a deleted stable head falls back to precisely one canonical tail", async () => {
		const first = await mount("n1");
		unmount(first);
		await settle();
		fetchCalls = 0;
		fetchQueries = [];
		nextPage = () => page([1, 2], 4);
		await mount("n1");
		expect(fetchCalls).toBe(2);
		expect(fetchQueries.filter((query) => query.afterSeq === undefined)).toHaveLength(1);
		expect(latest().messages.map((entry) => entry.id)).toEqual(["m-1", "m-2"]);
		expect(latest().messageVersion).toBe(4);
	});

	test("a 409 during stable-head lookup uses one fresh tail and does not pretend cache is current", async () => {
		const first = await mount("n1");
		unmount(first);
		await settle();
		fetchCalls = 0;
		fetchQueries = [];
		locateFailure = Object.assign(new Error("canonical window changed"), { status: 409 });
		nextPage = () => page([7, 8], 5);
		await mount("n1");
		expect(fetchCalls).toBe(1);
		expect(fetchQueries[0]?.afterSeq).toBeUndefined();
		expect(latest().messages.map((entry) => entry.id)).toEqual(["m-7", "m-8"]);
	});

	for (const status of [401, 403]) {
		test(`warm ${status} clears visible text/cache and never falls back to a tail`, async () => {
			const first = await mount("n1");
			unmount(first);
			await settle();
			fetchCalls = 0;
			locateFailure = Object.assign(new Error("access denied"), { status });
			const second = await mount("n1");
			expect(latest().status).toBe("error");
			expect(latest().messages).toEqual([]);
			expect(latest().index).toBeUndefined();
			expect(latest().error).toBe(locateFailure);
			expect(peekCachedPretextDocument("n1")).toBeNull();
			expect(fetchCalls).toBe(0);
			unmount(second);
			await settle();
			expect(peekCachedPretextDocument("n1")).toBeNull();
		});
	}

	test("a layout-generation change retries within the canonical path, never with an extra tail", async () => {
		const first = await mount("n1");
		unmount(first);
		await settle();
		fetchCalls = 0;
		fetchQueries = [];
		openGate();
		const Harness = makeHarness("n1");
		const second = await mount("n1", Harness);
		contentWidth = 920;
		second.render(createElement(Harness, {}));
		await settle();
		nextPage = () => page([0, 1, 2], 4);
		gate?.release();
		await settle();
		expect(latest().messageVersion).toBe(4);
		expect(latest().messages).toHaveLength(3);
		expect(fetchCalls).toBe(2);
		expect(fetchQueries.every((query) => query.afterSeq === -1)).toBe(true);
	});

	test("unmount cancellation aborts a warm read and never commits or starts a fallback", async () => {
		const first = await mount("n1");
		unmount(first);
		await settle();
		fetchCalls = 0;
		fetchQueries = [];
		openGate();
		const second = await mount("n1");
		const signal = fetchQueries[0]?.signal;
		expect(signal?.aborted).toBe(false);
		unmount(second);
		await settle();
		expect(signal?.aborted).toBe(true);
		nextPage = () => page([0, 1, 2], 4);
		gate?.release();
		await settle();
		expect(fetchCalls).toBe(1);
		expect(peekCachedPretextDocument("n1")?.messageVersion).toBe(3);
	});
	for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		test(`unusable width ${width} preserves a warm snapshot until a real width is available`, async () => {
			const first = await mount("n1");
			unmount(first);
			await settle();
			const cached = peekCachedPretextDocument("n1");
			expect(cached).not.toBeNull();
			fetchCalls = 0;
			contentWidth = width;
			openGate();
			const Harness = makeHarness("n1");
			const root = await mount("n1", Harness);
			expect(latest().status).toBe("idle");
			expect(latest().error).toBeUndefined();
			expect(fetchCalls).toBe(0);
			expect(peekCachedPretextDocument("n1")).toBe(cached);
			contentWidth = 860;
			root.render(createElement(Harness, {}));
			await settle();
			expect(latest().index).toBeDefined();
			expect(latest().messages.map((item) => item.seq)).toEqual([0, 1]);
			expect(fetchCalls).toBe(1);
			gate?.release();
			gate = null;
			await settle();
			expect(latest().status).toBe("ready");
		});
	}

	test("a positive-width parked pane defers cache adoption without destroying its coordinator", async () => {
		const first = await mount("n1");
		unmount(first);
		await settle();
		const cached = peekCachedPretextDocument("n1");
		fetchCalls = 0;
		layoutReady = false;
		openGate();
		const Harness = makeHarness("n1");
		const root = await mount("n1", Harness);
		expect(latest().index).toBeUndefined();
		expect(fetchCalls).toBe(0);
		expect(peekCachedPretextDocument("n1")).toBe(cached);
		layoutReady = true;
		root.render(createElement(Harness, {}));
		await settle();
		expect(latest().messages.map((item) => item.seq)).toEqual([0, 1]);
		expect(latest().index).toBeDefined();
		expect(fetchCalls).toBe(1);
		gate?.release();
		gate = null;
		await settle();
	});

	test("a completed route preload waits for the first usable geometry without a second tail", async () => {
		contentWidth = 0;
		layoutReady = false;
		openGate();
		const preloaded = preloadPretextDocumentTail("n1", LOAD_OPTIONS);
		const Harness = makeHarness("n1");
		const root = await mount("n1", Harness);
		expect(fetchCalls).toBe(1);
		expect(latest().index).toBeUndefined();
		gate?.release();
		gate = null;
		await preloaded;
		await settle();
		expect(latest().status).toBe("idle");
		expect(latest().error).toBeUndefined();
		contentWidth = 860;
		layoutReady = true;
		root.render(createElement(Harness, {}));
		await settle();
		expect(latest().status).toBe("ready");
		expect(fetchCalls).toBe(1);
	});

	test("a mounted coordinator adopts the route's pending preload without a second tail", async () => {
		openGate();
		const preloaded = preloadPretextDocumentTail("n1", {
			...LOAD_OPTIONS,
			firstScreenPageSize: 40,
		});
		await mount("n1");
		expect(fetchCalls).toBe(1);
		gate?.release();
		gate = null;
		await preloaded;
		await settle();
		expect(latest().status).toBe("ready");
		expect(fetchCalls).toBe(1);
	});

	test("cached restoration revalidates from a completed route preload only once", async () => {
		const first = await mount("n1");
		unmount(first);
		await settle();
		fetchCalls = 0;
		nextPage = () => page([0, 1, 2], 4);
		await preloadPretextDocumentTail("n1", LOAD_OPTIONS);
		await mount("n1");
		await settle();
		expect(latest().messageVersion).toBe(4);
		expect(fetchCalls).toBe(1);
	});

	test("an in-page authentication switch retires the previous principal's coordinator", async () => {
		const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		const store = new Map<string, string>();
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => store.set(key, value),
				removeItem: (key: string) => store.delete(key),
			},
		});
		let first: Root | undefined;
		try {
			setToken("principal-a");
			first = await mount("n1");
			expect(latest().messages.map((item) => item.seq)).toEqual([0, 1]);
			openGate();
			nextPage = () => page([7, 8], 5);
			setToken("principal-b");
			await settle();
			expect(latest().messages).toHaveLength(0);
			gate?.release();
			gate = null;
			await settle();
			expect(latest().messages.map((item) => item.seq)).toEqual([7, 8]);
		} finally {
			if (first) unmount(first);
			clearToken();
			if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
			else Reflect.deleteProperty(globalThis, "localStorage");
		}
	});

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
