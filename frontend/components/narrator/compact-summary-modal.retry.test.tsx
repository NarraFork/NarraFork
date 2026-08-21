import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { CompactMessageDetail } from "@shared/compact-message";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { api } from "../../lib/api";
import type { RetryFailedCompactResponse } from "../../lib/api/narrators";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import narratorLocale from "../../locales/en/narrator.json";

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
mock.module("../../lib/i18n", i18nModule);
mock.module("@frontend/lib/i18n", i18nModule);

const realUseModels = { ...(await import("../../hooks/useModels")) };
mock.module("../../hooks/useModels", () => ({
	...realUseModels,
	useAllModels: () => ({
		visibleModels: [{ value: "provider:model", label: "Model", provider: "provider" }],
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
	retryFailedCompact: api.retryFailedCompact,
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

async function renderModal(opts: { messageId?: string; onDelete?: () => void }) {
	if (!root || !queryClient) throw new Error("test harness is not initialized");
	const currentRoot = root;
	const currentQueryClient = queryClient;
	const messageId = opts.messageId ?? "compact-old";
	currentQueryClient.setQueryData(compactSummaryQueryKey("narrator-1", messageId), failedDetail());
	await act(async () => {
		currentRoot.render(
			<I18nextProvider i18n={testI18n}>
				<MantineProvider env="test">
					<QueryClientProvider client={currentQueryClient}>
						<CompactSummaryModal
							target={{
								kind: "context",
								narratorId: "narrator-1",
								messageId,
								onDelete: opts.onDelete,
							}}
							onClose={() => {}}
						/>
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
});

afterEach(async () => {
	Object.assign(api, originalApi);
	await act(async () => root?.unmount());
	queryClient?.clear();
	container?.remove();
	root = undefined;
	queryClient = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("../../lib/i18n", i18nModule);
	mock.module("@frontend/lib/i18n", i18nModule);
	mock.module("../../hooks/useModels", () => realUseModels);
	mock.restore();
});

describe("CompactSummaryModal failed compact retry", () => {
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

			await renderModal({
				onDelete: () => {
					httpReconcileCalls++;
					reconcileMessageCards();
				},
			});
			await clickRetry();
			if (wsOrder === "before") reconcileMessageCards();
			retry.resolve({
				ok: true,
				messageId: "compact-new",
				oldMessageId: "compact-old",
				replacedMessageId: "compact-old",
			});
			await settle();
			if (wsOrder === "after") reconcileMessageCards();
			await settle();

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
