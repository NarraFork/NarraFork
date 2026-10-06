import { expect, test } from "bun:test";
import { type ContextUsageSnapshot, parseContextUsageSnapshot } from "@shared/context-usage";
import {
	contextSnapshotFields,
	contextSnapshotFromHistory,
	legacyContextSnapshot,
} from "./context-usage-state";

const snapshot: ContextUsageSnapshot = {
	requestId: "new",
	startedAt: "2026-01-01",
	source: "upstream",
	percentage: 92.6,
	contextWindow: 1_000_000,
	occupiedTokens: 926_000,
	inputCharacters: null,
	composition: null,
};
const source = await Bun.file(new URL("../useNarratorPanelWS.ts", import.meta.url)).text();
const liveStart = source.indexOf("\t\t\tonContextUsage:");
const liveEnd = source.indexOf("\t\t\tonQuotaBalance:", liveStart);
const hydrateStart = source.indexOf(
	"\tuseEffect(() => {",
	source.lastIndexOf("// --- Initialize context state"),
);
const hydrateEnd =
	source.indexOf("\n\t}, [initialMessageStatus, narratorId]);", hydrateStart) +
	"\n\t}, [initialMessageStatus, narratorId]);".length;
if (liveStart < 0 || liveEnd < 0 || hydrateStart < 0 || hydrateEnd < hydrateStart)
	throw new Error("Context callback boundaries missing");
const transpiler = new Bun.Transpiler({ loader: "ts" });
function stateMachine() {
	const contextInitRef = { current: false };
	const contextLiveRef = { current: false };
	let state: Record<string, unknown> = {};
	let dispatches = 0;
	let invalidations = 0;
	const scope = {
		narratorId: "fixture",
		suppressMessageDerivedCompactingRef: { current: false },
		withoutCompactingSubstatus: (values: string[]) =>
			values.filter((value) => value !== "compacting"),
		statusState: { substatus: ["compacting"] },
		qc: {
			setQueryData: () => {},
			invalidateQueries: () => {
				invalidations++;
			},
		},
		contextCompositionSignatureRef: { current: null as string | null },
		parseContextUsageSnapshot,
		notifications: { show: () => {} },
		t: (key: string) => key,
		contextInitRef,
		contextLiveRef,
		contextSnapshotFields,
		contextSnapshotFromHistory,
		legacyContextSnapshot,
		dispatchStatus: (action: { payload: Record<string, unknown> }) => {
			state = { ...state, ...action.payload };
			dispatches++;
		},
	};
	const live = new Function(
		...Object.keys(scope),
		`${transpiler.transformSync(`const callbacks = {${source.slice(liveStart, liveEnd)}};`)} return callbacks.onContextUsage;`,
	)(...Object.values(scope)) as (
		pct: number,
		tokens?: number,
		window?: number,
		estimated?: boolean,
		compactStart?: number,
		snapshot?: ContextUsageSnapshot,
	) => void;
	const hydrate = (initialMessageStatus: unknown) =>
		new Function(
			...Object.keys(scope),
			"initialMessageStatus",
			"useEffect",
			transpiler.transformSync(source.slice(hydrateStart, hydrateEnd)),
		)(...Object.values(scope), initialMessageStatus, (effect: () => void) => effect());
	const compactStart = source.indexOf("\t\t\tonCompactDone:");
	const compactEnd = source.indexOf("\t\t\tonNarratorError:", compactStart);
	const compact = new Function(
		...Object.keys(scope),
		`${transpiler.transformSync(`const callbacks = {${source.slice(compactStart, compactEnd)}};`)} return callbacks.onCompactDone;`,
	)(...Object.values(scope)) as (percent?: number) => void;
	const resetStart = source.indexOf("\t\tcontextInitRef.current = false;");
	const resetEnd = source.indexOf("\t\tsuppressMessageDerivedCompactingRef.current", resetStart);
	const reset = () =>
		new Function(
			...Object.keys(scope),
			transpiler.transformSync(source.slice(resetStart, resetEnd)),
		)(...Object.values(scope));
	return {
		live,
		hydrate,
		compact,
		reset,
		state: () => state,
		dispatches: () => dispatches,
		invalidations: () => invalidations,
	};
}

test("新request和同request补齐校准均刷新composition，重复event不形成请求风暴", () => {
	const machine = stateMachine();
	machine.live(92.6, 510_800, 1_000_000, false, 80, snapshot);
	machine.live(92.6, 510_800, 1_000_000, false, 80, { ...snapshot });
	expect(machine.invalidations()).toBe(1);
	const calibrated = {
		...snapshot,
		inputCharacters: { totalChars: 10_000, systemChars: 100, toolsChars: 50 },
	};
	machine.live(92.6, 510_800, 1_000_000, false, 80, calibrated);
	expect(machine.invalidations()).toBe(2);
	machine.live(92.6, 510_800, 1_000_000, false, 80, { ...calibrated, requestId: "next" });
	expect(machine.invalidations()).toBe(3);
});

test("共享parser丢弃畸形snapshot并安全回落legacy，不保留正文", () => {
	const value = contextSnapshotFromHistory(92.6, {
		context_snapshot: { ...snapshot, percentage: Number.NaN, body: "secret" },
		context_window: 1_000_000,
		prompt_tokens: 510_800,
	});
	expect(value.requestId).toBe("legacy");
	expect(value.occupiedTokens).toBe(926_000);
	expect(value).not.toHaveProperty("body");
	const valid = contextSnapshotFromHistory(null, {
		context_snapshot: { ...snapshot, body: "secret" },
	});
	expect(valid).toEqual(snapshot);
	expect(valid).not.toHaveProperty("body");
});

test("压缩只标记过期直到完整新snapshot到达，切换叙述者清空旧请求再hydrate", () => {
	const machine = stateMachine();
	machine.live(92.6, 510_800, 1_000_000, false, 80, snapshot);
	machine.compact(10);
	expect(machine.state()).toMatchObject({
		contextSnapshot: snapshot,
		contextPercent: 92.6,
		promptTokens: 926_000,
		contextWindow: 1_000_000,
		contextStale: true,
	});
	const compacted = {
		...snapshot,
		requestId: "compacted",
		percentage: 10,
		occupiedTokens: 100_000,
	};
	machine.live(10, 100_000, 1_000_000, false, 80, compacted);
	expect(machine.state()).toMatchObject({
		contextSnapshot: compacted,
		contextPercent: 10,
		promptTokens: 100_000,
		contextStale: false,
	});
	machine.reset();
	expect(machine.state()).toMatchObject({
		contextSnapshot: null,
		contextPercent: null,
		promptTokens: null,
		contextWindow: null,
		isEstimated: false,
	});
	machine.hydrate({ statusReady: true, turnUsageJson: { context_snapshot: snapshot } });
	expect(machine.state().contextSnapshot).toEqual(snapshot);
});

test("独立上游percentage占用优先于计费prompt，legacy不伪造full chars", () => {
	const value = legacyContextSnapshot(92.6, 510_800, 1_000_000);
	expect(value.occupiedTokens).toBe(926_000);
	expect(value.percentage).toBe(92.6);
	expect(value.source).toBe("upstream");
	expect(value.inputCharacters).toBeNull();
	expect(value.composition).toBeNull();
});
test("仅真实usage使用原始数字，比例不从格式化token倒算", () => {
	const value = contextSnapshotFromHistory(null, {
		input_tokens: 510_800,
		context_window: 1_000_000,
	});
	expect(value.occupiedTokens).toBe(510_800);
	expect(value.percentage).toBeCloseTo(51.08, 10);
	expect(value.percentage?.toFixed(1)).toBe("51.1");
	expect(value.source).toBe("usage");
});
test("hydrate与live原子更新同snapshot，迟到旧hydrate不能覆盖真实事件", () => {
	const machine = stateMachine();
	machine.hydrate({ statusReady: false });
	machine.live(51.08, 510_800, 1_000_000, true, 80, snapshot);
	expect(machine.dispatches()).toBe(1);
	expect(machine.state()).toMatchObject({
		contextSnapshot: snapshot,
		contextPercent: 92.6,
		promptTokens: 926_000,
		contextWindow: 1_000_000,
		isEstimated: false,
		contextStale: false,
		activeCompactStart: 80,
	});
	machine.hydrate({
		statusReady: true,
		contextPercent: 10,
		turnUsageJson: { context_window: 200_000, prompt_tokens: 20_000, is_estimated: true },
	});
	expect(machine.dispatches()).toBe(1);
	expect(machine.state().contextSnapshot).toEqual(snapshot);
});
test("刷新历史context_snapshot与实时相同，真实event清除估计标记，模型切换不混window", () => {
	const machine = stateMachine();
	const estimated = { ...snapshot, source: "estimate" as const };
	machine.hydrate({
		statusReady: true,
		contextPercent: 51,
		turnUsageJson: { context_snapshot: estimated, prompt_tokens: 510_800 },
	});
	expect(machine.state()).toMatchObject({ promptTokens: 926_000, isEstimated: true });
	const newModel = {
		...snapshot,
		requestId: "new-model",
		contextWindow: 200_000,
		occupiedTokens: 102_160,
		percentage: 51.08,
		source: "usage" as const,
	};
	machine.live(92.6, 926_000, 1_000_000, true, 85, newModel);
	expect(machine.state()).toMatchObject({
		contextPercent: 51.08,
		promptTokens: 102_160,
		contextWindow: 200_000,
		isEstimated: false,
		activeCompactStart: 85,
	});
	expect(machine.state().contextSnapshot).toEqual(newModel);
});
