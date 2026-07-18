import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChunkManifest, ChunkRangeResult, TreeMessage } from "../../lib/api";
import { api } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import type { ChunkMutState } from "./useNarratorChunksWS";

type SequencedChunkUpdater = import("./useNarratorChunks").SequencedChunkUpdater;
let applyChunkUpdaters: typeof import("./useNarratorChunks").applyChunkUpdaters;
let selectChunkUpdaterReplay: typeof import("./useNarratorChunks").selectChunkUpdaterReplay;

const originalGetChunkManifest = api.getChunkManifest;
const originalGetNarratorChunks = api.getNarratorChunks;

let useNarratorChunks: typeof import("./useNarratorChunks").useNarratorChunks;
type HookOptions = {
	scheduleChunkUpdate: (updater: (state: ChunkMutState) => ChunkMutState) => void;
	flushChunkUpdatesSync: (options?: { urgent?: boolean }) => void;
	onStructuralDirty: (mode?: "diff" | "full") => void;
};

type HookResult = {
	chunks: Array<{
		id: string;
		messages?: TreeMessage[];
	}>;
	total: number;
	messageVersion: number;
	loading: boolean;
	hasOlderChunks: boolean;
	loadOlderManifest: () => Promise<number>;
	ensureManifestCoversSeq: (seq: number) => Promise<boolean>;
};

let latestOptions: HookOptions | null = null;
let latestResult: HookResult | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let pendingManifest: Deferred<ChunkManifest> | null = null;
let pendingRange: Deferred<ChunkRangeResult> | null = null;
let restoreDomGlobals: (() => void) | null = null;

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

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
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
			if (descriptor) {
				const current = Object.getOwnPropertyDescriptor(globalThis, key);
				if (current && !current.configurable) {
					if ("writable" in current && current.writable && "value" in descriptor) {
						(globalThis as Record<string, unknown>)[key] = descriptor.value;
					}
				} else {
					Object.defineProperty(globalThis, key, descriptor);
				}
			} else {
				delete (globalThis as Record<string, unknown>)[key];
			}
		}
	};
}

function message(id: string, seq: number): TreeMessage {
	return {
		id,
		narratorId: "n1",
		role: "user",
		parentToolUseId: null,
		contentJson: [],
		contentText: id,
		toolCalls: [],
		children: [],
		createdAt: "2026-07-18T00:00:00.000Z",
		seq,
	} as TreeMessage;
}

const initialManifest: ChunkManifest = {
	unchanged: false,
	messageVersion: 1,
	total: 1,
	windowFirstIndex: 0,
	hasOlderChunks: false,
	chunks: [["c1", 1, 1, 1]],
};
const initialRange: ChunkRangeResult = {
	messages: [message("m1", 1)],
	minSeq: 1,
	maxSeq: 1,
	hasOlder: false,
	hasNewer: false,
	messageVersion: 1,
};
const reconciledManifest: ChunkManifest = {
	unchanged: false,
	messageVersion: 2,
	total: 1,
	windowFirstIndex: 0,
	hasOlderChunks: false,
	chunks: [["c2", 1, 1, 1]],
};
const reconciledRange: ChunkRangeResult = {
	...initialRange,
	messages: [message("m2", 1)],
	messageVersion: 2,
};

function manifest(
	messageVersion: number,
	chunks: Array<[string, number, number, number]>,
	hasOlderChunks = false,
): ChunkManifest {
	return {
		unchanged: false,
		messageVersion,
		total: chunks.reduce((sum, chunk) => sum + chunk[3], 0),
		windowFirstIndex: 0,
		hasOlderChunks,
		chunks,
	};
}

function range(messageVersion: number, messages: TreeMessage[]): ChunkRangeResult {
	return {
		messages,
		minSeq: messages[0]?.seq ?? null,
		maxSeq: messages[messages.length - 1]?.seq ?? null,
		hasOlder: false,
		hasNewer: false,
		messageVersion,
	};
}

function dispatchRealtime(type: string) {
	(
		narratorWSManager as unknown as {
			_dispatchImmediate: (data: Record<string, unknown>) => void;
		}
	)._dispatchImmediate({ type, narratorId: "n1" });
}

function markLoadedMessageText(text: string) {
	return (state: ChunkMutState): ChunkMutState => {
		for (const [chunkId, messages] of state.loaded) {
			if (messages.length === 0) continue;
			const loaded = new Map(state.loaded);
			loaded.set(chunkId, [{ ...messages[0], contentText: text }, ...messages.slice(1)]);
			return { ...state, loaded };
		}
		return state;
	};
}

function markMessageText(messageId: string, text: string) {
	return (state: ChunkMutState): ChunkMutState => {
		for (const [chunkId, messages] of state.loaded) {
			const index = messages.findIndex((item) => item.id === messageId);
			if (index < 0) continue;
			const nextMessages = [...messages];
			nextMessages[index] = { ...nextMessages[index], contentText: text };
			const loaded = new Map(state.loaded);
			loaded.set(chunkId, nextMessages);
			return { ...state, loaded };
		}
		return state;
	};
}

function Harness(): ReactNode {
	latestResult = useNarratorChunks("n1") as HookResult;
	return null;
}

const realChunksWSModule = { ...(await import("./useNarratorChunksWS")) };

// The real WS hook is intentionally replaced: these tests target the structural
// barrier with deterministic API promises, not browser socket behavior.
mock.module("./useNarratorChunksWS", () => ({
	useNarratorChunksWS: (options: HookOptions) => {
		latestOptions = options;
		return { streamingMsg: null, connected: false, disconnected: false, reconnect: () => {} };
	},
}));
({ useNarratorChunks, applyChunkUpdaters, selectChunkUpdaterReplay } = await import(
	"./useNarratorChunks"
));

beforeEach(async () => {
	restoreDomGlobals = installDom();
	narratorWSManager.clearCatchUpState("n1");
	latestOptions = null;
	latestResult = null;
	pendingManifest = null;
	pendingRange = null;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	api.getChunkManifest = async () => pendingManifest?.promise ?? initialManifest;
	api.getNarratorChunks = async () => pendingRange?.promise ?? initialRange;
});

afterEach(async () => {
	root?.unmount();
	root = null;
	// React 19 may leave a scheduler callback queued after unmount. Drain it while
	// the test DOM globals are still installed, then restore the exact descriptors.
	await settle();
	container?.remove();
	container = null;
	api.getChunkManifest = originalGetChunkManifest;
	api.getNarratorChunks = originalGetNarratorChunks;
	narratorWSManager.clearCatchUpState("n1");
	restoreDomGlobals?.();
	restoreDomGlobals = null;
});

afterAll(() => {
	mock.module("./useNarratorChunksWS", () => realChunksWSModule);
	mock.restore();
});

async function settle() {
	for (let turn = 0; turn < 4; turn++) {
		for (let i = 0; i < 6; i++) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function mountHarness() {
	root?.render(createElement(Harness));
	await settle();
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for hook state");
		await new Promise((resolve) => setTimeout(resolve, 5));
		await settle();
	}
}

describe("chunk updater replay checkpoints", () => {
	test("replays only updater sequences after the reconcile checkpoint", () => {
		const base: ChunkMutState = { loaded: new Map(), manifest: [], total: 0 };
		let baselineCalls = 0;
		let incrementalCalls = 0;
		const baseline = (state: ChunkMutState): ChunkMutState => {
			baselineCalls += 1;
			return { ...state, total: state.total + 1 };
		};
		const incremental = (state: ChunkMutState): ChunkMutState => {
			incrementalCalls += 1;
			return { ...state, total: state.total + 10 };
		};
		const log: SequencedChunkUpdater[] = [
			{ seq: 1, updater: baseline },
			{ seq: 2, updater: incremental },
		];

		const replay = selectChunkUpdaterReplay(log, 1);
		const result = applyChunkUpdaters(base, replay.updaters);

		expect(replay.overflowed).toBe(false);
		expect(replay.lastSeq).toBe(2);
		expect(result.total).toBe(10);
		expect(baselineCalls).toBe(0);
		expect(incrementalCalls).toBe(1);
	});

	test("marks a replay log that lost more than 256 required updaters as overflowed", () => {
		const updater = (state: ChunkMutState): ChunkMutState => ({ ...state, total: state.total + 1 });
		const allEntries: SequencedChunkUpdater[] = Array.from({ length: 257 }, (_, index) => ({
			seq: index + 1,
			updater,
		}));
		const boundedEntries = allEntries.slice(1);

		const replay = selectChunkUpdaterReplay(boundedEntries, 0);

		expect(replay.overflowed).toBe(true);
		expect(replay.updaters).toHaveLength(256);
	});

	test("detects a pruned replay tail even when the bounded log is empty", () => {
		const replay = selectChunkUpdaterReplay([], 4, 5);
		expect(replay.overflowed).toBe(true);
		expect(replay.lastSeq).toBe(5);
	});
});

describe("useNarratorChunks initial snapshot recovery", () => {
	test("commits during continuous tool-state events and replays their updater", async () => {
		let manifestCalls = 0;
		let rangeCalls = 0;
		const eventTypes = ["tool_started", "permission_request", "tool_completed"];
		api.getChunkManifest = async () => {
			const eventType = eventTypes[manifestCalls % eventTypes.length];
			manifestCalls += 1;
			latestOptions?.scheduleChunkUpdate(markLoadedMessageText("live-tool-state"));
			dispatchRealtime(eventType);
			return initialManifest;
		};
		api.getNarratorChunks = async () => {
			const eventType = eventTypes[rangeCalls % eventTypes.length];
			rangeCalls += 1;
			dispatchRealtime(eventType);
			return initialRange;
		};

		await mountHarness();
		await waitFor(() => latestResult?.loading === false);

		expect(manifestCalls).toBe(1);
		expect(rangeCalls).toBe(1);
		expect(latestResult?.chunks.map((chunk) => chunk.id)).toEqual(["c1"]);
		expect(latestResult?.chunks[0]?.messages?.[0]?.contentText).toBe("live-tool-state");
		expect(latestResult?.messageVersion).toBe(1);
		expect(narratorWSManager.isMessageReconcilePending("n1")).toBe(false);
	});

	test("falls back to a full reconcile after initial retries are exhausted", async () => {
		let manifestCalls = 0;
		let rangeCalls = 0;
		const recoveredManifest = manifest(10, [["recovered", 1, 1, 1]]);
		const recoveredRange = range(10, [message("recovered-message", 1)]);
		api.getChunkManifest = async () => {
			manifestCalls += 1;
			if (manifestCalls <= 3) {
				return manifest(manifestCalls, [[`stale-${manifestCalls}`, 1, 1, 1]]);
			}
			latestOptions?.scheduleChunkUpdate(markLoadedMessageText("replayed-after-retry"));
			dispatchRealtime("tool_started");
			return recoveredManifest;
		};
		api.getNarratorChunks = async () => {
			rangeCalls += 1;
			if (rangeCalls <= 3) return range(100 + rangeCalls, [message(`stale-${rangeCalls}`, 1)]);
			latestOptions?.scheduleChunkUpdate(markLoadedMessageText("replayed-after-retry"));
			dispatchRealtime("tool_completed");
			return recoveredRange;
		};

		await mountHarness();
		await waitFor(() => latestResult?.messageVersion === 10);

		expect(manifestCalls).toBe(4);
		expect(rangeCalls).toBe(4);
		expect(latestResult?.loading).toBe(false);
		expect(latestResult?.chunks.map((chunk) => chunk.id)).toEqual(["recovered"]);
		expect(latestResult?.chunks[0]?.messages?.map((item) => item.id)).toEqual([
			"recovered-message",
		]);
		expect(latestResult?.chunks[0]?.messages?.[0]?.contentText).toBe("replayed-after-retry");
		expect(narratorWSManager.isMessageReconcilePending("n1")).toBe(false);
	});
});

describe("useNarratorChunks lazy manifest version barriers", () => {
	test("does not prepend a v11 older page onto committed v10 state", async () => {
		const fullManifest = deferred<ChunkManifest>();
		let baseManifestServed = false;
		api.getChunkManifest = async (_narratorId, _sinceVersion, options) => {
			if (options?.beforeSeq != null) return manifest(11, [["older-v11", 1, 1, 1]]);
			if (!baseManifestServed) {
				baseManifestServed = true;
				return manifest(10, [["tail-v10", 2, 2, 1]], true);
			}
			return fullManifest.promise;
		};
		let rangeCalls = 0;
		api.getNarratorChunks = async () => {
			rangeCalls += 1;
			if (rangeCalls === 1) return range(10, [message("tail-message-v10", 2)]);
			return range(11, [message("older-message-v11", 1), message("tail-message-v11", 2)]);
		};

		await mountHarness();
		expect(latestResult?.messageVersion).toBe(10);

		const prepended = await latestResult?.loadOlderManifest();
		await settle();

		expect(prepended).toBe(0);
		expect(latestResult?.messageVersion).toBe(10);
		expect(latestResult?.chunks.map((chunk) => chunk.id)).toEqual(["tail-v10"]);

		fullManifest.resolve(
			manifest(11, [
				["older-v11", 1, 1, 1],
				["tail-v11", 2, 2, 1],
			]),
		);
		await waitFor(() => latestResult?.messageVersion === 11);

		expect(latestResult?.chunks.map((chunk) => chunk.id)).toEqual(["older-v11", "tail-v11"]);
		expect(
			latestResult?.chunks.flatMap((chunk) => chunk.messages ?? []).map((item) => item.id),
		).toEqual(["older-message-v11", "tail-message-v11"]);
	});

	test("aborts a deep jump when its manifest drifts from committed version", async () => {
		const fullManifest = deferred<ChunkManifest>();
		let baseManifestServed = false;
		api.getChunkManifest = async (_narratorId, _sinceVersion, options) => {
			if (options?.beforeSeq != null) return manifest(11, [["deep-v11", 1, 20, 1]]);
			if (!baseManifestServed) {
				baseManifestServed = true;
				return manifest(10, [["tail-v10", 101, 101, 1]], true);
			}
			return fullManifest.promise;
		};
		let rangeCalls = 0;
		api.getNarratorChunks = async () => {
			rangeCalls += 1;
			if (rangeCalls === 1) return range(10, [message("tail-message-v10", 101)]);
			return range(11, [message("deep-message-v11", 5), message("tail-message-v11", 101)]);
		};

		await mountHarness();
		const covered = await latestResult?.ensureManifestCoversSeq(5);
		await settle();

		expect(covered).toBe(false);
		expect(latestResult?.messageVersion).toBe(10);
		expect(latestResult?.chunks.map((chunk) => chunk.id)).toEqual(["tail-v10"]);

		fullManifest.resolve(
			manifest(11, [
				["deep-v11", 1, 20, 1],
				["tail-v11", 101, 101, 1],
			]),
		);
		await waitFor(() => latestResult?.messageVersion === 11);

		expect(latestResult?.chunks.map((chunk) => chunk.id)).toEqual(["deep-v11", "tail-v11"]);
		expect(
			latestResult?.chunks.flatMap((chunk) => chunk.messages ?? []).map((item) => item.id),
		).toEqual(["deep-message-v11", "tail-message-v11"]);
	});

	test("merges concurrent scroll and deep-jump extensions when responses return in reverse", async () => {
		const scrollManifest = deferred<ChunkManifest>();
		const deepManifest = deferred<ChunkManifest>();
		const scrollRange = deferred<ChunkRangeResult>();
		const deepRange = deferred<ChunkRangeResult>();
		let initialManifestServed = false;
		let extensionManifestCalls = 0;
		api.getChunkManifest = async (_narratorId, _sinceVersion, options) => {
			if (options?.beforeSeq == null) {
				if (initialManifestServed) throw new Error("unexpected reconcile");
				initialManifestServed = true;
				return manifest(10, [["tail", 101, 120, 1]], true);
			}
			extensionManifestCalls += 1;
			return options.limitChunks === 200 ? deepManifest.promise : scrollManifest.promise;
		};
		api.getNarratorChunks = async (_narratorId, options) => {
			if (!options) throw new Error("missing range options");
			if (options.direction === "older") return range(10, [message("tail-message", 101)]);
			if (options.fromSeq === 0) return deepRange.promise;
			if (options.fromSeq === 80) return scrollRange.promise;
			throw new Error(`unexpected range fromSeq ${options.fromSeq}`);
		};

		await mountHarness();
		const scroll = latestResult?.loadOlderManifest() ?? Promise.resolve(0);
		const jump = latestResult?.ensureManifestCoversSeq(5) ?? Promise.resolve(false);
		await waitFor(() => extensionManifestCalls === 2);

		deepManifest.resolve(
			manifest(
				10,
				[
					["deep", 1, 20, 1],
					["middle", 21, 80, 1],
					["scroll", 81, 100, 1],
				],
				false,
			),
		);
		deepRange.resolve(
			range(10, [
				message("deep-message", 5),
				message("middle-message", 25),
				message("scroll-message", 85),
			]),
		);
		expect(await jump).toBe(true);

		// The shallower scroll response returns last. It must not replace the deep
		// window or reopen hasOlderChunks after the deep request reached history start.
		scrollManifest.resolve(manifest(10, [["scroll", 81, 100, 1]], true));
		scrollRange.resolve(range(10, [message("scroll-message", 85)]));
		expect(await scroll).toBe(0);
		await settle();

		expect(latestResult?.chunks.map((chunk) => chunk.id)).toEqual([
			"deep",
			"middle",
			"scroll",
			"tail",
		]);
		expect(latestResult?.hasOlderChunks).toBe(false);
		expect(
			latestResult?.chunks.flatMap((chunk) => chunk.messages ?? []).map((item) => item.id),
		).toEqual(["deep-message", "middle-message", "scroll-message", "tail-message"]);
	});

	test("rejects a lazy extension when the manager committed version advances", async () => {
		const olderManifest = deferred<ChunkManifest>();
		let baseManifestServed = false;
		let olderRequested = false;
		api.getChunkManifest = async (_narratorId, _sinceVersion, options) => {
			if (options?.beforeSeq != null) {
				olderRequested = true;
				return olderManifest.promise;
			}
			if (!baseManifestServed) {
				baseManifestServed = true;
				return manifest(10, [["tail-v10", 2, 2, 1]], true);
			}
			return manifest(11, [
				["older-v11", 1, 1, 1],
				["tail-v11", 2, 2, 1],
			]);
		};
		api.getNarratorChunks = async (_narratorId, options) => {
			if (!options) throw new Error("missing range options");
			return options.direction === "older"
				? range(10, [message("tail-message-v10", 2)])
				: range(11, [message("older-message-v11", 1), message("tail-message-v11", 2)]);
		};

		await mountHarness();
		const load = latestResult?.loadOlderManifest() ?? Promise.resolve(0);
		await waitFor(() => olderRequested);
		narratorWSManager.updateMessageVersion("n1", 11);
		olderManifest.resolve(manifest(10, [["older-v10", 1, 1, 1]]));

		expect(await load).toBe(0);
		await waitFor(() => latestResult?.messageVersion === 11);
		expect(latestResult?.chunks.map((chunk) => chunk.id)).toEqual(["older-v11", "tail-v11"]);
		expect(latestResult?.chunks.some((chunk) => chunk.id === "older-v10")).toBe(false);
	});

	test("does not publish stale chunk content after a request-time realtime updater", async () => {
		const staleRange = deferred<ChunkRangeResult>();
		let baseManifestServed = false;
		let rangeCalls = 0;
		api.getChunkManifest = async (_narratorId, _sinceVersion, options) => {
			if (options?.beforeSeq != null) return manifest(10, [["older", 1, 1, 1]]);
			if (!baseManifestServed) {
				baseManifestServed = true;
				return manifest(10, [["tail", 2, 2, 1]], true);
			}
			throw new Error("unexpected reconcile");
		};
		api.getNarratorChunks = async (_narratorId, options) => {
			if (!options) throw new Error("missing range options");
			rangeCalls += 1;
			if (options.direction === "older") return range(10, [message("tail-message", 2)]);
			if (rangeCalls === 2) return staleRange.promise;
			const fresh = message("older-message", 1);
			fresh.contentText = "fresh-live-state";
			return range(10, [fresh]);
		};

		await mountHarness();
		const firstLoad = latestResult?.loadOlderManifest() ?? Promise.resolve(0);
		await waitFor(() => rangeCalls === 2);
		latestOptions?.scheduleChunkUpdate(markMessageText("older-message", "request-time-live-state"));
		dispatchRealtime("tool_started");
		staleRange.resolve(range(10, [message("older-message", 1)]));

		expect(await firstLoad).toBe(0);
		await settle();
		expect(latestResult?.chunks.map((chunk) => chunk.id)).toEqual(["tail"]);

		expect(await latestResult?.loadOlderManifest()).toBe(1);
		await settle();
		expect(latestResult?.chunks.map((chunk) => chunk.id)).toEqual(["older", "tail"]);
		expect(latestResult?.chunks[0]?.messages?.[0]?.contentText).toBe("fresh-live-state");
	});
});

describe("useNarratorChunks structural barrier", () => {
	test("replays an updater that was still queued when reconcile started", async () => {
		await mountHarness();
		pendingManifest = deferred<ChunkManifest>();
		pendingRange = deferred<ChunkRangeResult>();

		latestOptions?.scheduleChunkUpdate((state: ChunkMutState) => ({
			...state,
			total: state.total + 5,
		}));
		latestOptions?.onStructuralDirty("diff");
		pendingManifest?.resolve(reconciledManifest);
		await settle();
		pendingRange?.resolve(reconciledRange);
		await settle();

		expect(latestResult?.total).toBe(6);
		expect(narratorWSManager.isMessageReconcilePending("n1")).toBe(false);
	});

	test("does not replay an updater already represented before reconcile", async () => {
		await mountHarness();
		latestOptions?.scheduleChunkUpdate((state: ChunkMutState) => ({
			...state,
			total: state.total + 5,
		}));
		latestOptions?.flushChunkUpdatesSync({ urgent: true });
		await settle();
		expect(latestResult?.total).toBe(6);

		pendingManifest = deferred<ChunkManifest>();
		pendingRange = deferred<ChunkRangeResult>();
		latestOptions?.onStructuralDirty("diff");
		pendingManifest.resolve(reconciledManifest);
		await settle();
		pendingRange.resolve(reconciledRange);
		await settle();

		expect(latestResult?.total).toBe(1);
	});

	test("does not rerun a Date.now updater queued through a transition", async () => {
		await mountHarness();
		const stamps: number[] = [];
		latestOptions?.scheduleChunkUpdate((state: ChunkMutState) => {
			stamps.push(Date.now());
			return { ...state, total: state.total + 1 };
		});
		latestOptions?.flushChunkUpdatesSync();

		pendingManifest = deferred<ChunkManifest>();
		pendingRange = deferred<ChunkRangeResult>();
		latestOptions?.onStructuralDirty("diff");
		pendingManifest.resolve(reconciledManifest);
		pendingRange.resolve(reconciledRange);
		await settle();

		expect(stamps).toHaveLength(1);
		expect(latestResult?.messageVersion).toBe(2);
	});

	test("does not reapply a baseline updater on an unchanged manifest", async () => {
		await mountHarness();
		let calls = 0;
		latestOptions?.scheduleChunkUpdate((state: ChunkMutState) => {
			calls += 1;
			return { ...state, total: state.total + Date.now() * 0 + 1 };
		});
		latestOptions?.flushChunkUpdatesSync({ urgent: true });
		await settle();
		expect(calls).toBe(1);

		pendingManifest = deferred<ChunkManifest>();
		latestOptions?.onStructuralDirty("diff");
		pendingManifest.resolve({ unchanged: true, messageVersion: 1 });
		await settle();

		expect(calls).toBe(1);
		expect(latestResult?.total).toBe(2);
		expect(latestResult?.messageVersion).toBe(1);
	});

	test("does not rerun a request-time Date.now updater on an unchanged response", async () => {
		await mountHarness();
		pendingManifest = deferred<ChunkManifest>();
		const stamps: number[] = [];
		latestOptions?.onStructuralDirty("diff");
		latestOptions?.scheduleChunkUpdate((state: ChunkMutState) => {
			stamps.push(Date.now());
			return { ...state, total: state.total + 1 };
		});
		pendingManifest.resolve({ unchanged: true, messageVersion: 1 });
		await settle();

		expect(stamps).toHaveLength(1);
		expect(latestResult?.total).toBe(2);
		expect(latestResult?.messageVersion).toBe(1);
	});

	test("does not rerun a request-time Date.now updater on a clean coordinate commit", async () => {
		await mountHarness();
		pendingManifest = deferred<ChunkManifest>();
		const stamps: number[] = [];
		latestOptions?.onStructuralDirty("diff");
		latestOptions?.scheduleChunkUpdate((state: ChunkMutState) => {
			stamps.push(Date.now());
			return { ...state, total: state.total + 1 };
		});
		pendingManifest.resolve(manifest(1, [["c1", 1, 1, 1]]));
		await settle();

		expect(stamps).toHaveLength(1);
		expect(latestResult?.total).toBe(2);
		expect(latestResult?.chunks.map((chunk) => chunk.id)).toEqual(["c1"]);
	});

	test("advances the replay checkpoint before the next successful reconcile", async () => {
		await mountHarness();
		const firstManifest = deferred<ChunkManifest>();
		const firstRange = deferred<ChunkRangeResult>();
		const secondManifest = deferred<ChunkManifest>();
		const secondRange = deferred<ChunkRangeResult>();
		const sinceVersions: Array<number | undefined> = [];
		let manifestCalls = 0;
		let rangeCalls = 0;
		api.getChunkManifest = async (_narratorId, sinceVersion) => {
			sinceVersions.push(sinceVersion);
			manifestCalls += 1;
			if (manifestCalls === 1) return firstManifest.promise;
			if (manifestCalls === 2) return secondManifest.promise;
			return manifest(99, [["unexpected-full", 1, 1, 1]]);
		};
		api.getNarratorChunks = async () => {
			rangeCalls += 1;
			if (rangeCalls === 1) return firstRange.promise;
			if (rangeCalls === 2) return secondRange.promise;
			return range(99, [message("unexpected-full-message", 1)]);
		};

		latestOptions?.onStructuralDirty("diff");
		latestOptions?.scheduleChunkUpdate((state: ChunkMutState) => ({
			...state,
			total: state.total + 1,
		}));
		firstManifest.resolve(manifest(2, [["c2", 1, 1, 1]]));
		firstRange.resolve(range(2, [message("m2", 1)]));
		await waitFor(() => latestResult?.messageVersion === 2);

		latestOptions?.onStructuralDirty("diff");
		latestOptions?.scheduleChunkUpdate((state: ChunkMutState) => ({
			...state,
			total: state.total + 10,
		}));
		secondManifest.resolve(manifest(3, [["c3", 1, 1, 1]]));
		secondRange.resolve(range(3, [message("m3", 1)]));
		await waitFor(() => (latestResult?.messageVersion ?? 0) >= 3);

		expect(latestResult?.messageVersion).toBe(3);
		expect(latestResult?.total).toBe(11);
		expect(manifestCalls).toBe(2);
		expect(sinceVersions).toEqual([1, 2]);
		expect(narratorWSManager.isMessageReconcilePending("n1")).toBe(false);
	});

	test("abandons incremental replay and requests an authoritative full reload after overflow", async () => {
		let manifestCalls = 0;
		let rangeCalls = 0;
		const sinceVersions: Array<number | undefined> = [];
		const diffManifest = deferred<ChunkManifest>();
		const diffRange = deferred<ChunkRangeResult>();
		api.getChunkManifest = async (_narratorId, sinceVersion) => {
			manifestCalls += 1;
			sinceVersions.push(sinceVersion);
			if (manifestCalls === 1) return initialManifest;
			if (manifestCalls === 2) return diffManifest.promise;
			return manifest(3, [["full", 1, 1, 1]]);
		};
		api.getNarratorChunks = async () => {
			rangeCalls += 1;
			if (rangeCalls === 1) return initialRange;
			if (rangeCalls === 2) return diffRange.promise;
			return range(3, [message("full-message", 1)]);
		};

		await mountHarness();
		pendingManifest = diffManifest;
		pendingRange = diffRange;
		latestOptions?.onStructuralDirty("diff");
		await Promise.resolve();
		for (let i = 0; i < 257; i++) {
			latestOptions?.scheduleChunkUpdate((state: ChunkMutState) => ({
				...state,
				total: state.total + 1,
			}));
		}
		diffManifest.resolve(reconciledManifest);
		await settle();
		diffRange.resolve(reconciledRange);
		await waitFor(() => manifestCalls >= 3 && latestResult?.messageVersion === 3, 2_000);

		expect(sinceVersions.filter((version) => version === undefined).length).toBeGreaterThanOrEqual(
			2,
		);
		expect(latestResult?.chunks.map((chunk) => chunk.id)).toEqual(["full"]);
	});

	test("clears pending reconcile when the component unmounts", async () => {
		await mountHarness();
		pendingManifest = deferred<ChunkManifest>();
		latestOptions?.onStructuralDirty("diff");
		await Promise.resolve();
		expect(narratorWSManager.isMessageReconcilePending("n1")).toBe(true);

		root?.unmount();
		root = null;
		expect(narratorWSManager.isMessageReconcilePending("n1")).toBe(false);
		pendingManifest.resolve(reconciledManifest);
		await settle();
		expect(narratorWSManager.isMessageReconcilePending("n1")).toBe(false);
	});
});
