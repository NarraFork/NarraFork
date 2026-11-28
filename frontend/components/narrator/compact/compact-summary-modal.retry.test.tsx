import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { CompactMessageDetail } from "@shared/compact-message";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { ApiError, api } from "../../../lib/api";
import type { RetryFailedCompactResponse } from "../../../lib/api/narrators";
import type { CompactLiveStreamEvent } from "../../../lib/compact-live-stream";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import narratorLocale from "../../../locales/en/narrator.json";

const testI18n = i18next.createInstance();
await testI18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	defaultNS: "narrator",
	ns: ["narrator"],
	resources: { en: { narrator: narratorLocale } },
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});
const i18nModule = () => ({
	supportedLanguages: ["en", "zh-CN"],
	namespaces: ["narrator"],
	normalizeLanguage: (language: string | null | undefined) => language ?? "en",
	getNamespacesForPath: () => ["narrator"],
	getInitialNamespaces: () => ["narrator"],
	ensureI18nNamespaces: async () => {},
	changeAppLanguage: async () => testI18n,
	initI18n: async () => testI18n,
	default: testI18n,
});
mock.module("../../../lib/i18n", i18nModule);
mock.module("@frontend/lib/i18n", i18nModule);

const realUseModels = { ...(await import("../../../hooks/useModels")) };
mock.module("../../../hooks/useModels", () => ({
	...realUseModels,
	useAllModels: () => ({
		visibleModels: [
			{ value: "provider:model", label: "Model", provider: "provider" },
			{ value: "other:model", label: "Model", provider: "other" },
		],
		providerLabels: { provider: "Provider A", other: "Provider B" },
		summaryModelValue: "provider:model",
	}),
}));

const {
	CompactSummaryModal,
	compactSummaryQueryKey,
	resolveCompactReplacementEvent,
	resolveCompactRetryTargetMigration,
} = await import("./compact-summary-modal");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;

const originalApi = {
	getCompactSummary: api.getCompactSummary,
	getSegmentCompactSummary: api.getSegmentCompactSummary,
	retryFailedCompact: api.retryFailedCompact,
	streamCompactSummary: api.streamCompactSummary,
};

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const localStorage = new Map<string, string>();
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	class TestMouseEvent extends window.Event {
		clientX: number;
		clientY: number;

		constructor(type: string, init: MouseEventInit = {}) {
			super(type, init);
			this.clientX = init.clientX ?? 0;
			this.clientY = init.clientY ?? 0;
		}
	}
	Object.assign(window, {
		ResizeObserver: TestResizeObserver,
		MouseEvent: TestMouseEvent,
		innerWidth: 1280,
		innerHeight: 720,
		matchMedia,
		getSelection: () => ({ rangeCount: 0, isCollapsed: true, removeAllRanges() {} }),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		localStorage: {
			getItem: (key: string) => localStorage.get(key) ?? null,
			setItem: (key: string, value: string) => localStorage.set(key, value),
			removeItem: (key: string) => localStorage.delete(key),
			clear: () => localStorage.clear(),
		},
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent,
		Document: window.Document,
		ShadowRoot: window.ShadowRoot,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		HTMLInputElement: window.HTMLInputElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		getComputedStyle:
			window.getComputedStyle?.bind(window) ??
			(() => ({
				getPropertyValue: () => "",
			})),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

function failedDetail(): CompactMessageDetail {
	return {
		status: "failed",
		summary: "",
		error: "first compact failed",
		attempts: [
			{
				attempt: 1,
				model: "provider:model",
				status: "failed",
				startedAt: "2026-07-18T00:00:00.000Z",
				finishedAt: "2026-07-18T00:00:01.000Z",
				error: "first compact failed",
			},
		],
		canRetry: true,
	};
}

function completedDetail(summary: string): CompactMessageDetail {
	return {
		status: "compacted",
		summary,
		attempts: [],
		canRetry: false,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function runningDetail(overrides: Partial<CompactMessageDetail> = {}): CompactMessageDetail {
	return {
		status: "compacting",
		summary: "",
		attempts: [],
		attempt: 1,
		model: "provider:model",
		canChangeModel: false,
		streamVersion: 1,
		...overrides,
	};
}

function liveTransport() {
	const connections: {
		signal?: AbortSignal;
		offsets: { output: number; thinking: number; streamVersion?: number };
		disconnect: () => void;
		send: (...events: CompactLiveStreamEvent[]) => void;
	}[] = [];
	api.streamCompactSummary = async (_narratorId, _messageId, offsets, signal) =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					connections.push({
						signal,
						offsets,
						disconnect: () => controller.close(),
						send: (...events) =>
							controller.enqueue(
								new TextEncoder().encode(
									events
										.map((event) => `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)
										.join(""),
								),
							),
					});
				},
			}),
		);
	return connections;
}

const reset = (streamVersion: number): CompactLiveStreamEvent => ({
	kind: "reset",
	streamVersion,
	outputLength: 0,
	thinkingLength: 0,
	outputChars: 0,
	thinkingChars: 0,
});

function modelPicker() {
	return document.body.querySelector<HTMLButtonElement>(
		`button[aria-label="${narratorLocale.compactRetryModel}"]`,
	);
}

async function settle() {
	for (let turn = 0; turn < 4; turn++) {
		await act(async () => {
			for (let microtask = 0; microtask < 4; microtask++) await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

async function dispatchNarratorWs(data: Record<string, unknown>) {
	await act(async () => {
		(
			narratorWSManager as unknown as {
				_dispatchImmediate: (event: Record<string, unknown>) => void;
			}
		)._dispatchImmediate(data);
		await Promise.resolve();
	});
}

function retryButton(): HTMLButtonElement {
	const button = Array.from(document.body.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes("Retry compaction"),
	);
	if (!(button instanceof HTMLButtonElement)) throw new Error("retry button not found");
	return button;
}

async function renderModal(opts: {
	kind?: "context" | "segment";
	messageId?: string;
	onDelete?: () => void;
	onClose?: () => void;
	initialDetail?: CompactMessageDetail;
}) {
	if (!root || !queryClient) throw new Error("test harness is not initialized");
	const currentRoot = root;
	const currentQueryClient = queryClient;
	const kind = opts.kind ?? "context";
	const messageId = opts.messageId ?? "compact-old";
	currentQueryClient.setQueryData(
		compactSummaryQueryKey("narrator-1", messageId, kind),
		opts.initialDetail ?? failedDetail(),
	);
	function ControlledModal() {
		const [open, setOpen] = useState(true);
		return (
			<CompactSummaryModal
				target={
					open ? { kind, narratorId: "narrator-1", messageId, onDelete: opts.onDelete } : null
				}
				onClose={() => {
					setOpen(false);
					opts.onClose?.();
				}}
			/>
		);
	}
	await act(async () => {
		currentRoot.render(
			<I18nextProvider i18n={testI18n}>
				<MantineProvider
					env="test"
					theme={{
						components: {
							Modal: { defaultProps: { transitionProps: { duration: 0 } } },
							Menu: { defaultProps: { transitionProps: { duration: 0 } } },
						},
					}}
				>
					<QueryClientProvider client={currentQueryClient}>
						<ControlledModal />
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		);
	});
	await settle();
}

async function clickRetry() {
	await act(async () => {
		retryButton().dispatchEvent(new Event("click", { bubbles: true }));
		await Promise.resolve();
	});
	await settle();
}

async function chooseSessionModel() {
	const trigger = document.body.querySelector<HTMLButtonElement>(
		`button[aria-label="${narratorLocale.compactRetryModel}"]`,
	);
	if (!trigger) throw new Error("model picker trigger not found");
	await act(async () => trigger.click());
	await settle();
	const sessionModel = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
		(button) => button.textContent === narratorLocale.compactUseSessionModel,
	);
	if (!sessionModel) throw new Error("session model option not found");
	await act(async () => sessionModel.click());
	await settle();
	return trigger;
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY, refetchOnMount: false },
			mutations: { retry: false },
		},
	});
	const unexpectedRequest = async () => {
		throw new Error("Unexpected compact request in modal test");
	};
	api.getCompactSummary = unexpectedRequest;
	api.getSegmentCompactSummary = unexpectedRequest;
	api.retryFailedCompact = unexpectedRequest;
	api.streamCompactSummary = async () => new Response(null, { status: 409 });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	Object.assign(api, originalApi);
	queryClient?.clear();
	container?.remove();
	root = undefined;
	queryClient = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("../../../lib/i18n", i18nModule);
	mock.module("@frontend/lib/i18n", i18nModule);
	mock.module("../../../hooks/useModels", () => realUseModels);
	mock.restore();
});

describe("CompactSummaryModal live output and retry", () => {
	test("ignores a queued response when the stream already switched to that model", async () => {
		const retry = deferred<RetryFailedCompactResponse>();
		api.retryFailedCompact = async () => retry.promise;
		api.streamCompactSummary = async () => new Response(new ReadableStream<Uint8Array>());
		await renderModal({
			initialDetail: {
				status: "compacting",
				summary: "",
				model: "provider:model",
				attempt: 2,
				attempts: [],
				canChangeModel: true,
			},
		});
		await chooseSessionModel();
		await dispatchNarratorWs({
			type: "compact_progress",
			narratorId: "narrator-1",
			messageId: "compact-old",
			attempt: 2,
			model: "other:model",
			pendingModel: null,
			canChangeModel: true,
		});
		await dispatchNarratorWs({
			type: "compact_progress",
			narratorId: "narrator-1",
			messageId: "compact-old",
			attempt: 1,
			model: "provider:model",
			pendingModel: "other:model",
			canChangeModel: true,
		});
		retry.resolve({
			ok: true,
			messageId: "compact-old",
			queued: true,
			pendingModel: "other:model",
		});
		await settle();
		expect(document.body.textContent).toContain("Model: other:model");
		expect(document.body.textContent).not.toContain("If this request fails, retry with Provider B");
	});

	test.each([
		"context",
		"segment",
	] as const)("%s compaction queues the session model and shows its first output", async (kind) => {
		let output!: ReadableStreamDefaultController<Uint8Array>;
		const requests: unknown[][] = [];
		const connections: unknown[][] = [];
		api.streamCompactSummary = async (narratorId, messageId, offsets) => {
			connections.push([narratorId, messageId, offsets]);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						output = controller;
					},
				}),
			);
		};
		api.retryFailedCompact = async (...args) => {
			requests.push(args);
			return { ok: true, messageId: "compact-old", queued: true, pendingModel: "other:model" };
		};
		let terminal = false;
		api.getCompactSummary = async () =>
			terminal ? failedDetail() : { ...initial, streamVersion: 1 };
		api.getSegmentCompactSummary = async () =>
			terminal ? { ...failedDetail(), canRetry: false } : { ...initial, streamVersion: 1 };
		const initial: CompactMessageDetail = {
			status: "compacting",
			summary: "",
			model: "provider:model",
			attempts: [],
			attempt: kind === "context" ? 2 : undefined,
			canChangeModel: true,
			streamVersion: 0,
		};
		await renderModal({ initialDetail: initial, kind });
		expect(connections).toEqual([
			["narrator-1", "compact-old", { output: 0, thinking: 0, streamVersion: 0 }],
		]);
		expect(document.body.textContent).toContain(narratorLocale.compactWaitingForOutput);
		const trigger = await chooseSessionModel();
		expect(requests).toEqual([
			[
				"narrator-1",
				"compact-old",
				kind === "context"
					? { useSessionModel: true, expectedAttempt: 2 }
					: { useSessionModel: true },
			],
		]);
		expect(document.body.textContent).toContain(
			"If this request fails, retry with Provider B · Model.",
		);
		const encoder = new TextEncoder();
		await act(async () => {
			output.enqueue(
				encoder.encode(
					`event: delta\ndata: ${JSON.stringify({
						kind: "delta",
						channel: "output",
						delta: "first live text",
						outputChars: 15,
						thinkingChars: 0,
					})}\n\n`,
				),
			);
		});
		await settle();
		expect(document.body.textContent).toContain("first live text");
		await dispatchNarratorWs({
			type: "compact_progress",
			narratorId: "narrator-1",
			messageId: "compact-old",
			canChangeModel: false,
			outputChars: 15,
			thinkingChars: 0,
		});
		await settle();
		expect(document.body.contains(trigger)).toBe(false);
		await act(async () => {
			output.enqueue(
				encoder.encode(
					`event: reset\ndata: ${JSON.stringify({
						kind: "reset",
						streamVersion: 1,
						outputLength: 0,
						thinkingLength: 0,
						outputChars: 0,
						thinkingChars: 0,
					})}\n\n`,
				),
			);
		});
		await settle();
		expect(document.body.textContent).not.toContain("first live text");
		terminal = true;
		await act(async () => {
			output.enqueue(
				encoder.encode('event: finished\ndata: {"kind":"finished","status":"failed"}\n\n'),
			);
		});
		await settle();
		expect(document.body.textContent).toContain("first compact failed");
		expect(document.body.textContent?.includes(narratorLocale.compactRetryModel)).toBe(
			kind === "context",
		);
	});

	test.each([
		"context",
		"segment",
	] as const)("%s uses live retry metadata when WS is unavailable, without rolling back new SSE text", async (kind) => {
		const streams = liveTransport();
		const reads: ReturnType<typeof deferred<CompactMessageDetail>>[] = [];
		const read = async () => {
			const result = deferred<CompactMessageDetail>();
			reads.push(result);
			return result.promise;
		};
		if (kind === "context") api.getCompactSummary = read;
		else api.getSegmentCompactSummary = read;
		const now = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(now);
		try {
			await renderModal({
				kind,
				initialDetail: runningDetail({ output: "discarded draft", outputChars: 15 }),
			});
			expect(narratorWSManager.connected).toBe(false);
			expect(modelPicker()).toBeNull();
			await act(async () => streams[0].send(reset(2)));
			await settle();
			expect(reads).toHaveLength(1);
			const waiting = runningDetail({
				streamVersion: 2,
				model: "other:model",
				pendingModel: "provider:model",
				canChangeModel: true,
			});
			reads[0].resolve(waiting);
			await settle();
			expect(modelPicker()).not.toBeNull();
			expect(document.body.textContent).toContain(narratorLocale.compactWaitingForOutput);
			expect(document.body.textContent).toContain("Model: other:model");
			expect(document.body.textContent).toContain("If this request fails, retry with Provider A");
			expect(document.body.textContent).not.toContain("discarded draft");

			clock.mockReturnValue(now + 15_000);
			await act(async () =>
				streams[0].send({ kind: "heartbeat", outputChars: 0, thinkingChars: 0 }),
			);
			expect(reads).toHaveLength(2);
			await act(async () =>
				streams[0].send(
					{
						kind: "delta",
						channel: "thinking",
						delta: "live thought",
						outputChars: 0,
						thinkingChars: 12,
					},
					{
						kind: "delta",
						channel: "output",
						delta: "live answer",
						outputChars: 11,
						thinkingChars: 12,
					},
				),
			);
			await settle();
			expect(modelPicker()).toBeNull();
			reads[1].resolve(waiting);
			await settle();
			expect(modelPicker()).toBeNull();
			expect(document.body.textContent).toContain("live thought");
			expect(document.body.textContent).toContain("live answer");
			expect(
				queryClient?.getQueryData<CompactMessageDetail>(
					compactSummaryQueryKey("narrator-1", "compact-old", kind),
				),
			).toMatchObject({ streamVersion: 2, outputChars: 11, thinkingChars: 12 });
			expect(streams).toHaveLength(1);
		} finally {
			clock.mockRestore();
		}
	});

	test("coalesces a burst of resets around a slow read and never restores retired state", async () => {
		const streams = liveTransport();
		const reads: ReturnType<typeof deferred<CompactMessageDetail>>[] = [];
		api.getCompactSummary = async () => {
			const result = deferred<CompactMessageDetail>();
			reads.push(result);
			return result.promise;
		};
		const now = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(now);
		try {
			await renderModal({ initialDetail: runningDetail() });
			await act(async () => streams[0].send(...Array.from({ length: 20 }, (_, i) => reset(i + 2))));
			await settle();
			expect(reads).toHaveLength(1);
			clock.mockReturnValue(now + 2_000);
			reads[0].resolve(
				runningDetail({ streamVersion: 2, model: "retired:model", canChangeModel: true }),
			);
			await settle();
			expect(reads).toHaveLength(2);
			expect(document.body.textContent).not.toContain("retired:model");
			expect(modelPicker()).toBeNull();
			await dispatchNarratorWs({
				type: "compact_progress",
				narratorId: "narrator-1",
				messageId: "compact-old",
				attempt: 1,
				model: "other:model",
				pendingModel: "provider:model",
				canChangeModel: true,
			});
			reads[1].resolve(runningDetail({ streamVersion: 21 }));
			await settle();
			expect(document.body.textContent).toContain("Model: other:model");
			expect(document.body.textContent).toContain("If this request fails, retry with Provider A");
			expect(modelPicker()).not.toBeNull();
			expect(reads).toHaveLength(2);
			expect(streams).toHaveLength(1);
		} finally {
			clock.mockRestore();
		}
	});

	test("an ordinary WS deletion closes only the current target and aborts its live and detail reads", async () => {
		const streams = liveTransport();
		const slowRead = deferred<CompactMessageDetail>();
		const detailReads: (AbortSignal | undefined)[] = [];
		api.getCompactSummary = async (_narratorId, _messageId, signal) => {
			detailReads.push(signal);
			return slowRead.promise;
		};
		const onClose = mock(() => {});
		const onDelete = mock(() => {});
		await renderModal({ initialDetail: runningDetail(), onClose, onDelete });
		await act(async () => streams[0].send(reset(2)));
		await dispatchNarratorWs({
			type: "messages_deleted",
			narratorId: "other-narrator",
			deletedMessageIds: ["compact-old"],
		});
		await dispatchNarratorWs({
			type: "messages_deleted",
			narratorId: "narrator-1",
			deletedMessageIds: ["other-marker"],
		});
		expect(onClose).not.toHaveBeenCalled();
		expect(detailReads).toHaveLength(1);
		expect(detailReads[0]?.aborted).toBe(false);
		const deletion = {
			type: "messages_deleted",
			narratorId: "narrator-1",
			deletedMessageIds: ["compact-old"],
		};
		await dispatchNarratorWs(deletion);
		await dispatchNarratorWs(deletion);
		slowRead.resolve(runningDetail({ streamVersion: 2, output: "discard this late response" }));
		await settle();
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(document.body.querySelector("[data-compact-summary-scroll]")).toBeNull();
		expect(streams[0].signal?.aborted).toBe(true);
		expect(detailReads[0]?.aborted).toBe(true);
		expect(
			queryClient?.getQueryState(compactSummaryQueryKey("narrator-1", "compact-old")),
		).toBeUndefined();
		expect(streams).toHaveLength(1);
		expect(detailReads).toHaveLength(1);
	});

	test.each([
		"finished",
		"conflict",
	])("a missed deletion followed by %s and an authoritative 404 never reconnects", async (ending) => {
		const streams = liveTransport();
		const conflict = mock(async () => new Response(null, { status: 409 }));
		if (ending === "conflict") api.streamCompactSummary = conflict;
		const read = mock(async () => {
			throw new ApiError("Marker no longer exists", 404);
		});
		api.getCompactSummary = read;
		const timers = spyOn(globalThis, "setTimeout");
		const onClose = mock(() => {});
		try {
			await renderModal({ initialDetail: runningDetail(), onClose });
			if (ending === "finished") {
				await act(async () => streams[0].send({ kind: "finished", status: "failed" }));
				await settle();
			}
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(read).toHaveBeenCalledTimes(1);
			expect(ending === "finished" ? streams.length : conflict.mock.calls.length).toBe(1);
			expect(document.body.querySelector("[data-compact-summary-scroll]")).toBeNull();
			expect(
				queryClient?.getQueryState(compactSummaryQueryKey("narrator-1", "compact-old")),
			).toBeUndefined();
			expect(timers.mock.calls.some(([, delay]) => delay === 500)).toBe(false);
		} finally {
			timers.mockRestore();
		}
	});

	test("an ordinary deletion cancels an already scheduled reconnect", async () => {
		const initial = runningDetail();
		const stream = mock(async () => new Response(null, { status: 409 }));
		const read = mock(async () => initial);
		api.streamCompactSummary = stream;
		api.getCompactSummary = read;
		const realSet = window.setTimeout.bind(window);
		let reconnect: (() => void) | undefined;
		const id = 123456;
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			ms: number,
			...args: unknown[]
		) => {
			if (ms !== 500) return realSet(callback, ms, ...args);
			reconnect = callback;
			return id;
		}) as typeof window.setTimeout);
		const cleared = spyOn(globalThis, "clearTimeout");
		const onClose = mock(() => {});
		try {
			await renderModal({ initialDetail: initial, onClose });
			expect(stream).toHaveBeenCalledTimes(1);
			expect(read).toHaveBeenCalledTimes(1);
			expect(
				queryClient?.getQueryState(compactSummaryQueryKey("narrator-1", "compact-old"))?.data,
			).toEqual(initial);
			expect(timers.mock.calls.map(([, delay]) => delay)).toContain(500);
			expect(reconnect).toBeFunction();
			await dispatchNarratorWs({
				type: "messages_deleted",
				narratorId: "narrator-1",
				deletedMessageIds: ["compact-old"],
			});
			expect(cleared).toHaveBeenCalledWith(id);
			await act(async () => reconnect?.());
			await settle();
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(stream).toHaveBeenCalledTimes(1);
			expect(read).toHaveBeenCalledTimes(1);
		} finally {
			timers.mockRestore();
			cleared.mockRestore();
		}
	});

	test("reconnects from a refreshed cursor and keeps subsequent deltas exactly once", async () => {
		const streams = liveTransport();
		api.getCompactSummary = async () => runningDetail({ output: "prefix", outputChars: 6 });
		const realSet = globalThis.setTimeout.bind(globalThis);
		let reconnect: (() => void) | undefined;
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			ms: number,
			...args: unknown[]
		) => {
			if (ms !== 500) return realSet(callback, ms, ...args);
			reconnect = callback;
			return 123456;
		}) as typeof globalThis.setTimeout);
		try {
			await renderModal({ initialDetail: runningDetail({ output: "pre", outputChars: 3 }) });
			await act(async () => streams[0].disconnect());
			await settle();
			expect(reconnect).toBeFunction();
			await act(async () => reconnect?.());
			await settle();
			expect(streams).toHaveLength(2);
			expect(streams[1].offsets).toEqual({ output: 6, thinking: 0, streamVersion: 1 });
			await act(async () =>
				streams[1].send({
					kind: "delta",
					channel: "output",
					delta: " appended",
					outputChars: 15,
					thinkingChars: 0,
				}),
			);
			await settle();
			expect(
				queryClient?.getQueryData<CompactMessageDetail>(
					compactSummaryQueryKey("narrator-1", "compact-old"),
				)?.output,
			).toBe("prefix appended");
			expect(document.body.textContent).toContain("prefix appended");
		} finally {
			timers.mockRestore();
		}
	});

	test("finished cancels a pre-terminal metadata read and resolves a retained failure", async () => {
		const streams = liveTransport();
		const slowRead = deferred<CompactMessageDetail>();
		const signals: (AbortSignal | undefined)[] = [];
		api.getCompactSummary = async (_narratorId, _messageId, signal) => {
			signals.push(signal);
			return signals.length === 1 ? slowRead.promise : failedDetail();
		};
		const onClose = mock(() => {});
		await renderModal({ initialDetail: runningDetail(), onClose });
		await act(async () => streams[0].send(reset(2)));
		await settle();
		expect(signals).toHaveLength(1);
		await act(async () => streams[0].send({ kind: "finished", status: "failed" }));
		await settle();
		expect(signals).toHaveLength(2);
		expect(signals[0]?.aborted).toBe(true);
		slowRead.resolve(runningDetail({ streamVersion: 2, canChangeModel: true }));
		await settle();
		expect(onClose).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("first compact failed");
		expect(retryButton()).toBeDefined();
		expect(streams).toHaveLength(1);
	});

	test("COW replacement cancels an old GET and ignores late old-ID deletion and failure", async () => {
		const streams = liveTransport();
		const oldRead = deferred<CompactMessageDetail>();
		const getCalls: { messageId: string; signal?: AbortSignal }[] = [];
		api.getCompactSummary = async (_narratorId, messageId, signal) => {
			getCalls.push({ messageId, signal });
			return messageId === "compact-old"
				? oldRead.promise
				: completedDetail("private replacement summary");
		};
		const onClose = mock(() => {});
		const onDelete = mock(() => {});
		await renderModal({ initialDetail: runningDetail(), onClose, onDelete });
		await act(async () => streams[0].send(reset(2)));
		await settle();
		expect(getCalls.map((call) => call.messageId)).toEqual(["compact-old"]);
		await act(async () => {
			const dispatch = (event: Record<string, unknown>) =>
				(
					narratorWSManager as unknown as {
						_dispatchImmediate: (event: Record<string, unknown>) => void;
					}
				)._dispatchImmediate(event);
			dispatch({
				type: "messages_deleted",
				narratorId: "narrator-1",
				deletedMessageIds: ["compact-old"],
				oldMessageId: "compact-old",
				messageId: "compact-new",
			});
			dispatch({
				type: "messages_deleted",
				narratorId: "narrator-1",
				deletedMessageIds: ["compact-old"],
			});
		});
		await settle();
		oldRead.reject(new ApiError("old marker no longer exists", 404));
		await settle();
		expect(getCalls[0].signal?.aborted).toBe(true);
		expect(streams[0].signal?.aborted).toBe(true);
		expect(onClose).not.toHaveBeenCalled();
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(document.body.textContent).toContain("private replacement summary");
		expect(
			queryClient?.getQueryState(compactSummaryQueryKey("narrator-1", "compact-old")),
		).toBeUndefined();
		expect(getCalls.map((call) => call.messageId)).toEqual(["compact-old", "compact-new"]);
	});

	test("closing the modal cancels metadata reads and ignores a late queued response", async () => {
		const streams = liveTransport();
		const slowRead = deferred<CompactMessageDetail>();
		const queued = deferred<RetryFailedCompactResponse>();
		let detailSignal: AbortSignal | undefined;
		api.getCompactSummary = async (_narratorId, _messageId, signal) => {
			detailSignal = signal;
			return slowRead.promise;
		};
		api.retryFailedCompact = async () => queued.promise;
		const onClose = mock(() => {});
		await renderModal({ initialDetail: runningDetail({ canChangeModel: true }), onClose });
		await chooseSessionModel();
		await act(async () => streams[0].send({ kind: "heartbeat", outputChars: 0, thinkingChars: 0 }));
		await settle();
		const closeButton = document.body.querySelector<HTMLButtonElement>(".mantine-Modal-close");
		expect(closeButton).not.toBeNull();
		await act(async () => closeButton?.click());
		await settle();
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(streams[0].signal?.aborted).toBe(true);
		expect(detailSignal?.aborted).toBe(true);
		slowRead.resolve(runningDetail({ output: "late text" }));
		queued.resolve({
			ok: true,
			queued: true,
			messageId: "compact-old",
			pendingModel: "other:model",
		});
		await settle();
		expect(document.body.querySelector("[data-compact-summary-scroll]")).toBeNull();
		expect(
			queryClient?.getQueryData<CompactMessageDetail>(
				compactSummaryQueryKey("narrator-1", "compact-old"),
			)?.pendingModel,
		).toBeUndefined();
	});

	test("groups identical model names by provider and retries with the selected full model ID", async () => {
		// This case is about disambiguating identical names by provider: use the grouped view.
		localStorage.setItem("narrafork_model_menu_mode", "provider");
		const retryCalls: unknown[][] = [];
		api.retryFailedCompact = async (...args) => {
			retryCalls.push(args);
			return { ok: true, messageId: "compact-old" };
		};
		api.getCompactSummary = async () => completedDetail("retried with provider B");

		await renderModal({});
		const trigger = document.body.querySelector<HTMLButtonElement>(
			`button[aria-label="${narratorLocale.compactRetryModel}"]`,
		);
		if (!trigger) throw new Error("model picker trigger not found");
		expect(trigger.textContent).toContain(narratorLocale.compactRetryModel);
		await act(async () => trigger.click());
		await settle();

		const menu = document.body.querySelector("[data-model-menu-scroll]");
		expect(menu?.textContent).toContain("Provider A");
		expect(menu?.textContent).toContain("Provider B");
		expect(menu?.querySelector("input")).not.toBeNull();
		const choices = Array.from(
			menu?.querySelectorAll<HTMLButtonElement>("[data-menu-item]") ?? [],
		).filter((choice) => choice.textContent === "Model");
		expect(choices).toHaveLength(2);
		expect(choices.map((choice) => choice.textContent)).toEqual(["Model", "Model"]);
		await act(async () => choices[1].click());
		await settle();
		expect(retryCalls).toEqual([["narrator-1", "compact-old", { model: "other:model" }]]);
	});

	test("resolves COW, ordinary, and legacy retry targets", () => {
		expect(
			resolveCompactRetryTargetMigration("compact-old", {
				ok: true,
				messageId: "compact-new",
				oldMessageId: "compact-old",
				replacedMessageId: "compact-old",
			}),
		).toEqual({
			nextMessageId: "compact-new",
			retiredMessageIds: ["compact-old"],
			changed: true,
		});
		expect(
			resolveCompactRetryTargetMigration("compact-same", {
				ok: true,
				messageId: "compact-same",
			}),
		).toEqual({ nextMessageId: "compact-same", retiredMessageIds: [], changed: false });
		expect(resolveCompactRetryTargetMigration("compact-legacy", {})).toEqual({
			nextMessageId: "compact-legacy",
			retiredMessageIds: [],
			changed: false,
		});
		expect(
			resolveCompactReplacementEvent("compact-old", {
				type: "message_updated",
				oldMessageId: "compact-old",
				replacedMessageId: "compact-old",
				message: { id: "compact-new" },
			}),
		).toEqual({
			nextMessageId: "compact-new",
			retiredMessageIds: ["compact-old"],
			changed: true,
		});
		expect(
			resolveCompactReplacementEvent("unrelated", {
				type: "messages_deleted",
				deletedMessageIds: ["compact-old"],
				messageId: "compact-new",
			}),
		).toBeNull();
	});

	for (const wsOrder of ["before", "after"] as const) {
		test(`switches to the COW ID when WS deletion arrives ${wsOrder} HTTP`, async () => {
			if (!queryClient) throw new Error("query client missing");
			const currentQueryClient = queryClient;
			const retry = deferred<RetryFailedCompactResponse>();
			const getCalls: string[] = [];
			const messageListKey = ["narrators", "narrator-1", "messages"] as const;
			currentQueryClient.setQueryData(messageListKey, ["compact-old"]);
			const reconcileMessageCards = () => {
				currentQueryClient.setQueryData<string[]>(messageListKey, (current = []) => [
					...new Set([...current.filter((id) => id !== "compact-old"), "compact-new"]),
				]);
			};
			let httpReconcileCalls = 0;
			api.retryFailedCompact = async () => retry.promise;
			api.getCompactSummary = async (_narratorId, messageId) => {
				getCalls.push(messageId);
				if (messageId !== "compact-new") throw new Error(`unexpected detail ID: ${messageId}`);
				return completedDetail("new compact detail");
			};
			const onClose = mock(() => {});
			const cowFrame = {
				type: "messages_deleted",
				narratorId: "narrator-1",
				deletedMessageIds: ["compact-old"],
				oldMessageId: "compact-old",
				messageId: "compact-new",
				newMessageId: "compact-new",
			};

			await renderModal({
				onClose,
				onDelete: () => {
					httpReconcileCalls++;
					reconcileMessageCards();
				},
			});
			await clickRetry();
			if (wsOrder === "before") {
				reconcileMessageCards();
				await dispatchNarratorWs(cowFrame);
			}
			retry.resolve({
				ok: true,
				messageId: "compact-new",
				oldMessageId: "compact-old",
				replacedMessageId: "compact-old",
			});
			await settle();
			if (wsOrder === "after") {
				reconcileMessageCards();
				await dispatchNarratorWs(cowFrame);
			}
			await dispatchNarratorWs({
				type: "messages_deleted",
				narratorId: "narrator-1",
				deletedMessageIds: ["compact-old"],
			});
			await settle();

			expect(onClose).not.toHaveBeenCalled();
			expect(document.body.querySelector("[data-compact-summary-scroll]")).not.toBeNull();
			expect(httpReconcileCalls).toBe(1);
			expect(currentQueryClient.getQueryData<string[]>(messageListKey)).toEqual(["compact-new"]);
			expect(
				currentQueryClient.getQueryState(compactSummaryQueryKey("narrator-1", "compact-old")),
			).toBe(undefined);
			expect(
				currentQueryClient.getQueryData<CompactMessageDetail>(
					compactSummaryQueryKey("narrator-1", "compact-new"),
				),
			).toEqual(completedDetail("new compact detail"));
			expect(getCalls).toEqual(["compact-new"]);
		});
	}

	test("migrates from WS replacement identity when the HTTP retry response is lost", async () => {
		if (!queryClient) throw new Error("query client missing");
		const retry = deferred<RetryFailedCompactResponse>();
		const getCalls: string[] = [];
		let onDeleteCalls = 0;
		api.retryFailedCompact = async () => retry.promise;
		api.getCompactSummary = async (_narratorId, messageId) => {
			getCalls.push(messageId);
			if (messageId !== "compact-new") throw new Error(`unexpected detail ID: ${messageId}`);
			return completedDetail("WS-only compact detail");
		};

		await renderModal({ onDelete: () => onDeleteCalls++ });
		await clickRetry();
		await dispatchNarratorWs({
			type: "messages_deleted",
			narratorId: "narrator-1",
			deletedMessageIds: ["compact-old"],
			oldMessageId: "compact-old",
			replacedMessageId: "compact-old",
			messageId: "compact-new",
			newMessageId: "compact-new",
			replacementMessageId: "compact-new",
		});
		await settle();
		retry.reject(new Error("HTTP response lost"));
		await settle();

		expect(onDeleteCalls).toBe(1);
		expect(queryClient.getQueryState(compactSummaryQueryKey("narrator-1", "compact-old"))).toBe(
			undefined,
		);
		expect(
			queryClient.getQueryData<CompactMessageDetail>(
				compactSummaryQueryKey("narrator-1", "compact-new"),
			),
		).toEqual(completedDetail("WS-only compact detail"));
		expect(getCalls).toEqual(["compact-new"]);
	});

	test("preserves the failed replacement when its WS update beats the retry response", async () => {
		const retry = deferred<RetryFailedCompactResponse>();
		const getCalls: string[] = [];
		api.retryFailedCompact = async () => retry.promise;
		api.getCompactSummary = async (_narratorId, messageId) => {
			getCalls.push(messageId);
			return { ...failedDetail(), attempt: 2, error: "replacement compact failed" };
		};
		await renderModal({});
		await clickRetry();
		await dispatchNarratorWs({
			type: "messages_deleted",
			narratorId: "narrator-1",
			deletedMessageIds: ["compact-old"],
			messageId: "compact-new",
			oldMessageId: "compact-old",
		});
		await settle();
		expect(document.body.textContent).toContain("replacement compact failed");
		retry.resolve({ ok: true, messageId: "compact-new", oldMessageId: "compact-old" });
		await settle();
		expect(document.body.textContent).toContain("replacement compact failed");
		expect(getCalls).toEqual(["compact-new"]);
	});

	test("treats HTTP-first then duplicate WS replacement as idempotent", async () => {
		if (!queryClient) throw new Error("query client missing");
		const getCalls: string[] = [];
		let onDeleteCalls = 0;
		api.retryFailedCompact = async () => ({
			ok: true,
			messageId: "compact-new",
			oldMessageId: "compact-old",
			replacedMessageId: "compact-old",
		});
		api.getCompactSummary = async (_narratorId, messageId) => {
			getCalls.push(messageId);
			return completedDetail("HTTP-first compact detail");
		};

		await renderModal({ onDelete: () => onDeleteCalls++ });
		await clickRetry();
		await settle();
		await dispatchNarratorWs({
			type: "messages_deleted",
			narratorId: "narrator-1",
			deletedMessageIds: ["compact-old"],
			oldMessageId: "compact-old",
			replacedMessageId: "compact-old",
			messageId: "compact-new",
			newMessageId: "compact-new",
		});
		await settle();

		expect(onDeleteCalls).toBe(1);
		expect(getCalls).toEqual(["compact-new"]);
		expect(
			queryClient.getQueryData<CompactMessageDetail>(
				compactSummaryQueryKey("narrator-1", "compact-new"),
			),
		).toEqual(completedDetail("HTTP-first compact detail"));
	});

	test("keeps the same query key for an ordinary retry", async () => {
		if (!queryClient) throw new Error("query client missing");
		const getCalls: string[] = [];
		let onDeleteCalls = 0;
		api.retryFailedCompact = async () => ({ ok: true, messageId: "compact-same" });
		api.getCompactSummary = async (_narratorId, messageId) => {
			getCalls.push(messageId);
			return completedDetail("same compact detail");
		};

		await renderModal({ messageId: "compact-same", onDelete: () => onDeleteCalls++ });
		await clickRetry();

		expect(onDeleteCalls).toBe(0);
		expect(getCalls).toEqual(["compact-same"]);
		expect(
			queryClient.getQueryData<CompactMessageDetail>(
				compactSummaryQueryKey("narrator-1", "compact-same"),
			),
		).toEqual(completedDetail("same compact detail"));
	});

	test("keeps the old query key for a legacy retry response without messageId", async () => {
		if (!queryClient) throw new Error("query client missing");
		const getCalls: string[] = [];
		api.retryFailedCompact = async () => ({ ok: true }) as unknown as RetryFailedCompactResponse;
		api.getCompactSummary = async (_narratorId, messageId) => {
			getCalls.push(messageId);
			return completedDetail("legacy compact detail");
		};

		await renderModal({ messageId: "compact-legacy" });
		await clickRetry();

		expect(getCalls).toEqual(["compact-legacy"]);
		expect(
			queryClient.getQueryData<CompactMessageDetail>(
				compactSummaryQueryKey("narrator-1", "compact-legacy"),
			),
		).toEqual(completedDetail("legacy compact detail"));
	});
});
