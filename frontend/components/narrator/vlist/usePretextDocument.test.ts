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

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ConfirmDialogProvider } from "@frontend/components/common/ConfirmDialogProvider";
import { useLocalPref } from "@frontend/hooks/useLocalPref";
import type { NarratorWSCallbacks } from "@frontend/hooks/useNarratorWS";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import { MantineProvider } from "@mantine/core";
import { messageBody, rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { restorePretextLayoutAnchor } from "@shared/pretext-layout";
import { resetTypographyForTest, setTypography } from "@shared/pretext-layout/typography";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, createElement, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RenderLodCtx } from "../lod/RenderLodCtx";
import { bumpFontRevisionForTest } from "./katex-runtime";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { measureCache } from "./measure-cache";
import type { PretextDocumentFetchPage } from "./pretext-document-loader";
import { captureCoordinatorAnchor } from "./pretext-layout-coordinator";
import { renderElement, resolveRenderExtra } from "./render-registry";
import type { PretextDocumentView, UsePretextDocumentResult } from "./usePretextDocument";
import { usePretextDocument } from "./usePretextDocument";
import { useVListReasoningExpansion } from "./useVListReasoningExpansion";
import type { VListDataSource } from "./vlist-data-source";
import { resolveRowOpenState } from "./vlist-exact-row-state";
import {
	createVListInteractionState,
	resetVListInteractionStateForLod,
	setVListExpanded,
	toggleVListRowExpansion,
	type VListInteractionState,
} from "./vlist-interaction-state";
import { indexWithHeightOverrides } from "./vlist-resize-preview";

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
	"localStorage",
	"matchMedia",
	"ResizeObserver",
] as const;

function installDom(): () => void {
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of DOM_GLOBAL_KEYS) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const storage = new Map<string, string>();
	const values: Record<string, unknown> = {
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
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
let harnessWidth = 860;
let harnessEpoch = 0;
let harnessLoadOptions: { fetchPage: PretextDocumentFetchPage } = LOAD_OPTIONS;
let harnessOverrides = new Map<string, number>();
let harnessView: PretextDocumentView = { scrollTop: 0, viewportHeight: 720, pinnedToBottom: true };
const readHeightOverrides = () => harnessOverrides;

/** Live-view reads, counted: one per invalidateFontDependentLayout call. */
let viewCalls = 0;
function readCurrentView(): PretextDocumentView {
	viewCalls++;
	return harnessView;
}

let renders: UsePretextDocumentResult[] = [];

function Harness() {
	renders.push(
		usePretextDocument("n1", {
			lod: 5,
			widthBucket: String(harnessWidth),
			contentWidth: harnessWidth,
			widthCommitEpoch: harnessEpoch,
			viewportHeight: 720,
			scrollTop: 0,
			pinnedToBottom: true,
			getCurrentView: readCurrentView,
			getHeightOverrides: readHeightOverrides,
			loadOptions: harnessLoadOptions,
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
	harnessWidth = 860;
	harnessEpoch = 0;
	harnessLoadOptions = LOAD_OPTIONS;
	harnessOverrides = new Map();
	harnessView = { scrollTop: 0, viewportHeight: 720, pinnedToBottom: true };
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

const REASONING_BODY = `${"a reasoning paragraph ".repeat(12)}BODY_SENTINEL`;
const STEPS_BODY = `**First**\n\n${REASONING_BODY}\n\n**Second**\n\nsecond body SECOND_SENTINEL`;
let reasoningResult: UsePretextDocumentResult | undefined;
let reasoningInteraction: VListInteractionState;
let setReasoningPreference: (value: boolean) => void;
let reasoningMountId = 0;

function reasoningMessage(seq: number, text: string, structured = false): TreeMessage {
	return rowWithElements(
		{ ...message(seq, ""), model: structured ? "gpt-5.6" : "claude-sonnet-4" },
		[{ id: `reasoning-block-${seq}`, type: "reasoning", text }],
	) as TreeMessage;
}

/** The same preference hook, document builder and click reducer used by the exact list. */
function ReasoningHarness({
	id,
	lod,
	isSubagent = false,
}: {
	id: string;
	lod: 2 | 5;
	isSubagent?: boolean;
}) {
	const [interaction, setInteraction] = useState(() => createVListInteractionState(lod));
	if (interaction.lod !== lod) setInteraction(resetVListInteractionStateForLod(interaction, lod));
	const active =
		interaction.lod === lod ? interaction : resetVListInteractionStateForLod(interaction, lod);
	reasoningInteraction = active;
	const policy = useVListReasoningExpansion(active);
	const [, setPreference] = useLocalPref("narrafork_expand_reasoning");
	setReasoningPreference = setPreference;
	const isExpanded = useCallback((key: string) => active.expanded.get(key), [active]);
	const result = usePretextDocument(id, {
		...policy,
		isSubagent,
		isExpanded,
		lod,
		widthBucket: "860",
		contentWidth: 860,
		viewportHeight: 720,
		scrollTop: 0,
		pinnedToBottom: false,
		getCurrentView: readCurrentView,
		loadOptions: harnessLoadOptions,
	});
	reasoningResult = result;
	return createElement(
		MantineProvider,
		null,
		result.items.map((item) => {
			const extra = resolveRenderExtra(item.spec);
			extra.onToggle = () =>
				setInteraction((previous) =>
					setVListExpanded(
						previous,
						item.spec.key,
						!resolveRowOpenState(item.measured, previous, item.spec.key),
					),
				);
			extra.onToggleRow = (index: number, rowKey?: string) =>
				setInteraction((previous) => toggleVListRowExpansion(previous, item.spec, index, rowKey));
			return createElement(
				"section",
				{ key: item.spec.key, "data-pref-item": item.spec.key, "data-pref-kind": item.spec.kind },
				renderElement(item.spec.kind, item.measured, extra),
			);
		}),
	);
}

function reasoningView(): UsePretextDocumentResult {
	if (!reasoningResult) throw new Error("reasoning harness has not rendered");
	return reasoningResult;
}

function reasoningItems() {
	return reasoningView().items.filter((item) =>
		["reasoning", "reasoning-steps", "activity-trace"].includes(item.spec.kind),
	);
}

function reasoningItem(index = 0) {
	const item = reasoningItems().at(index);
	if (!item) throw new Error("missing reasoning item");
	return item;
}

function reasoningExpanded(item = reasoningItem(), rowIndex = 0): boolean {
	if (item.spec.kind === "reasoning")
		return (item.measured as { form?: string }).form === "expanded";
	return (item.spec.opts?.expandedIndices as number[]).includes(rowIndex);
}

async function mountReasoning(lod: 2 | 5, isSubagent = false) {
	Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
		value: true,
		configurable: true,
	});
	reasoningResult = undefined;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.push(root);
	containers.push(container);
	const id = `reasoning-pref-${++reasoningMountId}`;
	await act(async () => {
		root.render(createElement(ReasoningHarness, { id, lod, isSubagent }));
		await settle();
	});
	return { root, container, id };
}

async function clickReasoning(container: HTMLElement, itemKey = reasoningItem().spec.key) {
	const section = [...container.querySelectorAll("[data-pref-item]")].find(
		(node) => node.getAttribute("data-pref-item") === itemKey,
	);
	const control =
		section?.getAttribute("data-pref-kind") === "reasoning"
			? section.querySelector(".mantine-Group-root")
			: section?.querySelector("[data-nf-trace-titlerow][role=button]");
	if (!control) throw new Error("missing rendered reasoning toggle");
	await act(async () => {
		(control as HTMLElement).click();
		await settle();
	});
}

function configureReasoningPage(structured: boolean) {
	const source = reasoningMessage(0, structured ? STEPS_BODY : REASONING_BODY, structured);
	harnessLoadOptions = {
		fetchPage: async () => ({
			messages: [source],
			minSeq: 0,
			maxSeq: 0,
			hasNext: false,
			hasPrev: false,
			messageVersion: 1,
		}),
	};
	return source;
}

describe("reasoning preference → production document → rendered click", () => {
	afterEach(() => {
		act(() => {
			for (const root of roots) root.unmount();
		});
		roots = [];
	});

	for (const shape of ["plain", "steps", "folded"] as const) {
		for (const enabled of [false, true]) {
			test(`${shape}: initial ${enabled}, same-tab setter, storage, append and manual priority`, async () => {
				const structured = shape !== "plain";
				configureReasoningPage(structured);
				localStorage.setItem("narrafork_expand_reasoning", String(enabled));
				const { container } = await mountReasoning(shape === "folded" ? 2 : 5);
				expect(reasoningView().status).toBe("ready");
				expect(reasoningExpanded()).toBe(enabled);
				expect(container.textContent?.includes("BODY_SENTINEL")).toBe(enabled);
				const key = reasoningItem().spec.key;
				const initialHeight = reasoningItem().measured.height;

				await clickReasoning(container);
				expect(reasoningExpanded()).toBe(!enabled);
				expect(container.textContent?.includes("BODY_SENTINEL")).toBe(!enabled);
				if (enabled) expect(reasoningItem().measured.height).toBeLessThan(initialHeight);
				else expect(reasoningItem().measured.height).toBeGreaterThan(initialHeight);
				await act(async () => {
					setReasoningPreference(!enabled);
					await settle();
				});
				expect(localStorage.getItem("narrafork_expand_reasoning")).toBe(String(!enabled));
				expect(reasoningExpanded()).toBe(!enabled);
				if (structured) expect(reasoningExpanded(undefined, 1)).toBe(!enabled);

				await act(async () => {
					expect(
						reasoningView().appendMessage(reasoningMessage(1, REASONING_BODY, structured)),
					).toBe(true);
					await settle();
				});
				expect(reasoningItem().spec.key).toBe(key);
				expect(reasoningExpanded()).toBe(!enabled);
				const appended = reasoningItem(-1);
				const appendedIndex =
					appended.spec.kind === "activity-trace"
						? (appended.spec.data as { items: unknown[] }).items.length - 1
						: 0;
				expect(reasoningExpanded(appended, appendedIndex)).toBe(!enabled);

				await act(async () => {
					localStorage.setItem("narrafork_expand_reasoning", String(enabled));
					const event = document.createEvent("Event");
					event.initEvent("storage", false, false);
					Object.defineProperty(event, "key", { value: "narrafork_expand_reasoning" });
					window.dispatchEvent(event);
					await settle();
				});
				expect(reasoningExpanded()).toBe(!enabled);
				expect(reasoningExpanded(reasoningItem(-1), appendedIndex)).toBe(enabled);

				await act(async () => {
					expect(
						reasoningView().applyLivePatch((messages) => ({
							changed: true,
							messages: messages.map((row, index) =>
								index === 0
									? (rowWithElements(
											row,
											messageBody(row).map((block) => ({
												...block,
												translatedText: structured
													? STEPS_BODY.replaceAll("body", "translated body")
													: `${REASONING_BODY} translated`,
											})),
										) as TreeMessage)
									: row,
							),
						})),
					).toBe(true);
					await settle();
				});
				expect(reasoningItem().spec.key).toBe(key);
				expect(reasoningExpanded()).toBe(!enabled);
				await clickReasoning(container, key);
				expect(reasoningExpanded()).toBe(enabled);
				expect(reasoningInteraction.fullPayloadRequested.size).toBe(0);
				expect(reasoningInteraction.promptOpen.size).toBe(0);
			});
		}
	}

	test("the real exact list wires saved settings, ExactRow clicks and arriving messages", async () => {
		Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
			value: true,
			configurable: true,
		});
		localStorage.setItem("narrafork_expand_reasoning", "true");
		localStorage.setItem("narrafork_advanced_anim", "false");
		localStorage.setItem("narrafork_unified_morph", "false");
		const geometry = new Map<string, PropertyDescriptor | undefined>();
		const prototype = window.HTMLElement.prototype;
		const properties: PropertyDescriptorMap = {
			clientWidth: { get: () => 900 },
			offsetWidth: { get: () => 900 },
			clientHeight: { get: () => 900 },
			offsetHeight: { get: () => 900 },
			scrollHeight: { get: () => 900 },
			scrollTop: { value: 0, writable: true },
			getBoundingClientRect: {
				value: () => ({
					x: 0,
					y: 0,
					top: 0,
					left: 0,
					right: 900,
					bottom: 900,
					width: 900,
					height: 900,
				}),
			},
		};
		for (const [key, descriptor] of Object.entries(properties)) {
			geometry.set(key, Object.getOwnPropertyDescriptor(prototype, key));
			Object.defineProperty(prototype, key, { ...descriptor, configurable: true });
		}
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: (query: string) => ({
				matches: query.includes("prefers-reduced-motion"),
				addEventListener() {},
				removeEventListener() {},
				addListener() {},
				removeListener() {},
			}),
		});
		Object.defineProperty(window, "getSelection", { configurable: true, value: () => null });
		const blockedRequests: { method: string; pathname: string }[] = [];
		const rejectFetch = Object.assign(
			async (
				input: Parameters<typeof globalThis.fetch>[0],
				init?: Parameters<typeof globalThis.fetch>[1],
			) => {
				const request = input instanceof Request ? input : undefined;
				const method = (init?.method ?? request?.method ?? "GET").slice(0, 16);
				const pathname = new URL(
					request?.url ?? String(input),
					"https://fixture.invalid",
				).pathname.slice(0, 200);
				if (blockedRequests.length < 8) blockedRequests.push({ method, pathname });
				throw new Error(`blocked exact-list fixture request: ${method} ${pathname}`);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		const fetch = spyOn(globalThis, "fetch").mockImplementation(rejectFetch);
		const { narratorWSManager } = await import("@frontend/lib/narrator-ws-manager");
		let subscriptionId = 10_000;
		const subscribe = spyOn(narratorWSManager, "subscribe").mockImplementation((ids, options) => ({
			_id: ++subscriptionId,
			_narratorIds: ids,
			_kind: options?.kind ?? "list",
		}));
		const id = `reasoning-shell-${++reasoningMountId}`;
		const client = new QueryClient({
			defaultOptions: {
				queries: { enabled: false, retry: false, staleTime: Infinity, gcTime: Infinity },
			},
		});
		client.setQueryData(["narrators", id], { id, model: "gpt-5.6" });
		client.setQueryData(["user-preferences"], {
			autoLoadOlderMessages: false,
			showTokenUsage: false,
		});
		const source = reasoningMessage(0, STEPS_BODY, true);
		let handlers: NarratorWSCallbacks | undefined;
		const dataSource: VListDataSource = {
			viewerId: null,
			fetchPage: async () => ({
				messages: [source],
				minSeq: 0,
				maxSeq: 0,
				hasNext: false,
				hasPrev: false,
				messageVersion: 1,
			}),
			subscribeMessages: (callbacks) => {
				handlers = callbacks;
				return () => {
					handlers = undefined;
				};
			},
		};
		const container = document.body.appendChild(document.createElement("div"));
		const root = createRoot(container);
		let setPreference: (value: boolean) => void = () => {};
		function SettingsProbe() {
			[, setPreference] = useLocalPref("narrafork_expand_reasoning");
			return null;
		}
		function titleRows() {
			return [...container.querySelectorAll<HTMLElement>("[data-nf-trace-titlerow][role=button]")];
		}
		async function flush() {
			await act(async () => {
				await settle();
			});
		}
		try {
			const { PretextExactMessageList } = await import("./PretextExactMessageList");
			await act(async () => {
				root.render(
					createElement(
						QueryClientProvider,
						{ client },
						createElement(
							MantineProvider,
							null,
							createElement(
								ConfirmDialogProvider,
								null,
								createElement(
									RenderLodCtx.Provider,
									{ value: { lod: 5, interactive: true } },
									createElement(SettingsProbe),
									createElement(PretextExactMessageList, { narratorId: id, dataSource }),
								),
							),
						),
					),
				);
			});
			for (let attempt = 0; attempt < 20 && titleRows().length < 2; attempt++) await flush();
			expect(container.querySelectorAll("[data-nf-row-key]")).toHaveLength(1);
			expect(titleRows()).toHaveLength(2);
			expect(titleRows().map((node) => node.getAttribute("aria-expanded"))).toEqual([
				"true",
				"true",
			]);
			expect(container.textContent).toContain("BODY_SENTINEL");
			await act(async () => {
				titleRows()[0]?.click();
			});
			await flush();
			expect(titleRows().map((node) => node.getAttribute("aria-expanded"))).toEqual([
				"false",
				"true",
			]);
			expect(container.textContent).not.toContain("BODY_SENTINEL");
			await act(async () => {
				setPreference(false);
			});
			await flush();
			expect(titleRows().map((node) => node.getAttribute("aria-expanded"))).toEqual([
				"false",
				"false",
			]);
			await act(async () => {
				setPreference(true);
			});
			await flush();
			expect(titleRows().map((node) => node.getAttribute("aria-expanded"))).toEqual([
				"false",
				"true",
			]);
			await act(async () => {
				const appended = reasoningMessage(1, "**New**\n\nnew reasoning NEW_MESSAGE_SENTINEL", true);
				appended.narratorId = id;
				handlers?.onMessage?.({ message: appended });
			});
			await flush();
			expect(container.querySelectorAll("[data-nf-row-key]")).toHaveLength(2);
			expect(titleRows().map((node) => node.getAttribute("aria-expanded"))).toEqual([
				"false",
				"true",
				"true",
			]);
			expect(container.textContent).toContain("NEW_MESSAGE_SENTINEL");
			expect(blockedRequests).toEqual([]);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			await act(async () => root.unmount());
			client.clear();
			container.remove();
			subscribe.mockRestore();
			fetch.mockRestore();
			for (const [key, descriptor] of geometry) {
				if (descriptor) Object.defineProperty(prototype, key, descriptor);
				else Reflect.deleteProperty(prototype, key);
			}
		}
	});

	test("subagent pages and live appends consume the committed reasoning policy", async () => {
		const source = configureReasoningPage(true);
		source.parentToolUseId = "parent-agent";
		localStorage.setItem("narrafork_expand_reasoning", "true");
		await mountReasoning(5, true);
		expect(reasoningExpanded()).toBe(true);
		await act(async () => {
			setReasoningPreference(false);
			await settle();
		});
		expect(reasoningExpanded()).toBe(false);
		await act(async () => {
			const appended = reasoningMessage(1, STEPS_BODY, true);
			appended.parentToolUseId = "parent-agent";
			expect(reasoningView().appendMessage(appended)).toBe(true);
			await settle();
		});
		expect(reasoningExpanded(reasoningItem(-1))).toBe(false);
		await act(async () => {
			setReasoningPreference(true);
			await settle();
		});
		await act(async () => {
			const live = reasoningMessage(2, STEPS_BODY, true);
			live.id = "__streaming__";
			live.parentToolUseId = "parent-agent";
			reasoningView().setStreamingMessage(live);
			await settle();
		});
		expect(reasoningItem(-1).spec.opts?.expandedIndices).toEqual([0, 1]);
	});

	test("preference-only rebuild preserves the scroll anchor and LOD row-fold lifecycle", async () => {
		configureReasoningPage(true);
		const { root, container, id } = await mountReasoning(5);
		const before = reasoningView();
		if (!before.index) throw new Error("missing reasoning index");
		harnessView = {
			scrollTop: before.index.itemStart(0) + 3,
			viewportHeight: 60,
			pinnedToBottom: false,
		};
		const anchor = captureCoordinatorAnchor(before.index, harnessView);
		await act(async () => {
			setReasoningPreference(true);
			await settle();
		});
		const opened = reasoningView();
		expect(opened.index).not.toBe(before.index);
		if (!opened.index) throw new Error("missing updated reasoning index");
		expect(opened.scrollTopCorrection).toBe(restorePretextLayoutAnchor(anchor, opened.index, 60));
		await clickReasoning(container);
		expect(reasoningExpanded()).toBe(false);
		await act(async () => {
			root.render(createElement(ReasoningHarness, { id, lod: 2 }));
			await settle();
		});
		expect(reasoningInteraction.reasoningRowOverrides.size).toBe(0);
		expect(reasoningExpanded()).toBe(true);
	});
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

describe("usePretextDocument resize integration", () => {
	test("loadOlderAsync forwards live painted heights after a gated page and width preview", async () => {
		const messages = Array.from({ length: 100 }, (_, seq) =>
			message(seq, "Historical response that wraps while the width changes. ".repeat(8)),
		);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harnessLoadOptions = {
			fetchPage: async (_id, options) => {
				if (options.beforeSeq != null) await gate;
				const eligible = messages.filter((row) =>
					options.beforeSeq == null ? true : (row.seq ?? 0) < options.beforeSeq,
				);
				const rows = eligible.slice(-options.limit);
				const minSeq = rows[0]?.seq ?? null;
				return {
					messages: rows,
					messageVersion: 33,
					minSeq,
					maxSeq: rows.at(-1)?.seq ?? null,
					hasPrev: minSeq != null && minSeq > 0,
					hasNext: false,
				};
			},
		};
		await mount();
		const initial = latest();
		if (!initial.index) throw new Error("missing initial layout");
		const offscreen = initial.items[0];
		if (!offscreen) throw new Error("missing offscreen row");
		harnessOverrides = new Map([[offscreen.spec.key, 300]]);
		harnessView = {
			scrollTop: initial.index.itemStart(15) + 7,
			viewportHeight: 260,
			pinnedToBottom: false,
		};
		const pending = initial.loadOlderAsync();
		latest().previewWidth(420);
		await settle();
		const preview = latest();
		if (!preview.index) throw new Error("missing preview layout");
		expect(preview.items[0]?.contentWidth).toBe(860);
		const changedIndex = preview.items.findIndex((item) => item.contentWidth === 420);
		const changed = preview.items[changedIndex];
		if (!changed || changedIndex < 0) throw new Error("missing reflowed row");
		// Replace the entire map while I/O is gated, without rerendering the hook.
		harnessOverrides = new Map([
			[offscreen.spec.key, 2000],
			[changed.spec.key, 900],
		]);
		const effective = indexWithHeightOverrides(preview.index, harnessOverrides);
		harnessView = { ...harnessView, scrollTop: effective.itemStart(changedIndex + 2) + 13 };
		const anchor = captureCoordinatorAnchor(effective, harnessView);
		expect(anchor).not.toEqual(captureCoordinatorAnchor(preview.index, harnessView));
		release();
		expect(await pending).toBe(60);
		await settle();
		const committed = latest();
		if (!committed.index) throw new Error("missing committed layout");
		expect(committed.messages).toHaveLength(100);
		expect(committed.scrollTopCorrection).toBe(
			restorePretextLayoutAnchor(
				anchor,
				indexWithHeightOverrides(committed.index, new Map([[offscreen.spec.key, 2000]])),
				260,
			),
		);
		expect(committed.scrollTopCorrection).not.toBe(
			restorePretextLayoutAnchor(anchor, committed.index, 260),
		);
	});

	test("preview retains the semantic baseline, and an equal-width epoch forces finish", async () => {
		const root = await mount();
		const initial = latest();
		initial.previewWidth(420);
		await settle();
		expect(latest().resizePreview).toBe(true);
		expect(latest().semanticItems).toBe(initial.semanticItems);
		expect(latest().semanticManifest).toBe(initial.semanticManifest);
		expect(latest().items.every((item) => item.contentWidth === 420)).toBe(true);
		// Still 860 in React: returning to the original width cannot rely on setState equality.
		harnessEpoch++;
		root.render(createElement(Harness));
		await settle();
		expect(latest().resizePreview).toBe(false);
		expect(latest().items.every((item) => item.contentWidth === 860)).toBe(true);
		expect(latest().semanticItems).not.toBe(initial.semanticItems);
	});

	test("final width is built once and stays authoritative after a streaming update", async () => {
		const root = await mount();
		latest().previewWidth(420);
		await settle();
		harnessWidth = 420;
		harnessEpoch++;
		const callsBefore = viewCalls;
		root.render(createElement(Harness));
		await settle();
		expect(viewCalls - callsBefore).toBe(1); // one live view for the finish, not two builds
		expect(latest().resizePreview).toBe(false);
		latest().setStreamingMessage({
			...message(2, "stream words ".repeat(50)),
			id: "__streaming__",
		});
		await settle();
		expect(latest().items.every((item) => item.contentWidth === 420)).toBe(true);
	});

	test("finishes the painted document during a pending tail reload without waiting for I/O", async () => {
		const root = await mount();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let fetches = 0;
		harnessLoadOptions = {
			fetchPage: async () => {
				fetches++;
				await gate;
				return page();
			},
		};
		latest().reload();
		root.render(createElement(Harness));
		await settle();
		expect(latest().status).toBe("loading");
		latest().previewWidth(420);
		await settle();
		expect(latest().resizePreview).toBe(true);
		harnessWidth = 420;
		harnessEpoch++;
		root.render(createElement(Harness));
		await settle();
		expect(latest().resizePreview).toBe(false);
		expect(latest().items.every((item) => item.contentWidth === 420)).toBe(true);
		expect(fetches).toBe(1);
		release();
		await settle();
		expect(latest().status).toBe("ready");
		expect(latest().items.every((item) => item.contentWidth === 420)).toBe(true);
	});
});

for (const forceReloadAtFinish of [false, true]) {
	test(`pending reload preserves effective finish anchor (new reload at finish: ${forceReloadAtFinish})`, async () => {
		const documentPage = {
			...page(),
			messages: [
				message(0, "override host"),
				message(1, "middle words ".repeat(500)),
				message(2, "tail words ".repeat(100)),
			],
			maxSeq: 2,
			// New content at stable ids is a NEW canonical version, not an in-place cache hit.
			messageVersion: forceReloadAtFinish ? 14 : 13,
		};
		harnessLoadOptions = { fetchPage: async () => documentPage };
		const root = await mount();
		const initial = latest();
		const key = initial.items[0]?.spec.key;
		const height = initial.items[0]?.measured.height;
		if (!key || height == null || !initial.index) throw new Error("missing layout");
		harnessOverrides.set(key, height + 200);
		const expected = initial.index.itemStart(2) + 200 + 5;
		harnessView = { scrollTop: expected, viewportHeight: 40, pinnedToBottom: false };
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let fetches = 0;
		harnessLoadOptions = {
			fetchPage: async () => {
				fetches++;
				await gate;
				return documentPage;
			},
		};
		latest().reload();
		root.render(createElement(Harness));
		await settle();
		expect(latest().status).toBe("loading");
		latest().previewWidth(420);
		await settle();
		expect(
			latest().items[0]?.contentWidth,
			JSON.stringify({
				initialCount: initial.items.length,
				heights: initial.items.map((item) => item.measured.height),
				expected,
				view: harnessView,
				sources: initial.messages.map((message) => message.contentText?.length),
			}),
		).toBe(860); // the overridden host remained off-screen
		harnessView = { ...harnessView, scrollTop: latest().scrollTopCorrection ?? expected };
		harnessEpoch++;
		if (forceReloadAtFinish) latest().reload();
		root.render(createElement(Harness));
		await settle();
		expect(latest().resizePreview).toBe(false);
		expect(latest().scrollTopCorrection).toBe(expected);
		release();
		await settle();
		expect(fetches).toBe(forceReloadAtFinish ? 2 : 1);
		expect(latest().status).toBe("ready");
		expect(latest().scrollTopCorrection).toBe(expected);
	});
}
