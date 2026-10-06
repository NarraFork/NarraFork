import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { AdapterTraceRowIdentity } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TraceRowInteractionProps } from "../trace/TraceRowInteraction";
import { type MeasuredCollapsibleTrace, measureActivityTrace } from "./measure/measure-tool-run";
import { installCanvasStub } from "./measure/test-canvas-stub";
import * as renderRegistry from "./render-registry";
import type { VListRenderLabels } from "./useVListLabels";
import type { RowToggles } from "./vlist-exact-row-state";
import type { VListItem } from "./vlist-pipeline";
import type { VListRowHandlers } from "./vlist-row-actions";
import type { SelectionEntry, SelectionIndex } from "./vlist-selection";
import type { VListToolMeta } from "./vlist-tool-meta";

// Keep the real hook, ExactRow memo, registry, trace renderer and drilled card.
// Only the menu surface is observed: mounting its portals would obscure the
// boundary under test and require unrelated query/dock providers.
const realTraceModule = { ...(await import("../trace/TraceRowInteraction")) };
const surfaces = new Map<string, TraceRowInteractionProps>();
mock.module("../trace/TraceRowInteraction", () => ({
	...realTraceModule,
	TraceRowInteraction: (props: TraceRowInteractionProps) => {
		surfaces.set(props.identity.messageId, props);
		return <div data-trace-message={props.identity.messageId}>{props.children}</div>;
	},
}));
const { ExactRow } = await import("./ExactRow");
const { useVListTraceBindings } = await import("./useVListTraceBindings");
type HookInput = Parameters<typeof useVListTraceBindings>[0];
type Bindings = ReturnType<typeof useVListTraceBindings>;

const noop = () => {};
const toggles: RowToggles = {
	onToggle: noop,
	onToggleItems: noop,
	onToggleEarlier: noop,
	onToggleRow: noop,
	onToggleTranslation: noop,
	onTogglePrompt: noop,
	onToggleFileChanges: noop,
};
const labels = { trace: {}, subagent: { openSession: "open-child" } } as VListRenderLabels;
const sourceIds: readonly string[] = [];
const renderCounts = new Map<unknown, number>();
const realRenderElement = renderRegistry.renderElement;
const renderSpy = spyOn(renderRegistry, "renderElement").mockImplementation(
	(kind, measured, extra) => {
		if (kind === "activity-trace") {
			renderCounts.set(measured, (renderCounts.get(measured) ?? 0) + 1);
		}
		return realRenderElement(kind, measured, extra);
	},
);

beforeAll(() => {
	installCanvasStub();
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = () => ({
		matches: false,
		addEventListener: noop,
		removeEventListener: noop,
		addListener: noop,
		removeListener: noop,
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		matchMedia,
		getComputedStyle: window.getComputedStyle ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	Object.assign(window, { matchMedia });
});

afterAll(() => {
	renderSpy.mockRestore();
	mock.module("../trace/TraceRowInteraction", () => realTraceModule);
});

let root: Root | undefined;
let host: HTMLDivElement;
let bindings: Bindings;
function Harness(props: HookInput & { closingRowKeys?: ReadonlySet<string> }) {
	bindings = useVListTraceBindings(props);
	return (
		<MantineProvider>
			{props.renderItems.map((item) =>
				item?.spec.kind === "activity-trace" ? (
					<ExactRow
						key={item.spec.key}
						item={item}
						top={0}
						height={item.measured.height}
						hitHeight={item.measured.height}
						contentWidth={800}
						itemId={item.spec.key}
						sourceIds={sourceIds}
						interactionSig={props.closingRowKeys ? "closing" : ""}
						toggles={toggles}
						renderLabels={labels}
						narratorId={props.narratorId}
						rowInteraction={bindings.get(item.spec.key)?.rowInteraction}
						resolveRowToolActions={bindings.get(item.spec.key)?.resolveRowToolActions}
						closingRowKeys={props.closingRowKeys}
					/>
				) : null,
			)}
		</MantineProvider>
	);
}
function render(input: HookInput & { closingRowKeys?: ReadonlySet<string> }): Bindings {
	if (!root) {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	}
	act(() => root?.render(<Harness {...input} />));
	return bindings;
}
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	host?.remove();
	surfaces.clear();
	renderCounts.clear();
});

type TraceItem = Parameters<typeof measureActivityTrace>[0][number] & {
	identity?: AdapterTraceRowIdentity;
	toolName?: string;
};
function traceItem(key: string, toolUseId = key, toolName = "Read"): TraceItem {
	return {
		key: `tool-${key}`,
		title: `${toolName} ${key}`,
		toolName,
		hasIcon: true,
		canDrillDown: true,
		identity: {
			messageId: `message-${key}`,
			blockIndex: 0,
			blockIndices: [0],
			toolUseId,
			toolName,
			toolDetailRef: {
				toolCallId: `call-${key}`,
				messageId: `message-${key}`,
				executionAttempt: 1,
			},
		},
		...(toolName === "Agent"
			? {
					cardKind: "subagent-card" as const,
					card: {
						agentType: "general",
						description: key,
						recentCallCount: 1,
						hasRecentCallsButton: true,
						toolUseId,
					},
				}
			: {}),
	};
}
function group(key: string, items = [traceItem(key)], expandedIndices: number[] = []): VListItem {
	return {
		spec: { key, kind: "activity-trace", data: { items } },
		measured: measureActivityTrace(items, 800, { itemsOpened: true, expandedIndices }, {}, 2),
	};
}
function rows(item: VListItem) {
	return (item.measured as MeasuredCollapsibleTrace).rows;
}
function freshItem(item: VListItem): VListItem {
	return { ...item, spec: { ...item.spec, data: structuredClone(item.spec.data) } };
}
function freshFrame(input: HookInput): HookInput {
	const index = input.selectionIndex;
	return {
		...input,
		renderItems: input.renderItems.map((item) => (item ? freshItem(item) : item)),
		selectionIndex: index
			? {
					entries: index.entries.map((entry) => structuredClone(entry)),
					byBlockId: new Map(
						[...index.byBlockId].map(([key, entry]) => [key, structuredClone(entry)]),
					),
				}
			: index,
		rowToolMetaIndex: new Map([...input.rowToolMetaIndex].map(([id, meta]) => [id, { ...meta }])),
		rowHandlers: { ...input.rowHandlers },
	};
}
function frame(items: VListItem[], rowHandlers: VListRowHandlers = {}): HookInput {
	const selectionIndex: SelectionIndex = { entries: [], byBlockId: new Map() };
	const rowToolMetaIndex = new Map<string, VListToolMeta>();
	for (const item of items) {
		for (const row of rows(item)) {
			const identity = row.identity;
			if (!identity) continue;
			const entry: SelectionEntry = {
				blockId: `${identity.toolName === "Agent" ? "sa" : "tc"}-${identity.toolUseId}`,
				messageId: identity.messageId,
				blockIndex: identity.blockIndex,
				blockIndices: [...(identity.blockIndices ?? [identity.blockIndex])],
				copyText: `copy-${identity.messageId}`,
				seq: selectionIndex.entries.length,
				chunkIndex: 0,
			};
			selectionIndex.entries.push(entry);
			selectionIndex.byBlockId.set(`tc-${identity.toolUseId}`, entry);
			selectionIndex.byBlockId.set(`sa-${identity.toolUseId}`, entry);
			selectionIndex.byBlockId.set(`msg-${identity.messageId}-${identity.blockIndex}`, entry);
			if (identity.toolUseId) {
				rowToolMetaIndex.set(identity.toolUseId, {
					toolName: identity.toolName,
					...(identity.toolName === "Read"
						? { filePath: `${identity.toolUseId}.ts`, isFileTool: true, isReadTool: true }
						: { subagentNarratorId: `child-${identity.toolUseId}` }),
				});
			}
		}
	}
	return {
		narratorId: "narrator-a",
		renderItems: items,
		selectionIndex,
		rowToolMetaIndex,
		rowHandlers,
	};
}
function specRows(item: VListItem): TraceItem[] {
	return (item.spec.data as { items: TraceItem[] }).items;
}
function surface(messageId: string): TraceRowInteractionProps {
	const props = surfaces.get(messageId);
	if (!props) throw new Error(`missing interaction: ${messageId}`);
	return props;
}

describe("useVListTraceBindings", () => {
	test("rebuilding every index only repaints the changed tail, not two history groups", () => {
		const input = frame([group("old-a"), group("old-b"), group("tail")]);
		const previous = render(input);
		const next = freshFrame(input);
		next.rowToolMetaIndex.set("tail", { ...next.rowToolMetaIndex.get("tail"), filePath: "new.ts" });
		const current = render(next);
		for (const key of ["old-a", "old-b"]) {
			expect(current.get(key)).toBe(previous.get(key));
			expect(current.get(key)?.rowInteraction).toBe(previous.get(key)?.rowInteraction);
			expect(current.get(key)?.resolveRowToolActions).toBe(
				previous.get(key)?.resolveRowToolActions,
			);
		}
		expect(current.get("tail")).not.toBe(previous.get("tail"));
		expect(input.renderItems.map((item) => renderCounts.get(item?.measured))).toEqual([1, 1, 2]);
	});

	test("file, copy text and precise detail changes refresh only their group", () => {
		const open = mock((_path: string) => {});
		let input = frame([group("a"), group("b")], { onOpenFilePanel: open });
		let previous = render(input);
		for (const patch of [
			(next: HookInput) =>
				next.rowToolMetaIndex.set("a", { toolName: "Read", filePath: "new.ts", isFileTool: true }),
			(next: HookInput) => {
				for (const entry of next.selectionIndex?.byBlockId.values() ?? []) {
					if (entry.messageId === "message-a") entry.copyText = "fresh copy";
				}
			},
			(next: HookInput) => {
				const row = specRows(next.renderItems[0] as VListItem)[0];
				if (row?.identity)
					row.identity.toolDetailRef = {
						toolCallId: "new-call",
						messageId: "new-message",
						executionAttempt: 2,
					};
			},
		]) {
			const next = freshFrame(input);
			patch(next);
			const current = render(next);
			expect(current.get("a")).not.toBe(previous.get("a"));
			expect(current.get("b")).toBe(previous.get("b"));
			previous = current;
			input = next;
		}
		bindings.get("a")?.resolveRowToolActions("tool-a")?.onOpenFilePanel?.();
		expect(open).toHaveBeenLastCalledWith("new.ts");
		expect(surface("message-a").identity.copyText).toBe("fresh copy");
		expect(surface("message-a").toolDetailRef).toEqual({
			toolCallId: "new-call",
			messageId: "new-message",
			executionAttempt: 2,
		});
		expect(renderCounts.get(input.renderItems[0]?.measured)).toBe(4);
		expect(renderCounts.get(input.renderItems[1]?.measured)).toBe(1);
	});

	test("Bash bindings refresh folded and drilled actions when status or callbacks change", () => {
		const detach = mock((_id: string) => {});
		const replacement = mock((_id: string) => {});
		let input = frame([group("bash", [traceItem("bash", "bash", "Bash")]), group("old")], {
			onDetachBash: detach,
		});
		input.rowToolMetaIndex.set("bash", {
			toolName: "Bash",
			toolUseId: "bash",
			isRunningBash: true,
		});
		const first = render(input);
		expect(surface("message-bash").onDetachBash).toBe(detach);
		expect(surface("message-bash").identity.tool).toMatchObject({
			toolName: "Bash",
			toolUseId: "bash",
			isRunningBash: true,
		});
		first.get("bash")?.resolveRowToolActions("tool-bash")?.onDetachBash?.();
		expect(detach).toHaveBeenCalledWith("bash");
		input = freshFrame(input);
		input.rowHandlers = { onDetachBash: replacement };
		const changed = render(input);
		expect(changed.get("bash")).not.toBe(first.get("bash"));
		expect(changed.get("old")).toBe(first.get("old"));
		expect(surface("message-bash").onDetachBash).toBe(replacement);
		changed.get("bash")?.resolveRowToolActions("tool-bash")?.onDetachBash?.();
		expect(replacement).toHaveBeenCalledWith("bash");
		input = freshFrame(input);
		input.rowToolMetaIndex.set("bash", { toolName: "Bash", toolUseId: "bash" });
		const completed = render(input);
		expect(completed.get("bash")).not.toBe(changed.get("bash"));
		expect(completed.get("old")).toBe(first.get("old"));
		expect(surface("message-bash").onDetachBash).toBeUndefined();
		expect(surface("message-bash").identity.tool?.isRunningBash).toBeUndefined();
		expect(completed.get("bash")?.resolveRowToolActions("tool-bash")?.onDetachBash).toBeUndefined();
	});

	test("drilled card opens the current child and lifecycle capabilities follow live meta", () => {
		const open = mock((_id: string) => {});
		const detach = mock((_id: string) => {});
		const cancel = mock((_id: string) => {});
		let input = frame([group("agent", [traceItem("agent", "agent", "Agent")], [0]), group("old")], {
			onViewSubagentSession: open,
			onDetachSubagent: detach,
			onCancelBackgroundTask: cancel,
		});
		const first = render(input);
		act(() => host.querySelector<HTMLButtonElement>("button")?.click());
		expect(open).toHaveBeenLastCalledWith("child-agent");
		for (const meta of [
			{ subagentNarratorId: "new-child" },
			{ subagentNarratorId: "new-child", isBackground: true },
			{ subagentNarratorId: "new-child", isBackground: true, isTerminal: true },
		]) {
			input = freshFrame(input);
			input.rowToolMetaIndex.set("agent", { toolName: "Agent", ...meta });
			const current = render(input);
			expect(current.get("old")).toBe(first.get("old"));
			const actions = current.get("agent")?.resolveRowToolActions("tool-agent");
			act(() => host.querySelector<HTMLButtonElement>("button")?.click());
			expect(open).toHaveBeenLastCalledWith("new-child");
			if (meta.isTerminal) {
				expect(actions?.onDetachSubagent).toBeUndefined();
				expect(actions?.onCancelBackgroundTask).toBeUndefined();
			} else if (meta.isBackground) {
				expect(actions?.onDetachSubagent).toBeUndefined();
				actions?.onCancelBackgroundTask?.();
				expect(cancel).toHaveBeenLastCalledWith("new-child");
			} else {
				actions?.onDetachSubagent?.();
				expect(detach).toHaveBeenLastCalledWith("new-child");
			}
		}
	});

	test("handler shells and unused capabilities reuse bindings, replacement and revocation do not", () => {
		const firstOpen = mock((_path: string) => {});
		const nextOpen = mock((_path: string) => {});
		let input = frame([group("file"), group("agent", [traceItem("agent", "agent", "Agent")])], {
			onOpenFilePanel: firstOpen,
		});
		const first = render(input);
		input = freshFrame(input);
		input.rowHandlers = { ...input.rowHandlers, onOpenChapter: noop };
		expect(render(input).get("file")).toBe(first.get("file"));
		input = freshFrame(input);
		input.rowHandlers = { ...input.rowHandlers, onOpenFilePanel: nextOpen };
		const changed = render(input);
		expect(changed.get("file")).not.toBe(first.get("file"));
		expect(changed.get("agent")).toBe(first.get("agent"));
		changed.get("file")?.resolveRowToolActions("tool-file")?.onOpenFilePanel?.();
		expect(nextOpen).toHaveBeenCalledWith("file.ts");
		expect(firstOpen).not.toHaveBeenCalled();
		input = freshFrame(input);
		input.rowHandlers = {};
		const removed = render(input);
		expect(removed.get("file")).not.toBe(changed.get("file"));
		expect(
			removed.get("file")?.resolveRowToolActions("tool-file")?.onOpenFilePanel,
		).toBeUndefined();
		expect(surface("message-file").onOpenFilePanel).toBeUndefined();
	});

	test("fresh identities beat stale measured identities and repeated tool ids stay row-key isolated", () => {
		const left = traceItem("first", "reused", "Agent");
		const right = traceItem("second", "reused", "Agent");
		right.key = "tool-first#1";
		if (right.identity?.toolDetailRef) right.identity.toolDetailRef.executionAttempt = 2;
		const input = frame([group("retry", [left, right])]);
		const first = render(input);
		expect(surface("message-first").identity.blockId).toBe("sa-reused");
		expect(surface("message-first").toolDetailRef?.executionAttempt).toBe(1);
		expect(surface("message-second").toolDetailRef?.executionAttempt).toBe(2);
		expect(first.get("retry")?.resolveRowToolActions("reused")).toBeUndefined();
		expect(first.get("retry")?.resolveRowToolActions("tool-first")).toBeDefined();
		expect(first.get("retry")?.resolveRowToolActions("tool-first#1")).toBeDefined();
		const next = freshFrame(input);
		const nextRight = specRows(next.renderItems[0] as VListItem)[1];
		if (nextRight?.identity)
			nextRight.identity.toolDetailRef = { toolCallId: "third-call", executionAttempt: 3 };
		expect(render(next).get("retry")).not.toBe(first.get("retry"));
		expect(surface("message-first").toolDetailRef?.executionAttempt).toBe(1);
		expect(surface("message-second").toolDetailRef).toEqual({
			toolCallId: "third-call",
			executionAttempt: 3,
		});
	});

	test("retains bindings for closing rows and falls back to fresh card detail refs", () => {
		const input = frame([group("agent", [traceItem("agent", "agent", "Agent")], [0])]);
		render(input);
		const row = specRows(input.renderItems[0] as VListItem)[0] as TraceItem;
		const nextRow = structuredClone(row);
		if (nextRow.identity) delete nextRow.identity.toolDetailRef;
		nextRow.card = Object.assign({}, nextRow.card, {
			toolDetailRef: { toolCallId: "card-call", executionAttempt: 2 },
		});
		const next = freshFrame(input);
		next.renderItems = [group("agent", [nextRow])];
		render({ ...next, closingRowKeys: new Set(["tool-agent"]) });
		expect(bindings.get("agent")?.resolveRowToolActions("tool-agent")).toBeDefined();
		expect(surface("message-agent").toolDetailRef).toEqual({
			toolCallId: "card-call",
			executionAttempt: 2,
		});
		expect(host.textContent).toContain("open-child");
	});

	test("cleans deleted, cropped and LOD-changed rows and resets on narrator switch", () => {
		const input = frame([group("a"), group("b")]);
		const original = render(input);
		expect(render({ ...input, renderItems: [input.renderItems[0]] }).has("b")).toBe(false);
		const restored = render(input);
		expect(restored.get("a")).toBe(original.get("a"));
		expect(restored.get("b")).not.toBe(original.get("b"));
		const plain = {
			...input.renderItems[0],
			spec: { ...(input.renderItems[0] as VListItem).spec, kind: "tool-call" },
		} as VListItem;
		expect(render({ ...input, renderItems: [plain] }).size).toBe(0);
		const afterLod = render(input);
		expect(afterLod.get("a")).not.toBe(original.get("a"));
		const newNarrator = render({ ...input, narratorId: "narrator-b" });
		expect(newNarrator.get("a")).not.toBe(afterLod.get("a"));
		expect(surface("message-a").narratorId).toBe("narrator-b");
		expect(render(input).get("a")).not.toBe(newNarrator.get("a"));
		expect(surface("message-a").narratorId).toBe("narrator-a");
	});

	test.each([
		{ toolCallId: "new-call" },
		{ messageId: "new-ref-message" },
		{ executionAttempt: 2 },
	])("compares each precise detail field independently: %j", (patch) => {
		const input = frame([group("a"), group("b")]);
		const initial = render(input);
		const next = freshFrame(input);
		const identity = specRows(next.renderItems[0] as VListItem)[0]?.identity;
		if (!identity) throw new Error("missing source identity");
		identity.toolDetailRef = { ...identity.toolDetailRef, ...patch };
		const changed = render(next);
		expect(changed.get("a")).not.toBe(initial.get("a"));
		expect(changed.get("b")).toBe(initial.get("b"));
		expect(surface("message-a").toolDetailRef).toEqual(identity.toolDetailRef);
		expect(render(freshFrame(next)).get("a")).toBe(changed.get("a"));
	});

	test("all tool metadata fields signal their owning group, even without a current action", () => {
		const input = frame([group("a"), group("b")]);
		const changes: VListToolMeta[] = [
			{ toolName: "Write" },
			{ filePath: "changed.ts" },
			{ isReadTool: false },
			{ isFileTool: false },
			{ subagentNarratorId: "child" },
			{ awaitQuestionId: "question" },
			{ awaitQuestionSeq: 17 },
			{ awaitAgentTargetId: "agent-alias" },
			{ awaitAgentNarratorId: "await-child" },
			{ sendTargetNarratorId: "send-child" },
			{ isBackground: true },
			{ isTerminal: true },
			{ resultMessageId: "result" },
		];
		for (const patch of changes) {
			const baseline = render(freshFrame(input));
			const next = freshFrame(input);
			next.rowToolMetaIndex.set("a", { ...next.rowToolMetaIndex.get("a"), ...patch });
			const current = render(next);
			expect(current.get("a")).not.toBe(baseline.get("a"));
			expect(current.get("b")).toBe(baseline.get("b"));
		}
	});

	test("fresh source message coordinates bind actions, including handler replacement and removal", () => {
		const fork = mock((_messageId: string) => {});
		const replacement = mock((_messageId: string) => {});
		const input = frame([group("a"), group("b")], { onForkFromMessage: fork });
		const initial = render(input);
		const next = freshFrame(input);
		const identity = specRows(next.renderItems[0] as VListItem)[0]?.identity;
		if (!identity || !next.selectionIndex) throw new Error("missing source identity/index");
		identity.messageId = "fresh-message";
		identity.blockIndex = 7;
		identity.blockIndices = [7, 9];
		identity.toolUseId = "fresh-tool";
		const entry: SelectionEntry = {
			blockId: "sa-fresh-tool",
			messageId: "fresh-message",
			blockIndex: 7,
			blockIndices: [7, 9],
			copyText: "fresh source text",
			seq: 4,
			chunkIndex: 0,
		};
		next.selectionIndex.byBlockId.set("msg-fresh-message-7", entry);
		next.rowToolMetaIndex.set("fresh-tool", {
			toolName: "Write",
			filePath: "fresh.ts",
			isFileTool: true,
		});
		const changed = render(next);
		expect(changed.get("a")).not.toBe(initial.get("a"));
		expect(changed.get("b")).toBe(initial.get("b"));
		expect(surface("fresh-message").identity).toMatchObject({
			blockId: "sa-fresh-tool",
			messageId: "fresh-message",
			blockIndex: 7,
			blockIndices: [7, 9],
			copyText: "fresh source text",
			tool: { toolUseId: "fresh-tool", filePath: "fresh.ts" },
		});
		surface("fresh-message").actions.onForkFromMessage?.();
		expect(fork).toHaveBeenLastCalledWith("fresh-message");
		const swapped = { ...next, rowHandlers: { onForkFromMessage: replacement } };
		expect(render(swapped).get("a")).not.toBe(changed.get("a"));
		surface("fresh-message").actions.onForkFromMessage?.();
		expect(replacement).toHaveBeenCalledWith("fresh-message");
		render({ ...swapped, rowHandlers: {} });
		expect(surface("fresh-message").actions.onForkFromMessage).toBeUndefined();
	});

	test("retained bindings do not read mutated old indexes, detail objects or handler shells", () => {
		const open = mock((_path: string) => {});
		const input = frame([group("a")], { onOpenFilePanel: open });
		const saved = render(input).get("a");
		const props = surface("message-a");
		const meta = input.rowToolMetaIndex.get("a");
		if (meta) meta.filePath = "mutated.ts";
		for (const entry of input.selectionIndex?.byBlockId.values() ?? []) entry.copyText = "mutated";
		const sourceRef = specRows(input.renderItems[0] as VListItem)[0]?.identity?.toolDetailRef;
		if (sourceRef) sourceRef.executionAttempt = 99;
		if (input.rowHandlers)
			input.rowHandlers.onOpenFilePanel = () => {
				throw new Error("old shell retained");
			};
		saved?.resolveRowToolActions("tool-a")?.onOpenFilePanel?.();
		expect(open).toHaveBeenCalledWith("a.ts");
		expect(props.identity.copyText).toBe("copy-message-a");
		expect(props.toolDetailRef?.executionAttempt).toBe(1);
	});

	test("inner row keys are discarded rather than accumulated across cropping", () => {
		const left = traceItem("a");
		const right = traceItem("b");
		const input = frame([group("one", [left, right])]);
		const first = render(input).get("one");
		const cropped = render({ ...input, renderItems: [group("one", [left])] }).get("one");
		expect(cropped?.resolveRowToolActions("tool-b")).toBeUndefined();
		expect(cropped?.resolveRowToolActions("tool-a")).toBe(first?.resolveRowToolActions("tool-a"));
		const restored = render(input).get("one");
		expect(restored?.resolveRowToolActions("tool-b")).not.toBe(
			first?.resolveRowToolActions("tool-b"),
		);
	});

	test("without a selection entry rows stay plain while tool actions remain available", () => {
		const open = mock((_path: string) => {});
		const input = frame([group("file")], { onOpenFilePanel: open });
		input.selectionIndex = undefined;
		const current = render(input);
		const row = rows(input.renderItems[0] as VListItem)[0];
		if (!row) throw new Error("missing measured row");
		expect(current.get("file")?.rowInteraction(row, <span />)).toBeNull();
		current.get("file")?.resolveRowToolActions("tool-file")?.onOpenFilePanel?.();
		expect(open).toHaveBeenCalledWith("file.ts");
	});
});
