import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { parseHTML } from "linkedom";
import { act, useMemo, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { shellModule } from "./guard-source";
import { installCanvasStub } from "./measure/test-canvas-stub";
import {
	type PretextLayoutBuildOptions,
	PretextLayoutCoordinator,
	type PretextLayoutCoordinatorSnapshot,
} from "./pretext-layout-coordinator";
import { resolveRenderExtra } from "./render-registry";
import { sliceBracketedRegion } from "./source-slice";
import type { VListRenderLabels } from "./useVListLabels";
import { useVListTraceBindings } from "./useVListTraceBindings";
import type { VListViewTarget } from "./vlist-content-view-target";
import { computeToolRunFrames } from "./vlist-exact-layout";
import {
	ownerRequestKey,
	resolveItemViewTargets,
	resolveTraceRowViewTargets,
} from "./vlist-exact-row-state";
import { retainKeysInPlace } from "./vlist-head-trim";
import { pruneHeightOverrides } from "./vlist-height-overrides";
import { createVListInteractionState, isFullPayloadRequestedRow } from "./vlist-interaction-state";
import { usePermissionSlots, useTracePermissionSlots } from "./vlist-permission-bridge";
import type { VListItem } from "./vlist-pipeline";
import { resolveSpecTaskLiveGate } from "./vlist-spec-task-live";
import { hostsUnpredictableBlock } from "./vlist-unpredictable-blocks";
import * as markerRuntime from "./vlist-user-markers";

const source = shellModule("PretextExactMessageList.tsx");

/** Execute the production declarations, including their actual hook dependencies. */
function declaration(name: string, call: string): string {
	const start = source.indexOf(`const ${name} = ${call}`);
	if (start < 0) throw new Error(`Missing metadata declaration: ${name}`);
	const end = source.indexOf("(", start);
	const anchor = source.slice(start, end + 1);
	const result = sliceBracketedRegion(source, anchor);
	if (!result) throw new Error(`Unterminated metadata declaration: ${name}`);
	return `${result};`;
}

const geometryStart = source.indexOf("const renderItems = pretextDocument.items;");
const geometryEnd = source.indexOf("const renderItemsRef = useRef(renderItems);", geometryStart);
if (geometryStart < 0 || geometryEnd < geometryStart) throw new Error("Missing metadata facades");

let metadataRuns = 0;
const runtime = {
	useMemo: (build: () => unknown, deps: readonly unknown[]) =>
		useMemo(
			() => {
				metadataRuns++;
				return build();
			},
			// biome-ignore lint/correctness/useExhaustiveDependencies: Execute the production memo's own dependencies, not a test substitute.
			deps,
		),
	usePermissionSlots,
	useTracePermissionSlots,
	useVListTraceBindings,
	computeToolRunFrames,
	resolveSpecTaskLiveGate,
	hostsUnpredictableBlock,
	pruneHeightOverrides,
	resolveItemViewTargets,
	resolveTraceRowViewTargets,
	resolveRenderExtra,
	isFullPayloadRequestedRow,
	ownerRequestKey,
};

interface MetadataInput {
	pretextDocument: PretextLayoutCoordinatorSnapshot;
	contentWidth: number;
	rowWidthsRef: { current: Pick<ReadonlyMap<string, number>, "get"> };
	measuredByKeyRef: { current: Pick<ReadonlyMap<string, VListItem["measured"]>, "get"> };
	heightOverrideWidthsRef: { current: Map<string, number> };
	heightOverrides: ReadonlyMap<string, number>;
	editingRow: { key: string } | null;
	openTarget: VListViewTarget | null;
	renderLabels: VListRenderLabels;
}
interface MetadataResult {
	semanticItems: readonly VListItem[];
	semanticManifestItems: NonNullable<PretextLayoutCoordinatorSnapshot["manifest"]>["items"];
	permissionSlotByKey: ReturnType<typeof usePermissionSlots>;
	tracePermissionSlotsByKey: ReturnType<typeof useTracePermissionSlots>;
	traceBindingsByKey: ReturnType<typeof useVListTraceBindings>;
	dynamicRowKeys: ReadonlySet<string>;
	effectiveHeightOverrides: ReadonlyMap<string, number>;
	toolRunFrames: ReturnType<typeof computeToolRunFrames>;
	specTaskLiveGate: ReturnType<typeof resolveSpecTaskLiveGate>;
	sourceIdsByKey: ReadonlyMap<string, readonly string[]>;
	openTargetState: { target?: VListViewTarget; loading: boolean };
}

const metadataCode = `
	const { ${Object.keys(runtime).join(", ")} } = runtime;
	return function metadata(input, stable) {
		const { pretextDocument, contentWidth, rowWidthsRef, measuredByKeyRef,
			heightOverrideWidthsRef, heightOverrides, editingRow, openTarget, renderLabels } = input;
		const { narratorId, permCb, rowToolMetaIndex, reflectionIndex,
			activeInteraction, tailMeta, selectionIndex, rowHandlers } = stable;
		const isActive = false;
		${source.slice(geometryStart, geometryEnd)}
		${declaration("permissionSlotByKey", "usePermissionSlots")}
		${declaration("tracePermissionSlotsByKey", "useTracePermissionSlots")}
		${declaration("dynamicRowKeys", "useMemo")}
		${declaration("effectiveHeightOverrides", "useMemo")}
		${declaration("toolRunFrames", "useMemo")}
		${declaration("specTaskLiveGate", "useMemo")}
		${declaration("sourceIdsByKey", "useMemo")}
		${declaration("traceBindingsByKey", "useVListTraceBindings")}
		${declaration("openTargetState", "useMemo")}
		return { semanticItems, semanticManifestItems, permissionSlotByKey,
			tracePermissionSlotsByKey, dynamicRowKeys, effectiveHeightOverrides,
			toolRunFrames, specTaskLiveGate, sourceIdsByKey, traceBindingsByKey, openTargetState };
	};
`;
const transpiler = new Bun.Transpiler({ loader: "tsx" });
const executeMetadata = new Function("runtime", transpiler.transformSync(metadataCode))(
	runtime,
) as (input: MetadataInput, stable: ReturnType<typeof stableInputs>) => MetadataResult;

const labels = {
	reasoning: { reasoning: "Reasoning", thinking: "Thinking" },
	toolCall: { sections: {} },
	subagent: { prompt: "Prompt" },
} as VListRenderLabels;
function stableInputs() {
	return {
		narratorId: "metadata-resize",
		permCb: undefined,
		rowToolMetaIndex: new Map(),
		reflectionIndex: new Map(),
		activeInteraction: createVListInteractionState(5),
		tailMeta: {},
		selectionIndex: null,
		rowHandlers: undefined,
	};
}

let disposeCanvas: () => void;
let root: Root | undefined;
let host: HTMLDivElement;
let result: MetadataResult;
let rowWidths: MetadataInput["rowWidthsRef"]["current"];
let measured: MetadataInput["measuredByKeyRef"]["current"];
const widthStamps = { current: new Map<string, number>() };
const emptyOverrides = new Map<string, number>();

beforeAll(() => {
	disposeCanvas = installCanvasStub();
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
});
afterAll(() => disposeCanvas());
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	host?.remove();
	metadataRuns = 0;
	widthStamps.current.clear();
});

function Harness(props: Pick<MetadataInput, "pretextDocument"> & Partial<MetadataInput>) {
	const stable = useRef(stableInputs()).current;
	const rowWidthsRef = useRef<MetadataInput["rowWidthsRef"]["current"]>(new Map());
	const measuredByKeyRef = useRef<MetadataInput["measuredByKeyRef"]["current"]>(new Map());
	result = executeMetadata(
		{
			contentWidth: 860,
			rowWidthsRef,
			measuredByKeyRef,
			heightOverrideWidthsRef: widthStamps,
			heightOverrides: emptyOverrides,
			editingRow: null,
			openTarget: null,
			renderLabels: labels,
			...props,
		},
		stable,
	);
	rowWidths = rowWidthsRef.current;
	measured = measuredByKeyRef.current;
	return null;
}
function render(
	snapshot: PretextLayoutCoordinatorSnapshot,
	extra: Partial<MetadataInput> = {},
): MetadataResult {
	if (!root) {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	}
	act(() => root?.render(<Harness pretextDocument={snapshot} {...extra} />));
	return result;
}

const build: PretextLayoutBuildOptions = {
	lod: 5,
	widthBucket: "860",
	contentWidth: 860,
	viewportHeight: 260,
	topPadding: 16,
	bottomPadding: 24,
	gap: 4,
};
const view = () => ({ scrollTop: 0, viewportHeight: 260, pinnedToBottom: false });
let fixtureId = 0;
async function fixture() {
	const narratorId = `metadata-fixture-${++fixtureId}`;
	const messages: TreeMessage[] = Array.from({ length: 120 }, (_, seq) => ({
		id: `${narratorId}-m${seq}`,
		narratorId,
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", text: `Paragraph ${seq}. ${"Wrapping content. ".repeat(20)}` }],
		contentText: null,
		toolCalls: [],
		createdAt: "2026-08-01T00:00:00.000Z",
		children: [],
		seq,
	}));
	const coordinator = new PretextLayoutCoordinator();
	await coordinator.load(narratorId, build, {
		fetchPage: async (_id, options) => {
			const eligible = messages.filter((message) =>
				options.beforeSeq == null ? true : (message.seq ?? 0) < options.beforeSeq,
			);
			const page = eligible.slice(-options.limit);
			return {
				messages: page,
				messageVersion: 1,
				minSeq: page[0]?.seq ?? null,
				maxSeq: page.at(-1)?.seq ?? null,
				hasPrev: (page[0]?.seq ?? 0) > 0,
				hasNext: false,
			};
		},
	});
	while (coordinator.getSnapshot().hasPrev) await coordinator.loadOlder(build, view);
	expect(coordinator.getSnapshot().items).toHaveLength(120);
	return { coordinator, messages };
}

function complete(coordinator: PretextLayoutCoordinator) {
	const snapshot = coordinator.getSnapshot();
	if (!snapshot.items || !snapshot.index || !snapshot.semanticItems || !snapshot.semanticManifest)
		throw new Error("Expected a full semantic document");
	return { ...snapshot, items: snapshot.items, index: snapshot.index };
}

describe("width previews retain production semantic metadata", () => {
	it("keeps baseline refs and real hook maps stable without re-running metadata memos", async () => {
		const { coordinator } = await fixture();
		const baseline = complete(coordinator);
		const initial = render(baseline);
		const runs = metadataRuns;
		for (const [frame, width] of [420, 480, 520, 420].entries()) {
			coordinator.previewWidth(width, view);
			const snapshot = complete(coordinator);
			expect(snapshot.items).not.toBe(baseline.items);
			expect(snapshot.manifest).not.toBe(baseline.manifest);
			expect(snapshot.semanticItems).toBe(baseline.items);
			expect(snapshot.semanticManifest).toBe(baseline.manifest);
			const current = render(snapshot);
			// Width validation still runs, but scans only the empty override map.
			expect(metadataRuns).toBe(runs + frame + 1);
			for (const name of [
				"permissionSlotByKey",
				"tracePermissionSlotsByKey",
				"traceBindingsByKey",
				"dynamicRowKeys",
				"toolRunFrames",
				"specTaskLiveGate",
				"sourceIdsByKey",
				"openTargetState",
			] as const) {
				expect(current[name]).toBe(initial[name]);
			}
		}
	});

	it("queries current preview widths/measurements in O(1), not the semantic baseline", async () => {
		const { coordinator } = await fixture();
		const baseline = complete(coordinator);
		const firstKey = baseline.items[0]?.spec.key;
		const lastKey = baseline.items.at(-1)?.spec.key;
		if (!firstKey || !lastKey) throw new Error("Expected fixture rows");
		coordinator.previewWidth(420, view);
		const snapshot = complete(coordinator);
		let reads = 0;
		const items = new Proxy(snapshot.items, {
			get(target, key, receiver) {
				if (key === "map" || key === Symbol.iterator) throw new Error("Full geometry scan");
				if (typeof key === "string" && /^\d+$/.test(key)) reads++;
				return Reflect.get(target, key, receiver);
			},
		});
		render({ ...snapshot, items });
		expect(reads).toBe(0);
		expect(rowWidths.get(firstKey)).toBe(420);
		expect(rowWidths.get(lastKey)).toBe(860);
		expect(measured.get(firstKey)).toBe(snapshot.items[0]?.measured);
		expect(measured.get(firstKey)).not.toBe(baseline.items[0]?.measured);
		expect(measured.get(lastKey)).toBe(baseline.items.at(-1)?.measured);
		expect(rowWidths.get("missing")).toBeUndefined();
		expect(measured.get("missing")).toBeUndefined();
		expect(reads).toBe(5);
	});

	it("invalidates only an existing override whose row width changed", async () => {
		const { coordinator } = await fixture();
		const baseline = complete(coordinator);
		const key = baseline.items[0]?.spec.key;
		if (!key) throw new Error("Expected first row");
		const overrides = new Map([[key, 300]]);
		const editingRow = { key };
		widthStamps.current.set(key, 860);
		const initial = render(baseline, { heightOverrides: overrides, editingRow });
		expect(initial.effectiveHeightOverrides).toBe(overrides);
		coordinator.previewWidth(420, view);
		const current = render(complete(coordinator), { heightOverrides: overrides, editingRow });
		expect(current.dynamicRowKeys).toBe(initial.dynamicRowKeys);
		expect(current.effectiveHeightOverrides.size).toBe(0);
		expect(overrides.get(key)).toBe(300);
	});

	it("refreshes modal bytes on a semantic content commit during an active preview", async () => {
		const { coordinator, messages } = await fixture();
		const baseline = complete(coordinator);
		const first = baseline.items[0];
		if (!first) throw new Error("Expected first row");
		const openTarget = resolveItemViewTargets(
			first,
			labels,
			resolveRenderExtra(first.spec),
			true,
		)[0];
		if (!openTarget) throw new Error("Expected markdown fullscreen target");
		const initial = render(baseline, { openTarget });
		coordinator.previewWidth(420, view);
		expect(render(complete(coordinator), { openTarget }).openTargetState).toBe(
			initial.openTargetState,
		);
		const message = messages[0];
		if (!message) throw new Error("Expected first message");
		const text = "Fresh complete modal bytes after the payload landed.";
		expect(
			coordinator.upsertMessage({ ...message, contentJson: [{ type: "text", text }] }, false, view),
		).toBe(true);
		const committed = complete(coordinator);
		expect(committed.semanticItems).not.toBe(baseline.semanticItems);
		expect(committed.semanticManifest).not.toBe(baseline.semanticManifest);
		const refreshed = render(committed, { openTarget });
		expect(refreshed.openTargetState.target?.text).toBe(text);
		expect(refreshed.sourceIdsByKey).not.toBe(initial.sourceIdsByKey);
	});

	it("re-keys semantic metadata on full width, LOD, expansion and language builds", async () => {
		const { coordinator } = await fixture();
		let previous = render(complete(coordinator));
		for (const options of [
			{ ...build, contentWidth: 420, widthBucket: "420" },
			{ ...build, lod: 4 as const },
			{ ...build, isExpanded: () => true },
			{ ...build, labelsRevision: "zh-CN" },
		]) {
			coordinator.rebuild(options, undefined, 260);
			const snapshot = complete(coordinator);
			expect(snapshot.semanticItems).toBe(snapshot.items);
			expect(snapshot.semanticManifest).toBe(snapshot.manifest);
			const current = render(snapshot);
			expect(current.semanticItems).not.toBe(previous.semanticItems);
			expect(current.dynamicRowKeys).not.toBe(previous.dynamicRowKeys);
			expect(current.traceBindingsByKey).not.toBe(previous.traceBindingsByKey);
			expect(current.sourceIdsByKey).not.toBe(previous.sourceIdsByKey);
			previous = current;
		}
	});
});

const markerStart = source.indexOf("const scrollableHeight =");
const markerEnd = source.indexOf("const handleUserMarkerJump", markerStart);
if (markerStart < 0 || markerEnd < markerStart) throw new Error("Missing marker declarations");
const executeMarkers = new Function(
	"runtime",
	transpiler.transformSync(`
		const { useMemo, ${Object.keys(markerRuntime).join(", ")} } = runtime;
		return function markers(renderItems, semanticItems, exactLayout, footerHeight) {
			${source.slice(markerStart, markerEnd)}
			return { userMarkers, compactMarkers };
		};
	`),
)({ useMemo, ...markerRuntime }) as (
	items: readonly VListItem[],
	semanticItems: readonly VListItem[],
	layout: { items: readonly { top: number }[]; totalHeight: number },
	footer: number,
) => {
	userMarkers: markerRuntime.VListUserMarker[];
	compactMarkers: markerRuntime.VListCompactMarker[];
};

it("projects production markers across width/footer frames without reading offscreen bodies", async () => {
	const { coordinator, messages } = await fixture();
	const last = messages.at(-1);
	if (!last) throw new Error("Missing last message");
	const previous = messages.at(-2);
	if (!previous) throw new Error("Missing compact message");
	coordinator.upsertMessage(
		{
			...previous,
			role: "user",
			contentJson: [{ type: "segment_compact", status: "failed", error: "Historical failure" }],
		},
		false,
		view,
	);
	coordinator.upsertMessage({ ...last, role: "user" }, false, view);
	const baseline = complete(coordinator);
	const item = baseline.items.at(-1);
	if (!item) throw new Error("Missing last item");
	const data = item.spec.data as { text: string; createdAt: string };
	let reads = 0;
	Object.defineProperty(data, "text", {
		configurable: true,
		get() {
			reads++;
			return "A giant human turn. ".repeat(100_000);
		},
	});
	const compactItem = baseline.items.find((row) => row.spec.kind === "system-text");
	if (!compactItem) throw new Error("Missing failed compact card");
	const compactData = compactItem.spec.data as { title: string; text: string };
	const compactTitle = compactData.title;
	let compactReads = 0;
	Object.defineProperty(compactData, "title", {
		configurable: true,
		get() {
			compactReads++;
			return compactTitle;
		},
	});
	Object.defineProperty(compactData, "text", {
		configurable: true,
		get() {
			throw new Error("Compact marker must not read the error body");
		},
	});
	let markers: ReturnType<typeof executeMarkers> | undefined;
	function Markers({ snapshot, footer }: { snapshot: typeof baseline; footer: number }) {
		const index = snapshot.index;
		const layout = useMemo(
			() => ({
				items: snapshot.items.map((_, i) => ({ top: index.itemStart(i) })),
				totalHeight: index.totalHeight,
			}),
			[index, snapshot.items],
		);
		markers = executeMarkers(snapshot.items, snapshot.semanticItems ?? [], layout, footer);
		return null;
	}
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root?.render(<Markers snapshot={baseline} footer={100} />));
	const first = markers?.userMarkers[0];
	if (!first) throw new Error("Missing human marker");
	expect(first.key).toBe(item.spec.key);
	expect(first.ordinal).toBe(1);
	expect(first.createdAt).toBe(last.createdAt);
	expect(first.preview).toStartWith("A giant human turn.");
	const firstCompact = markers?.compactMarkers[0];
	if (!firstCompact) throw new Error("Missing compact marker");
	expect(firstCompact.key).toBe(compactItem.spec.key);
	expect(firstCompact.tooltip).toBe(compactTitle);
	expect(firstCompact.status).toBe("failed");
	const baselineReads = reads;
	const baselineCompactReads = compactReads;
	for (const [frame, width] of [420, 480, 520, 420].entries()) {
		coordinator.previewWidth(width, view);
		const snapshot = complete(coordinator);
		const footer = 150 + frame;
		act(() => root?.render(<Markers snapshot={snapshot} footer={footer} />));
		const current = markers?.userMarkers[0];
		expect(reads).toBe(baselineReads);
		expect(compactReads).toBe(baselineCompactReads);
		const compact = markers?.compactMarkers[0];
		expect(compact?.tooltip).toBe(compactTitle);
		expect(compact?.status).toBe("failed");
		expect(compact?.top).toBe(snapshot.index.itemStart(firstCompact.itemIndex));
		expect(compact?.fraction).toBe(
			snapshot.index.itemStart(firstCompact.itemIndex) / (snapshot.index.totalHeight + footer),
		);
		expect(current?.key).toBe(first.key);
		expect(current?.preview).toBe(first.preview);
		expect(current?.createdAt).toBe(first.createdAt);
		expect(current?.top).toBe(snapshot.index.itemStart(first.itemIndex));
		expect(current?.fraction).toBe(
			snapshot.index.itemStart(first.itemIndex) / (snapshot.index.totalHeight + footer),
		);
	}
});

function productionEffectBefore(marker: string): string {
	const markerIndex = source.indexOf(marker);
	const start = source.lastIndexOf("useEffect(", markerIndex);
	const effect = sliceBracketedRegion(source.slice(start), "useEffect(");
	if (markerIndex < 0 || start < 0 || !effect) throw new Error(`Missing effect: ${marker}`);
	return `${effect};`;
}

it("bounds production row caches through repeated mounts/trims and narrator switches", () => {
	const ref = () => ({ current: new Map<string, unknown>() });
	const state = {
		unknownHeightReporterCacheRef: ref(),
		togglesCacheRef: ref(),
		reflectionTakeOverCacheRef: ref(),
		permissionHeightReportersRef: ref(),
		heightOverrideWidthsRef: ref(),
		resizeDirtyKeysRef: { current: new Set<string>() },
		resizeFormHeightsRef: ref(),
		pendingTrimSweepRef: { current: true },
		appliedMessageRevisionRef: { current: 10 },
		initialRevisionSyncRef: { current: false },
		textReadingDetachedRef: { current: true },
		setMessageRevision: () => {},
		setClosingRows: () => {},
		narratorId: "next-narrator",
	};
	const runtime = {
		retainKeysInPlace,
		useEffect: (effect: () => void) => effect(),
		useCallback: (callback: unknown) => callback,
	};
	const compile = (code: string) =>
		new Function(
			"runtime",
			"state",
			"manifestItems",
			transpiler.transformSync(`
				const { ${Object.keys(runtime).join(", ")} } = runtime;
				const { ${Object.keys(state).join(", ")} } = state;
				${code}
			`),
		);
	const trim = compile(productionEffectBefore("if (!pendingTrimSweepRef.current)"));
	const reset = compile(productionEffectBefore("void narratorId;\n"));
	const reporter = compile(`
		const reportPermissionFormHeight = () => {};
		${declaration("getPermissionHeightReporter", "useCallback")}
		return getPermissionHeightReporter;
	`)(runtime, state, []) as (key: string, width: number) => unknown;
	const rowMaps = [
		state.unknownHeightReporterCacheRef.current,
		state.togglesCacheRef.current,
		state.reflectionTakeOverCacheRef.current,
		state.permissionHeightReportersRef.current,
		state.heightOverrideWidthsRef.current,
	];
	state.resizeFormHeightsRef.current.set("tool-id-not-a-row-key", { requestId: "still-active" });
	for (let round = 0; round < 8; round++) {
		const keys = Array.from({ length: 80 }, (_, index) => `round-${round}-row-${index}`);
		for (const key of keys) {
			reporter(key, 860);
			for (const map of rowMaps) if (!map.has(key)) map.set(key, round);
			state.resizeDirtyKeysRef.current.add(key);
		}
		const live = keys.slice(-10).map((itemKey) => ({ itemKey }));
		state.pendingTrimSweepRef.current = true;
		trim(runtime, state, live);
		for (const map of rowMaps) {
			expect(map.size).toBe(10);
			expect([...map.keys()]).toEqual(live.map((item) => item.itemKey));
		}
		expect(state.resizeDirtyKeysRef.current.size).toBe(10);
		expect(state.resizeFormHeightsRef.current.size).toBe(1);
	}
	reset(runtime, state, []);
	expect(state.textReadingDetachedRef.current).toBe(false);
	for (const map of rowMaps) expect(map.size).toBe(0);
	expect(state.resizeDirtyKeysRef.current.size).toBe(0);
	expect(state.resizeFormHeightsRef.current.size).toBe(1);
});

it("wires every content-only metadata consumer to semantic items rather than preview geometry", () => {
	for (const name of [
		"permissionSlotByKey",
		"tracePermissionSlotsByKey",
		"compact",
		"askInPassing",
		"traceBindingsByKey",
	]) {
		const call =
			name === "compact"
				? "useVListCompactActions"
				: {
						permissionSlotByKey: "usePermissionSlots",
						tracePermissionSlotsByKey: "useTracePermissionSlots",
						askInPassing: "useVListAskInPassing",
						traceBindingsByKey: "useVListTraceBindings",
					}[name];
		expect(declaration(name, call ?? "")).toContain("renderItems: semanticItems");
	}
	for (const name of [
		"truncatedExpandedToolUseIds",
		"openTargetState",
		"dynamicRowKeys",
		"toolRunFrames",
		"specTaskLiveGate",
		"interactionsByKey",
		"editingRowIndex",
		"swipeAnchorRowIndex",
	]) {
		const memo = declaration(name, "useMemo");
		expect(memo).toContain("semanticItems");
		expect(memo).not.toMatch(/\brenderItems\b/);
	}
	for (const name of ["interactionsByKey", "sourceIdsByKey"]) {
		const memo = declaration(name, "useMemo");
		expect(memo).toContain("semanticManifestItems");
		expect(memo).not.toMatch(/\bmanifestItems\b/);
	}
});
