import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { useToolCallDetail } from "../../../hooks/useNarrator";
import { toolCallDetailQueryKey } from "../../../lib/api/narrators";
import { segmentMessages } from "../message/message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { TraceRowInteraction } from "../trace/TraceRowInteraction";
import { ToolCallInspector } from "./ToolCallInspector";

const { VListRowInteraction } = await import("../vlist/VListRowInteraction");
const { adaptSegment, adaptActivityUnit } = await import("../vlist/segment-adapter");
const { toolDetailRequestFromData } = await import("../vlist/useVListToolDetails");
const { measureElementCached } = await import("../vlist/registry");
const { measureCache } = await import("../vlist/measure-cache");

// Real Inspector + React Query + HTTP adapter: only fetch and browser primitives
// are replaced. Null external data must not accidentally create a network request.
const i18n = i18next.createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	resources: { en: { narrator: {}, common: {} } },
	react: { useSuspense: false },
});

type Props = ComponentProps<typeof ToolCallInspector>;
let root: Root;
let client: QueryClient;
let restoreDom: () => void;
let calls: URL[];
const originalFetch = globalThis.fetch;
const noop = () => {};
const base: Props = { narratorId: "n1", toolUseId: "shared-sdk-id", opened: true, onClose: noop };

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	// Real menu/tooltip transitions can leave delayed browser callbacks after
	// unmount. Retire this DOM's timers before restoring globals for pure suites.
	const nativeSetTimeout = globalThis.setTimeout;
	const nativeClearTimeout = globalThis.clearTimeout;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const trackedSetTimeout = (
		callback: (...args: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	) => {
		const timer = nativeSetTimeout(() => {
			timers.delete(timer);
			callback(...args);
		}, ms);
		timers.add(timer);
		return timer;
	};
	class Observer {
		observe() {}
		unobserve() {}
		disconnect() {}
		takeRecords() {
			return [];
		}
	}
	const values: Record<string, unknown> = {
		setTimeout: trackedSetTimeout,
		clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
			timers.delete(timer);
			nativeClearTimeout(timer);
		},
		window,
		document: window.document,
		navigator: window.navigator,
		Document: window.Document,
		ShadowRoot: window.ShadowRoot,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		innerWidth: 1000,
		innerHeight: 900,
		getSelection: () => null,
		ResizeObserver: Observer,
		MutationObserver: Observer,
		localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
		matchMedia: (media: string) => ({
			media,
			matches: false,
			addEventListener: noop,
			removeEventListener: noop,
			addListener: noop,
			removeListener: noop,
		}),
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: false,
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	return () => {
		for (const timer of timers) nativeClearTimeout(timer);
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
}

async function flush() {
	for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function bodyFor(url: URL) {
	const id = url.searchParams.get("toolCallId");
	const messageId = url.searchParams.get("messageId");
	const text = `${url.pathname}:${id}:${messageId}`;
	return {
		id,
		messageId,
		toolName: "Bash",
		inputJson: `input:${text}`,
		outputJson: `output:${text}`,
	};
}

beforeEach(() => {
	restoreDom = installDom();
	calls = [];
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["health"], { platform: "linux" });
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = new URL(String(input), "https://test.invalid");
		calls.push(url);
		return Response.json(bodyFor(url));
	}) as typeof fetch;
});

afterEach(async () => {
	root.unmount();
	client.clear();
	measureCache.clear();
	await flush();
	globalThis.fetch = originalFetch;
	restoreDom();
});

async function render(props: Props | Props[]) {
	root.render(
		<QueryClientProvider client={client}>
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					{(Array.isArray(props) ? props : [props]).map((entry, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed slots exercise prop changes without remounting
						<ToolCallInspector key={index} {...entry} />
					))}
				</MantineProvider>
			</I18nextProvider>
		</QueryClientProvider>,
	);
	await flush();
}

describe("ToolCallInspector timing", () => {
	test("separates streaming, pre-execution wait and measured file operation", async () => {
		i18n.addResourceBundle(
			"en",
			"narrator",
			{
				toolCallInspector: {
					timing: {
						streaming: "STREAM {{duration}}",
						wait: "WAIT {{duration}}",
						execution: "OPERATION {{duration}}",
						executionSpan: "SPAN {{duration}}",
						total: "TOTAL {{duration}}",
					},
				},
			},
			true,
			true,
		);
		const detail = {
			toolName: "Edit",
			streamStartedAt: 35_417,
			streamCompletedAt: 40_192,
			executionStartedAt: 40_259,
			completedAt: 48_625,
			durationMs: 13_209,
			outputJson: { _metadata: { execDurationMs: 8_366 } },
		};
		await render({ ...base, detail });
		expect(document.body.textContent).toContain("STREAM 4.8s");
		expect(document.body.textContent).toContain("WAIT 67ms");
		expect(document.body.textContent).toContain("SPAN 8.4s");
		expect(document.body.textContent).toContain("TOTAL 13s");
		await render({
			...base,
			detail: {
				...detail,
				outputJson: {
					_metadata: {
						execDurationMs: 8_366,
						fileChangeTiming: { waitMs: 8_000, executionMs: 300, totalMs: 8_300 },
					},
				},
			},
		});
		expect(document.body.textContent).toContain("WAIT 8.1s");
		expect(document.body.textContent).toContain("OPERATION 366ms");
		expect(document.body.textContent).not.toContain("SPAN 8.4s");
	});
});

describe("ToolCallInspector exact refs", () => {
	test("simultaneous identical provider IDs each render their own initial row's full payload", async () => {
		await render([
			{ ...base, initialToolCall: { id: "row-one", messageId: "msg-one", executionAttempt: 1 } },
			{ ...base, initialToolCall: { id: "row-two", messageId: "msg-two", executionAttempt: 1 } },
		]);
		expect(calls).toHaveLength(2);
		for (const url of calls) {
			expect(document.body.textContent).toContain(bodyFor(url).inputJson);
			expect(document.body.textContent).toContain(bodyFor(url).outputJson);
		}
		expect(Object.fromEntries(calls[0].searchParams)).toEqual({
			toolCallId: "row-one",
			messageId: "msg-one",
		});
		expect(Object.fromEntries(calls[1].searchParams)).toEqual({
			toolCallId: "row-two",
			messageId: "msg-two",
		});
	});

	test("switching row, attempt, COW message or narrator never renders the previous payload", async () => {
		await render({
			...base,
			initialToolCall: { id: "row", messageId: "msg", executionAttempt: 1 },
		});
		const oldBody = bodyFor(calls[0]);
		await render({
			...base,
			initialToolCall: { id: "retry-row", messageId: "msg", executionAttempt: 2 },
		});
		expect(calls).toHaveLength(2);
		expect(document.body.textContent).not.toContain(oldBody.outputJson);
		await render({ ...base, toolCallId: "retry-row", messageId: "cow-msg", executionAttempt: 2 });
		expect(calls).toHaveLength(3);
		expect(document.body.textContent).not.toContain(bodyFor(calls[1]).outputJson);
		await render({
			...base,
			narratorId: "n2",
			toolCallId: "retry-row",
			messageId: "cow-msg",
			executionAttempt: 2,
		});
		expect(calls).toHaveLength(4);
		expect(document.body.textContent).not.toContain(bodyFor(calls[2]).outputJson);
	});

	test("explicit refs and message-only deep links are passed verbatim, with no guessed PK", async () => {
		await render({
			...base,
			toolCallId: "explicit",
			messageId: "explicit-msg",
			initialToolCall: { id: "old" },
		});
		expect(Object.fromEntries(calls[0].searchParams)).toEqual({
			toolCallId: "explicit",
			messageId: "explicit-msg",
		});
		await render({ ...base, messageId: "message-only" });
		expect(Object.fromEntries(calls[1].searchParams)).toEqual({ messageId: "message-only" });
	});

	test("unqualified deep links leave ambiguity to the backend instead of choosing a cached row", async () => {
		client.setQueryData(toolCallDetailQueryKey("n1", "shared-sdk-id", { toolCallId: "hidden" }), {
			outputJson: "wrong body",
		});
		globalThis.fetch = (async (input: string | URL | Request) => {
			calls.push(new URL(String(input), "https://test.invalid"));
			return Response.json({ error: "ambiguous" }, { status: 409 });
		}) as typeof fetch;
		await render(base);
		expect(calls).toHaveLength(1);
		expect(calls[0].search).toBe("");
		expect(document.body.textContent).not.toContain("wrong body");
		expect(document.body.textContent).toContain("toolCallInspector.loadFailed");
	});

	test("external null preserves loading/error ownership without fallback or cached leakage", async () => {
		client.setQueryData(toolCallDetailQueryKey("n1", "shared-sdk-id"), {
			outputJson: "wrong cached output",
		});
		await render({ ...base, detail: null, detailLoading: true });
		expect(calls).toHaveLength(0);
		expect(document.querySelector(".mantine-Loader-root")).not.toBeNull();
		expect(document.body.textContent).not.toContain("wrong cached output");
		await render({ ...base, detail: null, detailLoading: false, detailError: true });
		expect(calls).toHaveLength(0);
		expect(document.querySelector(".mantine-Loader-root")).toBeNull();
		expect(document.body.textContent).toContain("toolCallInspector.loadFailed");
		await render({ ...base, detail: { outputJson: "external output" } });
		expect(calls).toHaveLength(0);
		expect(document.body.textContent).toContain("external output");
	});
});

test("useToolCallDetail isolates pending cache entries by PK, message, and attempt", async () => {
	const observations: unknown[] = [];
	function Probe({
		ref,
	}: {
		ref: { toolCallId?: string; messageId?: string; executionAttempt?: number };
	}) {
		observations.push(useToolCallDetail("n1", "shared-sdk-id", true, ref).data);
		return null;
	}
	const old = { toolCallId: "row", messageId: "msg", executionAttempt: 1 };
	client.setQueryData(toolCallDetailQueryKey("n1", "shared-sdk-id", old), {
		outputJson: "previous",
	});
	globalThis.fetch = (async () => new Promise(() => {})) as unknown as typeof fetch;
	for (const ref of [
		{ ...old, toolCallId: "new-row" },
		{ ...old, messageId: "cow-msg" },
		{ ...old, executionAttempt: 2 },
	]) {
		root.render(
			<QueryClientProvider client={client}>
				<Probe ref={ref} />
			</QueryClientProvider>,
		);
		await flush();
		expect(observations.at(-1)).toBeUndefined();
	}
});

const rowRefs = [1, 2].map((index) => ({
	toolUseId: "repeated/provider-id",
	toolCallId: `row-${index}`,
	messageId: `message-${index}`,
	executionAttempt: index,
}));

function toolItems() {
	const messages = rowRefs.map((ref) => ({
		id: ref.messageId,
		role: "assistant",
		contentJson: [
			{
				type: "tool_use",
				id: ref.toolUseId,
				tcId: ref.toolCallId,
				executionAttempt: ref.executionAttempt,
				name: "Bash",
				status: "success",
				inputJson: { command: "same content" },
				outputJson: "same content",
			},
		],
		toolCalls: [],
		children: [],
	})) as unknown as NarratorMsg[];
	const segment = segmentMessages(messages)[0];
	if (segment?.kind !== "tool-run") throw new Error("expected tool segment");
	return segment.items as unknown as import("../vlist/segment-adapter").AdapterToolItem[];
}

async function rowAct(update: () => void) {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	try {
		await act(async () => {
			update();
			await flush();
		});
	} finally {
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
}

async function renderRowNodes(children: ReactNode) {
	await rowAct(() => {
		root.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">{children}</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	});
	await flush();
}

async function inspectRow(index: number) {
	const row = document.querySelector(`[data-test-tool-row="${index}"]`);
	if (!row) throw new Error("row missing");
	await rowAct(() => {
		const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
		Object.assign(event, { clientX: 100, clientY: 100 });
		row.dispatchEvent(event);
	});
	const entry = [...document.querySelectorAll(".mantine-Menu-item")].find(
		(item) => item.textContent?.trim() === "toolCallInspector.inspect",
	);
	if (!entry) throw new Error(`inspect entry missing: ${document.body.textContent}`);
	await rowAct(() => {
		(entry as HTMLElement).click();
	});
	await flush();
}

function assertOwnRequests() {
	expect(calls).toHaveLength(2);
	for (const [index, url] of calls.entries()) {
		expect(decodeURIComponent(url.pathname.split("/tool-calls/")[1])).toBe(
			rowRefs[index].toolUseId,
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			toolCallId: rowRefs[index].toolCallId,
			messageId: rowRefs[index].messageId,
		});
	}
}

describe("row menu click → real Inspector fetch", () => {
	test("standalone repeated tools use card-owned refs, not the selection message or suffixed key", async () => {
		const specs = adaptSegment(
			{ kind: "tool-run", items: toolItems(), sourceMessages: [] },
			{ lod: 5 },
		);
		await renderRowNodes(
			specs.map((spec, index) => {
				// The document's display-key deduplication is not a provider ID.
				const displayedId = `${spec.key.slice(5)}${index ? `#${index}` : ""}`;
				const ref = toolDetailRequestFromData(displayedId, spec.data);
				return (
					<VListRowInteraction
						key={displayedId}
						blockId={`tc-${displayedId}`}
						messageId="wrong-selection-message"
						blockIndex={0}
						actions={{ messageId: "wrong-selection-message" }}
						narratorId="n1"
						toolUseId={displayedId}
						toolDetailRef={ref}
					>
						<div data-test-tool-row={index}>tool {index}</div>
					</VListRowInteraction>
				);
			}),
		);
		expect(calls).toHaveLength(0);
		await inspectRow(0);
		await inspectRow(1);
		assertOwnRequests();
	});

	test.each([
		false,
		true,
	])("folded trace (drilled=%s) gets exact refs through the real measure cache", async (drilled) => {
		const { installCanvasStub } = await import("../vlist/measure/test-canvas-stub");
		installCanvasStub();
		const spec = adaptActivityUnit(
			toolItems().map((item, index) => ({ ...item, kind: "tool" as const, dedupeSuffix: index })),
			"trace",
			{
				lod: 2,
				isRowExpanded: () => drilled,
			},
		);
		const measured = measureElementCached(
			"activity-trace",
			spec.data,
			600,
			2,
			spec.opts,
			spec.key,
			"doc",
		) as import("../vlist/measure/measure-tool-run").MeasuredCollapsibleTrace;
		await renderRowNodes(
			measured.rows.map((row, index) => {
				expect(Boolean(row.cardMeasured)).toBe(drilled);
				return (
					<TraceRowInteraction
						key={row.key}
						identity={{
							blockId: `tc-${row.identity?.toolUseId}`,
							messageId: "wrong-selection-message",
							blockIndex: 0,
							tool: { toolName: "Bash", toolUseId: row.identity?.toolUseId },
						}}
						actions={{ messageId: "wrong-selection-message" }}
						narratorId="n1"
						toolDetailRef={row.identity?.toolDetailRef}
					>
						<div data-test-tool-row={index}>trace {index}</div>
					</TraceRowInteraction>
				);
			}),
		);
		expect(calls).toHaveLength(0);
		await inspectRow(0);
		await inspectRow(1);
		assertOwnRequests();
	});

	test.each([
		"row",
		"trace",
	])("%s without persisted refs never guesses a message from selection", async (kind) => {
		globalThis.fetch = (async (input: string | URL | Request) => {
			calls.push(new URL(String(input), "https://test.invalid"));
			return Response.json({ error: "ambiguous" }, { status: 409 });
		}) as typeof fetch;
		const props = { messageId: "wrong-selection-message", blockIndex: 0, blockId: "tc-repeated" };
		await renderRowNodes(
			kind === "row" ? (
				<VListRowInteraction
					{...props}
					actions={{ messageId: props.messageId }}
					narratorId="n1"
					toolUseId="repeated"
				>
					<div data-test-tool-row="0">legacy row</div>
				</VListRowInteraction>
			) : (
				<TraceRowInteraction
					identity={{ ...props, tool: { toolName: "Bash", toolUseId: "repeated" } }}
					actions={{ messageId: props.messageId }}
					narratorId="n1"
				>
					<div data-test-tool-row="0">legacy trace</div>
				</TraceRowInteraction>
			),
		);
		await inspectRow(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].search).toBe("");
		expect(document.body.textContent).toContain("toolCallInspector.loadFailed");
	});
});
