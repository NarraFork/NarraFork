/**
 * SubagentActivityLiveSummary.test.tsx — pins the LIVE half of a subagent activity
 * row's label.
 *
 * THE BUG THIS CLOSES
 * A subagent card's "recent calls" rows read their label from a projected input
 * summary. Only the REST/catch-up route produced one (a SQL projection), so a call
 * that appeared WHILE the page was open rendered as a bare `Bash` / `Write` and only
 * gained its detail after a reload. The live `tool_started` / `tool_use_chunk` frames
 * now carry the same projection, computed in memory from the input the server already
 * holds.
 *
 * WHY THE WHOLE CHAIN AND NOT JUST ONE LINK
 * The summary crosses four boundaries between the wire and the pixel — WS payload →
 * `subagentToolEventMeta` → `SubagentToolCallHeader` → `ToolCallData._inputSummary` →
 * the rendered row — and each hop uses a DIFFERENT field name. A per-hop unit test
 * passes happily while the chain is severed one hop later, which is exactly how the
 * bug survived the first round. So these drive the real frontend functions end to end
 * and assert on rendered text.
 *
 * linkedom + createRoot, no browser: the assertions are on text content, not layout.
 * Row GEOMETRY under a long summary is covered by SubagentActivityRowHeight.test.tsx.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { projectSubagentToolInputSummary } from "@shared/subagent-tool-summary";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const realReactI18nextModule = { ...(await import("react-i18next")) };
const realUseNarratorModule = { ...(await import("../../hooks/useNarrator")) };
const realUsePlatformModule = { ...(await import("../../hooks/usePlatform")) };
const realRouterModule = { ...(await import("@tanstack/react-router")) };

mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
// The row itself needs no narrator/router data; SubagentCard's module graph pulls
// these in at import time.
mock.module("../../hooks/useNarrator", () => ({
	...realUseNarratorModule,
	useNarrator: () => ({ data: undefined }),
	useToolCallDetail: () => ({ data: undefined }),
	useInterruptNarrator: () => ({ mutate: () => {}, isPending: false }),
	useAskInPassing: () => ({ isPending: false }),
	useCancelAskInPassing: () => ({ isPending: false }),
}));
mock.module("../../hooks/usePlatform", () => ({
	...realUsePlatformModule,
	usePlatform: () => "linux",
	useFileSystemCapability: () => ({ supported: false }),
	useNarratorPermissionsCapability: () => ({ supported: false }),
	useShareCapability: () => ({ supported: false }),
	useNarratorSubagentsCapability: () => ({
		supported: true,
		detachAttach: true,
		background: true,
		staleRecovery: true,
	}),
}));
mock.module("@tanstack/react-router", () => ({
	...realRouterModule,
	useNavigate: () => () => {},
	useSearch: () => ({}),
}));

const { SubagentActivityRow, subagentHeaderToToolCallData } = await import("./SubagentCard");
const { subagentToolEventMeta } = await import("../../hooks/useNarratorWS");
const { subagentHeaderFromEvent } = await import("./useNarratorChunksWS");
const { subagentActivityPatch } = await import("./vlist/vlist-live-events");
const { upsertSubagentToolCallHeader } = await import("./message-tree-utils");

type SubagentToolCallHeader = import("../../lib/api").SubagentToolCallHeader;
type TreeMessage = import("../../lib/api").TreeMessage;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/**
 * Keys this file publishes on `globalThis`, and their pre-existing descriptors.
 *
 * The realm must not outlive the file: `parseHTML()` mints a fresh `Event` class
 * per call, and a leaked one fails a later file's `dispatchEvent(new Event(…))`
 * instance check. Bun runs every file in one process, so restoring is this file's
 * own responsibility.
 */
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
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
	const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
	const cancelAnimationFrame = (id: number) => clearTimeout(id);
	// linkedom's window is a Proxy over the real globalThis, so `writable: true` is
	// what keeps these from stranding there as readonly and breaking a later file's
	// `Object.assign(window, …)`.
	Object.defineProperties(window, {
		requestAnimationFrame: { configurable: true, writable: true, value: requestAnimationFrame },
		cancelAnimationFrame: { configurable: true, writable: true, value: cancelAnimationFrame },
		matchMedia: { configurable: true, writable: true, value: matchMedia },
	});
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (!savedGlobals.has(key)) savedGlobals.set(key, descriptor);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

function restoreGlobals() {
	for (const [key, descriptor] of savedGlobals) {
		const current = Object.getOwnPropertyDescriptor(globalThis, key);
		if (current && !current.configurable) continue;
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	savedGlobals.clear();
}

/**
 * The exact frame the server now emits to a PARENT page for a child tool call:
 * routing identity plus the projection, and deliberately no `input`.
 *
 * Built by calling the real server-side projector rather than hand-writing the
 * summary, so a change to the key whitelist or the cap shows up here instead of
 * being silently duplicated.
 */
function parentToolStartedFrame(toolName: string, input: Record<string, unknown>) {
	const summary = projectSubagentToolInputSummary(input);
	return {
		type: "tool_started",
		narratorId: "parent-narrator",
		toolCallId: "row-1",
		toolUseId: "child-tool",
		toolName,
		parentToolUseId: "parent-tool",
		subagentNarratorId: "sub-1",
		streamStartedAt: 1_000,
		...(summary ? { inputSummary: summary } : {}),
	} as Record<string, unknown>;
}

/** The chunked path: WS frame → meta → header. */
function headerFromFrame(frame: Record<string, unknown>, status = "running") {
	return subagentHeaderFromEvent(
		frame.toolUseId as string,
		frame.toolName as string,
		status,
		subagentToolEventMeta(frame),
	);
}

async function renderHeader(header: SubagentToolCallHeader) {
	if (!root) throw new Error("test harness is not initialized");
	const currentRoot = root;
	await act(async () => {
		currentRoot.render(
			<MantineProvider env="test">
				<SubagentActivityRow call={subagentHeaderToToolCallData(header)} />
			</MantineProvider>,
		);
	});
}

function summaryText(): string | null {
	const el = container?.querySelector('[data-testid="subagent-activity-summary"]');
	return el ? (el.textContent ?? "") : null;
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	const currentRoot = root;
	await act(async () => currentRoot?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.module("../../hooks/useNarrator", () => realUseNarratorModule);
	mock.module("../../hooks/usePlatform", () => realUsePlatformModule);
	mock.module("@tanstack/react-router", () => realRouterModule);
	mock.restore();
	restoreGlobals();
});

describe("live WS summary reaches the activity row", () => {
	test("tool_started labels the row on its FIRST appearance", async () => {
		// The reported bug in one assertion: this used to render an empty label box
		// until the page was reloaded.
		const frame = parentToolStartedFrame("Bash", {
			description: "列出仓库文件",
			command: "ls -la /repo",
		});
		await renderHeader(headerFromFrame(frame));
		expect(summaryText()).toBe("列出仓库文件");
	});

	test("a file tool renders its basename, not the payload", async () => {
		const frame = parentToolStartedFrame("Write", {
			file_path: "/repo/frontend/components/Widget.tsx",
			content: "x".repeat(200_000),
		});
		await renderHeader(headerFromFrame(frame));
		// `getSummary`'s own formatting, same as the expanded tool card would show.
		expect(summaryText()).toBe("Widget.tsx");
		// The 200KB body never entered the frame, so it cannot reach the DOM.
		expect(container?.innerHTML.length ?? 0).toBeLessThan(20_000);
	});

	test("a frame with no whitelisted key renders no label rather than an empty one", async () => {
		const frame = parentToolStartedFrame("AskUserQuestion", {
			questions: [{ header: "选哪个" }],
		});
		expect(frame).not.toHaveProperty("inputSummary");
		await renderHeader(headerFromFrame(frame));
		expect(summaryText()).toBeNull();
	});

	test("tool_completed's missing summary does not erase the one tool_started set", async () => {
		// The merge is a spread, so this is the case an `inputSummary: undefined` key
		// would break: an ordinary completion carries no summary of its own.
		const started = headerFromFrame(
			parentToolStartedFrame("Bash", { description: "运行测试" }),
			"running",
		);
		const completedFrame = {
			type: "tool_completed",
			narratorId: "parent-narrator",
			toolCallId: "row-1",
			toolUseId: "child-tool",
			toolName: "Bash",
			parentToolUseId: "parent-tool",
			subagentNarratorId: "sub-1",
			status: "success",
			durationMs: 1_200,
		} as Record<string, unknown>;
		const completed = headerFromFrame(completedFrame, "success");
		expect(completed).not.toHaveProperty("inputSummary");

		const merged = upsertSubagentToolCallHeader(
			{ subagentNarratorId: "sub-1", model: null, latestToolCalls: [started] },
			completed,
		);
		const row = merged.latestToolCalls[0];
		expect(row.status).toBe("success");
		await renderHeader(row);
		expect(summaryText()).toBe("运行测试");
	});

	test("a permission-rewritten input relabels the row on completion", async () => {
		const started = headerFromFrame(
			parentToolStartedFrame("Write", { file_path: "/repo/original.ts" }),
			"running",
		);
		const redirected = projectSubagentToolInputSummary({ file_path: "/repo/redirected.ts" });
		const completed = headerFromFrame(
			{
				type: "tool_completed",
				toolUseId: "child-tool",
				toolName: "Write",
				toolCallId: "row-1",
				status: "success",
				...(redirected ? { inputSummary: redirected } : {}),
			},
			"success",
		);
		const merged = upsertSubagentToolCallHeader(
			{ subagentNarratorId: "sub-1", model: null, latestToolCalls: [started] },
			completed,
		);
		await renderHeader(merged.latestToolCalls[0]);
		expect(summaryText()).toBe("redirected.ts");
	});

	test("tool_use_chunk labels the row from partially streamed fields", async () => {
		// The earliest possible label: the streaming JSON parser has completed
		// `file_path` while `content` is still arriving.
		const summary = projectSubagentToolInputSummary({ file_path: "/repo/streaming.ts" });
		const frame = {
			type: "tool_use_chunk",
			toolUseId: "child-tool",
			toolName: "Write",
			toolCallId: "row-1",
			inputCharsTotal: 4_096,
			parentToolUseId: "parent-tool",
			...(summary ? { inputSummary: summary } : {}),
		} as Record<string, unknown>;
		await renderHeader(headerFromFrame(frame, "streaming"));
		expect(summaryText()).toBe("streaming.ts");
	});

	test("an untrusted oversized value is capped before it renders", async () => {
		// A frame that skipped the server projection. The frontend re-normalizes, so
		// the row cannot be used to smuggle a multi-KB string into the label.
		const frame = {
			type: "tool_started",
			toolUseId: "child-tool",
			toolName: "Bash",
			toolCallId: "row-1",
			parentToolUseId: "parent-tool",
			inputSummary: { description: "d".repeat(5_000), command: "c".repeat(5_000) },
		} as Record<string, unknown>;
		const header = headerFromFrame(frame);
		expect(header.inputSummary?.description).toHaveLength(200);
		await renderHeader(header);
		// `getSummary` truncates further for display; the transport cap is the ceiling.
		expect((summaryText() ?? "").length).toBeLessThanOrEqual(200);
	});
});

/**
 * The vlist (pretext) renderer is a SECOND live channel with its own patch builders.
 * It must carry the summary too, or the same bug reappears for readers on that path.
 */
describe("vlist live channel carries the summary", () => {
	function parentDoc(): TreeMessage[] {
		return [
			{
				id: "parent-message",
				narratorId: "parent-narrator",
				role: "assistant",
				parentToolUseId: null,
				contentJson: [{ type: "tool_use", id: "parent-tool", name: "Agent" }],
				contentText: null,
				toolCalls: [{ toolUseId: "parent-tool", toolName: "Agent" }],
				children: [],
				createdAt: "2026-07-17T00:00:00.000Z",
			} as unknown as TreeMessage,
		];
	}

	test("subagentActivityPatch writes the summary onto the parent card", async () => {
		const frame = parentToolStartedFrame("Bash", { description: "编译前端" });
		const meta = subagentToolEventMeta(frame);
		const patched = subagentActivityPatch({
			parentToolUseId: "parent-tool",
			toolUseId: "child-tool",
			toolName: "Bash",
			status: "running",
			toolCallId: meta.toolCallId ?? null,
			createdAt: meta.createdAt ?? null,
			timing: meta.timing ?? null,
			subagentNarratorId: meta.subagentNarratorId ?? null,
			model: meta.model ?? null,
			inputSummary: meta.inputSummary ?? null,
		})(parentDoc());
		const activity = (
			patched.messages[0].contentJson[0] as {
				_subagentActivity?: { latestToolCalls: SubagentToolCallHeader[] };
			}
		)._subagentActivity;
		const row = activity?.latestToolCalls[0];
		expect(row?.inputSummary).toEqual({ description: "编译前端" });
		// Rendered through the same row component the chunked path uses.
		if (!row) throw new Error("activity row missing");
		await renderHeader(row);
		expect(summaryText()).toBe("编译前端");
	});

	test("a null summary leaves an existing label intact", () => {
		const seeded = subagentActivityPatch({
			parentToolUseId: "parent-tool",
			toolUseId: "child-tool",
			toolName: "Bash",
			status: "running",
			inputSummary: { description: "编译前端" },
		})(parentDoc());
		const completed = subagentActivityPatch({
			parentToolUseId: "parent-tool",
			toolUseId: "child-tool",
			toolName: "Bash",
			status: "success",
			inputSummary: null,
		})(seeded.messages);
		const activity = (
			completed.messages[0].contentJson[0] as {
				_subagentActivity?: { latestToolCalls: SubagentToolCallHeader[] };
			}
		)._subagentActivity;
		expect(activity?.latestToolCalls[0]?.status).toBe("success");
		expect(activity?.latestToolCalls[0]?.inputSummary).toEqual({ description: "编译前端" });
	});
});
