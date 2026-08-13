/**
 * live-patch-measure-audit.test.ts — Audits the measurement-cache key against
 * every field the LIVE PATCH channel writes (see vlist-live-patch.ts).
 *
 * Why this file exists
 * --------------------
 * A live patch mutates an already-loaded message and then rebuilds the layout
 * from the SAME input, so `documentRevision` (the narrator messageVersion) does
 * not necessarily move — reflections do not bump it at all. The only thing that
 * can invalidate a stale cached height is `extractDataRevision`. If a patched
 * field changes a card's HEIGHT but is absent from the revision, the rebuild
 * silently serves the pre-patch geometry: the card shows its new status inside a
 * box sized for the old one (clipped output, or a tall empty gap).
 *
 * So for each patched field this file establishes ONE of two facts and anchors it:
 *   (a) the field changes the measured height ⇒ it MUST be in the revision, or
 *   (b) the field is height-neutral (header-only chrome) ⇒ it need not be.
 *
 * Both directions are regressions worth catching: (a) going missing breaks
 * correctness, and (b) silently becoming height-bearing would break it too. The
 * height claims are measured directly rather than assumed from CONTRACT.md.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

// The canvas stub must be installed before any pretext-backed module loads.
beforeAll(() => {
	installCanvasStub();
});

async function measureMod() {
	return import("./measure/measure-tool-call");
}

async function cacheMod() {
	return import("./measure-cache");
}

type ToolCallData = import("./measure/measure-tool-call").ToolCallData;

function card(overrides: Partial<ToolCallData> = {}): ToolCallData {
	return {
		toolName: "Bash",
		summary: "bun test",
		category: "terminal",
		status: "running",
		...overrides,
	} as ToolCallData;
}

const WIDTH = 640;
const LOD = 5;
/**
 * Expansion is an OPT, not a data field (measureToolCall reads `opts.opened`).
 * Every height comparison below must force the card open, or all of them collapse
 * to the same 41px header and the audit would vacuously "pass" on equality while
 * silently proving nothing.
 */
const OPENED = { opened: true } as const;

// ─────────────────────────────────────────────────────────────────────────────
// (a) Height-BEARING fields — must be covered by extractDataRevision
// ─────────────────────────────────────────────────────────────────────────────

describe("live-patch audit: fields that DO change height are in the cache key", () => {
	it("status: running → success changes the measured height AND the revision", async () => {
		const { measureToolCall } = await measureMod();
		const { extractDataRevision } = await cacheMod();
		// A finished tool renders an output body a running one does not, so the two
		// heights differ; the revision must therefore differ too.
		const running = card({ status: "running" });
		const done = card({
			status: "success",
			detail: { kind: "capped", cap: "term", contentLines: 6, text: "a\nb\nc\nd\ne\nf" },
		} as Partial<ToolCallData>);
		expect(measureToolCall(done, WIDTH, LOD, OPENED).height).not.toBe(
			measureToolCall(running, WIDTH, LOD, OPENED).height,
		);
		expect(extractDataRevision(done)).not.toBe(extractDataRevision(running));
	});

	it("output text (capped detail body) is covered by the detail text signature", async () => {
		const { measureToolCall } = await measureMod();
		const { extractDataRevision } = await cacheMod();
		const short = card({
			status: "success",
			detail: { kind: "capped", cap: "term", contentLines: 1, text: "ok" },
		} as Partial<ToolCallData>);
		const long = card({
			status: "success",
			detail: {
				kind: "capped",
				cap: "term",
				contentLines: 8,
				text: "1\n2\n3\n4\n5\n6\n7\n8",
			},
		} as Partial<ToolCallData>);
		expect(measureToolCall(long, WIDTH, LOD, OPENED).height).toBeGreaterThan(
			measureToolCall(short, WIDTH, LOD, OPENED).height,
		);
		expect(extractDataRevision(long)).not.toBe(extractDataRevision(short));
	});

	it("errorMessage on a failed tool changes height and is reflected in the revision", async () => {
		const { measureToolCall } = await measureMod();
		const { extractDataRevision } = await cacheMod();
		const bare = card({ status: "fail" });
		const withError = card({
			status: "fail",
			detail: { kind: "error", text: "boom\nstack line\nanother line" },
		} as Partial<ToolCallData>);
		expect(measureToolCall(withError, WIDTH, LOD, OPENED).height).toBeGreaterThan(
			measureToolCall(bare, WIDTH, LOD, OPENED).height,
		);
		expect(extractDataRevision(withError)).not.toBe(extractDataRevision(bare));
	});

	it("reflection status (running → confirmed) changes height and the revision", async () => {
		// This is the reflection half of the fix: the gate advances via a WS event
		// with NO messageVersion bump, so the reflection revision is the only thing
		// that can invalidate the notice's cached height.
		const { measureToolCall } = await measureMod();
		const { extractDataRevision } = await cacheMod();
		const running = card({
			reflection: { title: "Reflecting on a dangerous action", status: "running" },
		} as Partial<ToolCallData>);
		const confirmed = card({
			reflection: {
				title: "Reflection confirmed",
				status: "confirmed",
				summary: "The command was judged safe after review of the target path.",
			},
		} as Partial<ToolCallData>);
		expect(measureToolCall(confirmed, WIDTH, LOD, OPENED).height).not.toBe(
			measureToolCall(running, WIDTH, LOD, OPENED).height,
		);
		expect(extractDataRevision(confirmed)).not.toBe(extractDataRevision(running));
	});

	it("subagent isTerminal / isActive flags are in the revision", async () => {
		const { extractDataRevision } = await cacheMod();
		// Subagent cards collapse differently once terminal, so both flags must key.
		expect(extractDataRevision({ isActive: true, isTerminal: false })).not.toBe(
			extractDataRevision({ isActive: false, isTerminal: true }),
		);
	});

	/**
	 * A recent-call row's LABEL arriving with no height change.
	 *
	 * The exhaustive audit below can only catch a stale key when the height MOVED, so
	 * it is blind to this one by construction: `tool_use_chunk` fills in a child call's
	 * `inputSummary` while the row count, the tool names and the status all stay put,
	 * and the row is a fixed-height trace row either way. The summary is nonetheless
	 * PAINTED from the cached measured payload, so without these fields in the revision
	 * the row keeps its bare tool name until something unrelated re-keys the card.
	 *
	 * Same reasoning as the `timeoutMs` entry in `subagentRevision`: height-neutral
	 * fields may normally be omitted, EXCEPT when they arrive alone.
	 */
	it("recent-call summaries are in the revision (they can be the only delta)", async () => {
		const { extractDataRevision } = await cacheMod();
		const base = {
			agentType: "explore",
			recentCallCount: 2,
			recentCallNames: ["Read", "Bash"],
		};
		const bare = extractDataRevision(base);
		const labelled = extractDataRevision({
			...base,
			recentCallSummaries: ["loop.ts", "bun test"],
		});
		expect(labelled).not.toBe(bare);
		// And a CHANGED summary re-keys too — a mid-stream `Bash` whose description
		// lands after its command would otherwise keep the first label forever.
		expect(
			extractDataRevision({ ...base, recentCallSummaries: ["loop.ts", "run the suite"] }),
		).not.toBe(labelled);
	});

	it("recent-call categories are in the revision (chip tint is painted from cache)", async () => {
		const { extractDataRevision } = await cacheMod();
		const base = { agentType: "explore", recentCallCount: 1, recentCallNames: ["Read"] };
		expect(extractDataRevision({ ...base, recentCallCategories: ["read"] })).not.toBe(
			extractDataRevision({ ...base, recentCallCategories: ["bash"] }),
		);
	});

	it("a folded trace row's duration is in the revision", async () => {
		const { extractDataRevision } = await cacheMod();
		// Same class of bug one layer up: the row's duration is height-neutral but
		// painted from the cached trace payload. `status` usually moves with it, so this
		// keys the value directly rather than relying on that coincidence.
		const row = { key: "t-0", title: "Read · loop.ts", status: "success" };
		expect(extractDataRevision({ items: [{ ...row, timing: { durationMs: 1_000 } }] })).not.toBe(
			extractDataRevision({ items: [{ ...row, timing: { durationMs: 9_000 } }] }),
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) EXHAUSTIVE audit — every patch, through the real adapter + measure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The hand-written cases above audit fields someone REMEMBERED to list, which is
 * exactly how `_subagentActivity` slipped through: the activity patch writes one
 * opaque object, the adapter derives `recentCallCount` from it, and no case
 * mentioned either name. So the audit below never names a field at all.
 *
 * For each patch it runs the REAL pipeline twice — segmentMessages → adaptSegments
 * → measure, before and after — and checks the one property that actually matters:
 *
 *     a row whose MEASURED HEIGHT changed must also change its CACHE KEY
 *
 * Any future patch that writes a new field is covered the moment it is added to
 * the list, and a field that becomes height-bearing later starts failing on its
 * own. The check is only as exhaustive as the PATCH list, which is a much shorter
 * and more stable thing to keep in sync than the field list (and the wiring test
 * pins the event → patch mapping separately).
 */
describe("live-patch audit: EXHAUSTIVE — a height change always changes the key", () => {
	type Msg = import("@frontend/lib/api").TreeMessage;
	type LivePatch = import("./vlist-live-patch").LivePatch;

	/** One row's measured geometry plus the exact key the cache would use for it. */
	interface Probe {
		height: number;
		cacheKey: string;
	}

	async function probe(messages: readonly Msg[]): Promise<Map<string, Probe>> {
		const { segmentMessages } = await import("../message-segments");
		const { adaptSegments } = await import("./segment-adapter");
		const { VLIST_REGISTRY } = await import("./registry");
		const { buildCacheKey, extractDataRevision } = await cacheMod();
		type Seg = import("./segment-adapter").AdapterSegment;
		const segments = segmentMessages(messages as never) as unknown as Seg[];
		const specs = adaptSegments(segments, { lod: LOD });
		const out = new Map<string, Probe>();
		for (const spec of specs) {
			const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, WIDTH, LOD, spec.opts);
			out.set(spec.key, {
				height: measured.height,
				// documentRevision is deliberately OMITTED: applyLivePatch keeps
				// messageVersion fixed, so it is constant across a patch and folding it
				// in would mask exactly the staleness this audit is looking for.
				cacheKey: buildCacheKey(
					spec.key,
					spec.kind,
					WIDTH,
					LOD,
					spec.opts,
					extractDataRevision(spec.data),
				),
			});
		}
		return out;
	}

	/**
	 * Assert the invariant over every row the two documents share, and require that
	 * SOMETHING actually resized — a case where nothing moved would pass vacuously
	 * while proving nothing about the patch.
	 */
	async function auditPatch(before: readonly Msg[], patch: LivePatch): Promise<void> {
		const result = patch(before);
		expect(result.changed).toBe(true);
		const beforeProbes = await probe(before);
		const afterProbes = await probe(result.messages);
		let resized = 0;
		for (const [key, beforeProbe] of beforeProbes) {
			const afterProbe = afterProbes.get(key);
			if (!afterProbe) continue;
			if (afterProbe.height === beforeProbe.height) continue;
			resized++;
			expect(afterProbe.cacheKey).not.toBe(beforeProbe.cacheKey);
		}
		expect(resized).toBeGreaterThan(0);
	}

	/** An Agent tool call — the shape that renders as a SubagentCard. */
	function subagentDoc(overrides: Record<string, unknown> = {}): Msg[] {
		const shared = {
			type: "tool_use",
			id: "tu-agent",
			name: "Agent",
			input: { description: "explore the repo", prompt: "look at the auth flow" },
			inputJson: { description: "explore the repo", prompt: "look at the auth flow" },
			status: "success",
			...overrides,
		};
		return [
			{
				id: "m1",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant",
				contentJson: [shared],
				contentText: null,
				toolCalls: [
					{
						id: "tc-agent",
						narratorId: "n1",
						messageId: "m1",
						toolUseId: "tu-agent",
						toolName: "Agent",
						createdAt: "2026-01-01T00:00:00.000Z",
						...overrides,
						inputJson: shared.inputJson,
						status: shared.status,
					},
				],
				createdAt: "2026-01-01T00:00:00.000Z",
				children: [],
			} as unknown as Msg,
		];
	}

	/** A plain Bash tool call, still running. */
	function toolDoc(): Msg[] {
		const shared = {
			type: "tool_use",
			id: "tu-bash",
			name: "Bash",
			input: { command: "bun test" },
			inputJson: { command: "bun test" },
			status: "running",
		};
		return [
			{
				id: "m1",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant",
				contentJson: [shared],
				contentText: null,
				toolCalls: [
					{
						id: "tc-bash",
						narratorId: "n1",
						messageId: "m1",
						toolUseId: "tu-bash",
						toolName: "Bash",
						inputJson: shared.inputJson,
						status: "running",
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				],
				createdAt: "2026-01-01T00:00:00.000Z",
				children: [],
			} as unknown as Msg,
		];
	}

	const childHeader = (toolUseId: string, toolName: string) => ({
		toolCallId: null,
		toolUseId,
		toolName,
		status: "success",
		createdAt: 1,
		timing: null,
	});

	it("subagent activity: recent-call rows appearing must re-key the card", async () => {
		// THE blocker. The patch writes only `_subagentActivity`; the adapter turns it
		// into `recentCallCount`, and the recent-calls block height is pure arithmetic
		// on that count. Before the fix the card kept the 0-row height and the rows
		// were clipped to nothing.
		const { patchSubagentActivity } = await import("./vlist-live-patch");
		await auditPatch(subagentDoc(), (messages) =>
			patchSubagentActivity(messages, "tu-agent", childHeader("tu-c1", "Read"), {
				subagentNarratorId: "sub-1",
				model: "sonnet",
			}),
		);
	});

	it("subagent activity: a SECOND recent call must re-key again", async () => {
		// One → two rows is the increment a real turn produces; keying only on
		// "has activity" would pass the case above yet still clip the second row.
		const { patchSubagentActivity } = await import("./vlist-live-patch");
		const seeded = patchSubagentActivity(
			subagentDoc(),
			"tu-agent",
			childHeader("tu-c1", "Read"),
		).messages;
		await auditPatch(seeded, (messages) =>
			patchSubagentActivity(messages, "tu-agent", childHeader("tu-c2", "Grep")),
		);
	});

	it("subagent activity snapshots (reconnect catch-up) must re-key the card", async () => {
		const { patchSubagentActivitySnapshots } = await import("./vlist-live-patch");
		await auditPatch(subagentDoc(), (messages) =>
			patchSubagentActivitySnapshots(messages, [
				{
					parentToolUseId: "tu-agent",
					activity: {
						subagentNarratorId: "sub-1",
						model: "sonnet",
						latestToolCalls: [childHeader("tu-c1", "Read"), childHeader("tu-c2", "Grep")],
					},
				},
			]),
		);
	});

	it("subagent conclusion must re-key even when the status does NOT move", async () => {
		// The status-stays-success case: `subagentConclusionPatch` writes outputJson
		// (→ resultText / resultPreview) on a card that is already success with no
		// error, so `s:success` is unchanged and the result body is the only delta.
		const { subagentConclusionPatch } = await import("./vlist-live-events");
		await auditPatch(
			subagentDoc({ status: "success" }),
			subagentConclusionPatch({
				toolUseId: "tu-agent",
				output: "Found three call sites.\n\n- a.ts\n- b.ts\n- c.ts",
				hasError: false,
			}),
		);
	});

	it("tool completion (status + output body) must re-key the card", async () => {
		const { toolCompletedPatch } = await import("./vlist-live-events");
		await auditPatch(
			toolDoc(),
			toolCompletedPatch({
				toolUseId: "tu-bash",
				status: "success",
				output: "1\n2\n3\n4\n5\n6\n7\n8",
				durationMs: 1234,
			}),
		);
	});

	it("background-task terminals must re-key the card", async () => {
		const { backgroundTaskPatch } = await import("./vlist-live-events");
		await auditPatch(
			toolDoc(),
			backgroundTaskPatch({
				toolUseId: "tu-bash",
				status: "fail",
				text: "exited 1\nstderr line\nanother line",
			}),
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// (c2) A GROWING FOLD — the low-LOD counterpart of the patch audit above
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The audit above walks the PATCH channel, which is a per-card field merge. A
 * folded trace breaks the same invariant through a different door: at L1-L3 the
 * activity fold and the tool-run fold collapse MANY members into ONE element
 * whose `spec.key` is minted from its FIRST member only
 * (`activity-<firstMsgId>-<i>` / `toolrun-summary-tool-<firstToolUseId>`).
 *
 * So when a fold GAINS members — the ordinary case of a turn continuing, whether
 * the new message arrives through `appendMessage` or a streaming handoff — its key
 * does not move, `messageVersion` is deliberately held fixed by every in-place path
 * (CONTRACT.md §4.5), and its `opts` only carry fold/expand state. The measured
 * payload is then served from the entry captured when the fold had one member: the
 * header still reads "0 tools · 1 reasoning" and the tool rows are clipped away.
 *
 * It looked like a render bug because changing LOD "fixed" it (a different `lod`
 * component ⇒ a different key ⇒ a real measure) and coming back re-broke it (the
 * stale entry for the original LOD was still there).
 */
describe("low-LOD folds: a fold that grows must re-key", () => {
	type Msg = import("../narrator-panel-types").NarratorMsg;

	function reasoningDoc(): Msg {
		return {
			id: "m1",
			narratorId: "n1",
			seq: 1,
			role: "assistant",
			contentJson: [{ type: "thinking", thinking: "## step\nthinking about it" }],
			contentText: null,
			toolCalls: [],
			children: [],
			parentToolUseId: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		} as unknown as Msg;
	}

	function readToolMsg(id: string, seq: number, toolUseId: string): Msg {
		const block = {
			type: "tool_use",
			id: toolUseId,
			name: "Read",
			input: { file_path: `/a/${toolUseId}.ts` },
			inputJson: { file_path: `/a/${toolUseId}.ts` },
			status: "success",
		};
		return {
			id,
			narratorId: "n1",
			seq,
			role: "assistant",
			contentJson: [block],
			contentText: null,
			toolCalls: [
				{
					id: `tc-${toolUseId}`,
					narratorId: "n1",
					messageId: id,
					toolUseId,
					toolName: "Read",
					inputJson: block.inputJson,
					status: "success",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			children: [],
			parentToolUseId: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		} as unknown as Msg;
	}

	/**
	 * Measure through the REAL low-LOD pipeline (segmentMessages → groupRenderUnits
	 * → adaptRenderUnits → measure) and return each element's height beside the
	 * exact key the cache would use. `documentRevision` is pinned to one constant
	 * because that is precisely the situation these paths create.
	 */
	async function probeFolds(messages: Msg[], lod: 1 | 2 | 3) {
		const { segmentMessages } = await import("../message-segments");
		const { groupRenderUnits } = await import("../render-units");
		const { adaptRenderUnits } = await import("./segment-adapter");
		const { VLIST_REGISTRY } = await import("./registry");
		const { buildCacheKey, extractDataRevision } = await cacheMod();
		const units = groupRenderUnits(segmentMessages(messages), lod <= 2);
		const adapterUnits = units.map((unit, index) =>
			unit.kind === "activity"
				? {
						kind: "activity" as const,
						key: `activity-${unit.sourceMessages[0]?.id ?? "unknown"}-${index}`,
						items: unit.items as never,
						sourceMessages: unit.sourceMessages as never,
					}
				: { kind: "segment" as const, seg: unit.seg as never },
		);
		const specs = adaptRenderUnits(adapterUnits, { lod });
		return specs.map((spec) => ({
			key: spec.key,
			kind: spec.kind,
			height: VLIST_REGISTRY[spec.kind].measure(spec.data, WIDTH, lod, spec.opts).height,
			cacheKey: buildCacheKey(
				spec.key,
				spec.kind,
				WIDTH,
				lod,
				spec.opts,
				`v:7|${extractDataRevision(spec.data) ?? ""}`,
			),
		}));
	}

	async function expectFoldReKeys(lod: 1 | 2 | 3, kind: string) {
		const before = await probeFolds([reasoningDoc()], lod);
		const after = await probeFolds(
			[reasoningDoc(), readToolMsg("m2", 2, "tu-1"), readToolMsg("m3", 3, "tu-2")],
			lod,
		);
		const beforeFold = before.find((item) => item.kind === kind);
		const afterFold = after.find((item) => item.kind === kind);
		expect(beforeFold).toBeDefined();
		expect(afterFold).toBeDefined();
		// Same key (the fold is named after its first member) but a taller element…
		expect(afterFold?.key).toBe(beforeFold?.key);
		expect(afterFold?.height).toBeGreaterThan(beforeFold?.height ?? 0);
		// …therefore the cache key MUST differ, or the grown fold is painted at the
		// one-member geometry with its new rows clipped off.
		expect(afterFold?.cacheKey).not.toBe(beforeFold?.cacheKey);
	}

	it("L2 activity trace: tool rows joining the fold re-key it", async () => {
		await expectFoldReKeys(2, "activity-trace");
	});

	it("L1 activity trace: the header-only fold re-keys too (its count text changes)", async () => {
		// At L1 the row list is folded behind the header, so the HEIGHT is constant.
		// The header count ("N reasoning · M tools") is painted from the cached
		// payload, so it still has to re-key or it keeps reading "0 tools".
		const before = await probeFolds([reasoningDoc()], 1);
		const after = await probeFolds(
			[reasoningDoc(), readToolMsg("m2", 2, "tu-1"), readToolMsg("m3", 3, "tu-2")],
			1,
		);
		const beforeFold = before.find((item) => item.kind === "activity-trace");
		const afterFold = after.find((item) => item.kind === "activity-trace");
		expect(afterFold?.key).toBe(beforeFold?.key);
		expect(afterFold?.cacheKey).not.toBe(beforeFold?.cacheKey);
	});

	it("L3 tool-run summary: a second folded call re-keys the summary", async () => {
		const one = await probeFolds([readToolMsg("m1", 1, "tu-1")], 3);
		const two = await probeFolds([readToolMsg("m1", 1, "tu-1"), readToolMsg("m2", 2, "tu-2")], 3);
		const first = one.find((item) => item.kind === "tool-run-summary");
		const second = two.find((item) => item.kind === "tool-run-summary");
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second?.key).toBe(first?.key);
		expect(second?.height).toBeGreaterThan(first?.height ?? 0);
		expect(second?.cacheKey).not.toBe(first?.cacheKey);
	});

	it("L2 tool-run count line: the folded count is part of the key", async () => {
		const one = await probeFolds([readToolMsg("m1", 1, "tu-1")], 2);
		const two = await probeFolds([readToolMsg("m1", 1, "tu-1"), readToolMsg("m2", 2, "tu-2")], 2);
		const first = one.find((item) => item.kind === "tool-run-count");
		const second = two.find((item) => item.kind === "tool-run-count");
		// Both folds may render as an activity trace when reasoning is absent; only
		// assert when the count-line form is actually produced.
		if (!first || !second) return;
		expect(second.key).toBe(first.key);
		expect(second.cacheKey).not.toBe(first.cacheKey);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Height-NEUTRAL fields — safe to omit from the cache key
// ─────────────────────────────────────────────────────────────────────────────

describe("live-patch audit: fields that are height-NEUTRAL (single header row)", () => {
	/**
	 * A neutrality claim is only meaningful on an EXPANDED card: collapsed cards
	 * are all 41px, so comparing two of them would prove nothing. Each case below
	 * therefore carries a real body and forces the card open, and asserts the
	 * baseline is genuinely taller than the collapsed height first.
	 */
	const expandedCard = (overrides: Partial<ToolCallData> = {}) =>
		card({
			status: "success",
			detail: { kind: "capped", cap: "term", contentLines: 4, text: "a\nb\nc\nd" },
			...overrides,
		} as Partial<ToolCallData>);

	it("durationMs does not change the measured height", async () => {
		// Duration is painted inside the card's one fixed-height header row, so a
		// tool_completed patch carrying it cannot invalidate geometry. If this ever
		// starts failing, durationMs must be added to extractDataRevision.
		const { measureToolCall } = await measureMod();
		const base = measureToolCall(expandedCard(), WIDTH, LOD, OPENED);
		expect(base.height).toBeGreaterThan(base.collapsedHeight);
		const timed = measureToolCall(
			expandedCard({ durationMs: 987_654 } as Partial<ToolCallData>),
			WIDTH,
			LOD,
			OPENED,
		);
		expect(timed.height).toBe(base.height);
	});

	it("startedAt / streamStartedAt do not change the measured height", async () => {
		const { measureToolCall } = await measureMod();
		const base = measureToolCall(expandedCard(), WIDTH, LOD, OPENED);
		const started = measureToolCall(
			expandedCard({
				startedAt: Date.now(),
				streamStartedAt: Date.now(),
			} as Partial<ToolCallData>),
			WIDTH,
			LOD,
			OPENED,
		);
		expect(started.height).toBe(base.height);
	});

	it("the whole lifecycle stamp set does not change the measured height", async () => {
		// These feed the header's breakdown POPOVER, which is portaled. If this ever
		// starts failing they must join extractDataRevision, or a patch that lands a
		// completion stamp would serve the pre-patch geometry.
		const { measureToolCall } = await measureMod();
		const now = Date.now();
		const base = measureToolCall(expandedCard(), WIDTH, LOD, OPENED);
		expect(base.height).toBeGreaterThan(base.collapsedHeight);
		const stamped = measureToolCall(
			expandedCard({
				createdAt: now,
				streamStartedAt: now + 10,
				permissionStartedAt: now + 20,
				executionStartedAt: now + 30,
				completedAt: now + 5_000,
			} as Partial<ToolCallData>),
			WIDTH,
			LOD,
			OPENED,
		);
		expect(stamped.height).toBe(base.height);
	});

	it("timeoutMs does not change the measured height", async () => {
		// The `/ 2m` suffix shares the card's one fixed header row. It is now DERIVED
		// (bash/await get a default), so it appears on cards that previously had none
		// — this pins that the derivation stayed height-neutral.
		const { measureToolCall } = await measureMod();
		const base = measureToolCall(expandedCard(), WIDTH, LOD, OPENED);
		const timed = measureToolCall(
			expandedCard({ timeoutMs: 120_000 } as Partial<ToolCallData>),
			WIDTH,
			LOD,
			OPENED,
		);
		expect(timed.height).toBe(base.height);
	});

	it("timeoutMs is keyed ANYWAY, because it is the only field its event writes", async () => {
		// Height neutrality permits omission from the revision, but the cache stores
		// the whole measured payload — including values the renderer only paints. Every
		// other height-neutral passthrough rides an event that also moves the status
		// (tool_completed), so the key moves for free. `timeout_updated` writes the
		// deadline ALONE: with no revision component the rebuild returned the pre-update
		// measured object and the header kept the old timeout after a successful update.
		const { extractDataRevision } = await cacheMod();
		const running = { status: "running", timeoutMs: 600_000 };
		expect(extractDataRevision({ ...running, timeoutMs: 6_000_000 })).not.toBe(
			extractDataRevision(running),
		);
		// A card with no deadline at all must not gain a phantom component.
		expect(extractDataRevision({ status: "running" })).toBe("s:running");
	});

	it("a long header summary does not change the measured height (header truncates)", async () => {
		// tool_completed may carry an updatedInput that lengthens the summary.
		const { measureToolCall } = await measureMod();
		const short = measureToolCall(expandedCard({ summary: "x" }), WIDTH, LOD, OPENED);
		const long = measureToolCall(expandedCard({ summary: "y".repeat(2_000) }), WIDTH, LOD, OPENED);
		expect(long.height).toBe(short.height);
	});

	it("toolUseId identity fields do not change the measured height", async () => {
		const { measureToolCall } = await measureMod();
		const base = measureToolCall(expandedCard(), WIDTH, LOD, OPENED);
		const identified = measureToolCall(
			expandedCard({ toolUseId: "tu-abc123" } as Partial<ToolCallData>),
			WIDTH,
			LOD,
			OPENED,
		);
		expect(identified.height).toBe(base.height);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache-key end-to-end: a patched card must MISS its pre-patch entry
// ─────────────────────────────────────────────────────────────────────────────

describe("live-patch audit: a patched card misses its stale cache entry", () => {
	it("the same spec.key resolves to a different cache key after a status patch", async () => {
		const { buildCacheKey, extractDataRevision } = await cacheMod();
		// The vlist row key is derived from toolUseId, so it is IDENTICAL before and
		// after the patch — only the data revision can force the re-measure.
		const specKey = "tool-tu-1";
		const before = buildCacheKey(
			specKey,
			"tool-call",
			WIDTH,
			LOD,
			undefined,
			extractDataRevision(card({ status: "running" })),
		);
		const after = buildCacheKey(
			specKey,
			"tool-call",
			WIDTH,
			LOD,
			undefined,
			extractDataRevision(
				card({
					status: "success",
					detail: { kind: "capped", cap: "term", contentLines: 3, text: "a\nb\nc" },
				} as Partial<ToolCallData>),
			),
		);
		expect(after).not.toBe(before);
	});

	it("an unchanged card still HITS its entry (or nothing would ever cache)", async () => {
		const { buildCacheKey, extractDataRevision } = await cacheMod();
		const data = card({ status: "running" });
		const key = () =>
			buildCacheKey("tool-tu-1", "tool-call", WIDTH, LOD, undefined, extractDataRevision(data));
		expect(key()).toBe(key());
	});

	it("a reflection-only transition changes the key even with an identical document version", async () => {
		// Reflections never bump messageVersion, so folding the version in must not
		// mask the reflection change.
		const { buildCacheKey, extractDataRevision } = await cacheMod();
		const withStatus = (status: string) =>
			buildCacheKey(
				"tool-tu-1",
				"tool-call",
				WIDTH,
				LOD,
				undefined,
				`v:42|${extractDataRevision(
					card({ reflection: { title: "t", status } } as Partial<ToolCallData>),
				)}`,
			);
		expect(withStatus("confirmed")).not.toBe(withStatus("running"));
	});
});
