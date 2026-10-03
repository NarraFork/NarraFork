import { beforeAll, describe, expect, it } from "bun:test";
import type { NarratorMsg } from "../narrator-panel-types";
import type { MeasuredCollapsibleTrace } from "./measure/measure-tool-run";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextDocumentLayout, createLongestPrefixLookup } from "./pretext-document-layout";
import {
	type ElementSpec,
	resolveTextExpansionPreference,
	textExpansionStateKey,
} from "./segment-adapter";
import {
	createVListInteractionState,
	isVListTextExpanded,
	resetVListInteractionStateForLod,
	setVListTextExpanded,
	type VListInteractionState,
} from "./vlist-interaction-state";

beforeAll(() => {
	installCanvasStub();
});

function message(id: string, seq: number, role: "user" | "assistant", text: string): NarratorMsg {
	return {
		id,
		narratorId: "n1",
		seq,
		role,
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		children: [],
		parentToolUseId: null,
		createdAt: "2026-07-23T00:00:00.000Z",
	} as unknown as NarratorMsg;
}

function historyFixture(count: number): NarratorMsg[] {
	return Array.from({ length: count }, (_, index) => {
		if (index % 17 === 0) {
			return {
				...message(`compact-${index}`, index, "assistant", ""),
				role: "system",
				contentJson: [
					{
						type: "compact",
						subtype: "plan",
						summary: `Plan checkpoint ${index}\n${"detailed summary ".repeat(30)}`,
					},
				],
				contentText: null,
			} as unknown as NarratorMsg;
		}
		if (index % 13 === 0) {
			return {
				...message(`tool-${index}`, index, "assistant", ""),
				contentJson: [
					{
						type: "tool_use",
						id: `tool-use-${index}`,
						name: "Read",
						input: { file_path: `/workspace/very/long/path/${index}/file.ts` },
						inputJson: { file_path: `/workspace/very/long/path/${index}/file.ts` },
						status: "completed",
					},
				],
				contentText: null,
				toolCalls: [
					{
						toolUseId: `tool-use-${index}`,
						toolName: "Read",
						inputJson: { file_path: `/workspace/very/long/path/${index}/file.ts` },
						status: "completed",
					},
				],
			} as unknown as NarratorMsg;
		}
		const role = index % 3 === 0 ? "user" : "assistant";
		const text =
			index % 11 === 0
				? `# Long response ${index}\n\n${"A paragraph with markdown and `code`. ".repeat(120)}`
				: index === count - 1
					? "Streaming tail with a currently partial final sentence"
					: `Message ${index}: ${"content ".repeat((index % 9) + 1)}`;
		return message(`message-${index}`, index, role, text);
	});
}

function reasoningBodyMessage(
	id = "reasoning-body",
	blockId: string | undefined = "reason-body-1",
	structured = true,
): NarratorMsg {
	return {
		...message(id, 1, "assistant", ""),
		contentJson: [
			{
				type: "reasoning",
				...(blockId ? { id: blockId } : {}),
				text: `${structured ? "**First**\n\n" : ""}${"long body ".repeat(1000)}`,
			},
		],
	} as unknown as NarratorMsg;
}

function buildReasoningBodyLayout(
	messages: NarratorMsg[],
	state: VListInteractionState,
	lod: 2 | 5,
) {
	return buildPretextDocumentLayout(messages, {
		layoutRevision: "body-lod-regression",
		documentRevision: 1,
		lod,
		widthBucket: "640",
		contentWidth: 640,
		isExpanded: () => true,
		expandedRows: () => [0, 1],
		isRowExpanded: () => true,
		isTextExpanded: (key, bodyKey) => isVListTextExpanded(state, key, bodyKey),
	});
}

/** Mirrors the click's identity resolution, without mounting the query/WS shell. */
function setReasoningBodyExpanded(
	state: VListInteractionState,
	spec: ElementSpec,
	bodyKey: string | undefined,
	expanded: boolean,
) {
	const preference = resolveTextExpansionPreference(spec, bodyKey);
	return setVListTextExpanded(
		state,
		spec.key,
		expanded,
		bodyKey,
		preference.specKey,
		preference.bodyKey ?? null,
	);
}

function traceBodyExpanded(item: { measured: unknown }, index = 0) {
	return (item.measured as MeasuredCollapsibleTrace).rows[index]?.body?.textPreview?.expanded;
}

function activityBody(messages: NarratorMsg[], state: VListInteractionState) {
	const item = buildReasoningBodyLayout(messages, state, 2).items.find(
		(item) => item.spec.kind === "activity-trace",
	);
	if (!item) throw new Error("missing activity trace");
	return item;
}

function reasoningBodies(messages: NarratorMsg[], state: VListInteractionState) {
	return buildReasoningBodyLayout(messages, state, 5).items.filter(
		(item) => item.spec.kind === "reasoning-steps",
	);
}

function reasoningBody(messages: NarratorMsg[], state: VListInteractionState, index = 0) {
	const item = reasoningBodies(messages, state)[index];
	if (!item) throw new Error("missing reasoning steps body");
	return item;
}

function traceBodyKey(item: { measured: unknown }, index = 0): string {
	const key = (item.measured as MeasuredCollapsibleTrace).rows[index]?.key;
	if (!key) throw new Error("missing trace body key");
	return key;
}

describe("buildPretextDocumentLayout", () => {
	it("keeps a durable reasoning step's full body when LOD5 folds into an LOD2 activity row", () => {
		const messages = [reasoningBodyMessage()];
		let state = createVListInteractionState(5);
		const build = (lod: 2 | 5) => buildReasoningBodyLayout(messages, state, lod);
		const high = build(5).items.find((item) => item.spec.kind === "reasoning-steps");
		if (!high) throw new Error("missing reasoning steps");
		state = setVListTextExpanded(
			state,
			high.spec.key,
			true,
			"seg0",
			textExpansionStateKey(high.spec.key, high.spec.lifecycleId),
		);
		expect(
			(build(5).items[0]?.measured as MeasuredCollapsibleTrace).rows[0]?.body?.textPreview
				?.expanded,
		).toBe(true);
		state = resetVListInteractionStateForLod(state, 2);
		const low = build(2).items.find((item) => item.spec.kind === "activity-trace");
		if (!low) throw new Error("missing activity trace");
		expect(traceBodyExpanded(low)).toBe(true);
		const lowBodyKey = traceBodyKey(low);
		expect(lowBodyKey).not.toBe("seg0");
		expect(resolveTextExpansionPreference(low.spec, lowBodyKey)).toEqual({
			specKey: "text-lifecycle:blk:reason-body-1",
			bodyKey: "seg0",
		});
		state = setReasoningBodyExpanded(state, low.spec, lowBodyKey, false);
		expect(traceBodyExpanded(activityBody(messages, state))).toBe(false);
		state = resetVListInteractionStateForLod(state, 5);
		expect(traceBodyExpanded(reasoningBody(messages, state))).toBe(false);
		expect(isVListTextExpanded(state, high.spec.key, "seg0")).toBe(false);
		state = resetVListInteractionStateForLod(state, 2);
		expect(traceBodyExpanded(activityBody(messages, state))).toBe(false);
	});

	it("maps each low-LOD step to its own durable run and slot without changing row identities", () => {
		const long = "long reasoning body ".repeat(600);
		const messages = [
			{
				...message("multi-body", 1, "assistant", ""),
				contentJson: [
					{ type: "reasoning", id: "run-a", text: `**A first**\n\n${long}` },
					{ type: "reasoning", id: "run-a-next", text: `**A second**\n\n${long}` },
					{
						type: "tool_use",
						id: "between-runs",
						name: "Read",
						input: { file_path: "/a.ts" },
						status: "completed",
					},
					{
						type: "reasoning",
						id: "run-b",
						text: `**B first**\n\n${long}\n\n**B second**\n\n${long}`,
					},
				],
			},
		] as unknown as NarratorMsg[];
		let state = createVListInteractionState(2);
		const low = activityBody(messages, state);
		const originalRows = (low.measured as MeasuredCollapsibleTrace).rows;
		expect(originalRows).toHaveLength(5);
		expect(low.spec.lifecycleId).toBeUndefined();
		const secondA = traceBodyKey(low, 1);
		const firstB = traceBodyKey(low, 3);
		expect(resolveTextExpansionPreference(low.spec, secondA)).toEqual({
			specKey: "text-lifecycle:blk:run-a",
			bodyKey: "seg1",
		});
		expect(resolveTextExpansionPreference(low.spec, firstB)).toEqual({
			specKey: "text-lifecycle:blk:run-b",
			bodyKey: "seg0",
		});
		// Tool drill-down retains the raw trace/row boundary.
		expect(resolveTextExpansionPreference(low.spec, traceBodyKey(low, 2))).toEqual({
			specKey: low.spec.key,
			bodyKey: traceBodyKey(low, 2),
		});
		state = setReasoningBodyExpanded(state, low.spec, secondA, true);
		state = setReasoningBodyExpanded(state, low.spec, firstB, true);
		const openedLow = activityBody(messages, state);
		expect([0, 1, 3, 4].map((i) => traceBodyExpanded(openedLow, i))).toEqual([
			false,
			true,
			true,
			false,
		]);
		expect(
			(openedLow.measured as MeasuredCollapsibleTrace).rows.map((row) => [
				row.key,
				row.unitId,
				row.identity,
			]),
		).toEqual(originalRows.map((row) => [row.key, row.unitId, row.identity]));
		state = resetVListInteractionStateForLod(state, 5);
		const high = reasoningBodies(messages, state);
		expect(high).toHaveLength(2);
		const [first, second] = high;
		if (!first || !second) throw new Error("missing independent reasoning runs");
		expect([
			traceBodyExpanded(first, 0),
			traceBodyExpanded(first, 1),
			traceBodyExpanded(second, 0),
			traceBodyExpanded(second, 1),
		]).toEqual([false, true, true, false]);
		state = setReasoningBodyExpanded(state, first.spec, "seg1", false);
		state = resetVListInteractionStateForLod(state, 2);
		const closedA = activityBody(messages, state);
		expect(traceBodyExpanded(closedA, 1)).toBe(false);
		expect(traceBodyExpanded(closedA, 3)).toBe(true);
		expect(isVListTextExpanded(state, low.spec.key, secondA)).toBe(false);
	});

	it("maps an untitled reasoning row to the high-LOD direct body slot", () => {
		const messages = [reasoningBodyMessage("plain-body", "durable-plain-body", false)];
		let state = createVListInteractionState(5);
		const highBody = () => {
			const item = buildReasoningBodyLayout(messages, state, 5).items.find(
				(item) => item.spec.kind === "reasoning",
			);
			if (!item) throw new Error("missing plain reasoning body");
			return item;
		};
		const high = highBody();
		state = setReasoningBodyExpanded(state, high.spec, undefined, true);
		state = resetVListInteractionStateForLod(state, 2);
		const low = activityBody(messages, state);
		expect(traceBodyExpanded(low)).toBe(true);
		expect(resolveTextExpansionPreference(low.spec, traceBodyKey(low))).toEqual({
			specKey: "text-lifecycle:blk:durable-plain-body",
			bodyKey: undefined,
		});
		state = setReasoningBodyExpanded(state, low.spec, traceBodyKey(low), false);
		state = resetVListInteractionStateForLod(state, 5);
		expect(highBody().measured.textPreview?.expanded).toBe(false);
		state = setReasoningBodyExpanded(state, low.spec, traceBodyKey(low), true);
		expect(highBody().measured.textPreview?.expanded).toBe(true);
	});

	it("keeps live/persisted step preferences but isolates new blocks reusing synthetic keys", () => {
		let state = createVListInteractionState(5);
		const liveMessages = [reasoningBodyMessage("__streaming__", "durable-live-body")];
		const live = reasoningBody(liveMessages, state);
		expect(live.spec.lifecycleId).toBe("blk:durable-live-body");
		state = setReasoningBodyExpanded(state, live.spec, "seg0", true);
		const liveLow = activityBody(liveMessages, state);
		expect(resolveTextExpansionPreference(liveLow.spec, traceBodyKey(liveLow))).toEqual(
			resolveTextExpansionPreference(live.spec, "seg0"),
		);
		const persistedMessages = [reasoningBodyMessage("persisted-body", "durable-live-body")];
		state = resetVListInteractionStateForLod(state, 2);
		const persisted = activityBody(persistedMessages, state);
		expect(traceBodyExpanded(persisted)).toBe(true);
		// The next live block reuses both the old direct key and run-ordinal row key.
		const nextMessages = [reasoningBodyMessage("__streaming__", "next-live-body")];
		const nextHigh = reasoningBody(nextMessages, state);
		expect(nextHigh.spec.key).toBe(live.spec.key);
		expect(traceBodyExpanded(nextHigh)).toBe(false);
		const nextLow = activityBody(nextMessages, state);
		expect(traceBodyKey(nextLow)).toBe(traceBodyKey(liveLow));
		expect(nextLow.spec.textBodyPreferences).not.toEqual(liveLow.spec.textBodyPreferences);
		state = setReasoningBodyExpanded(state, persisted.spec, traceBodyKey(persisted), false);
		expect(isVListTextExpanded(state, live.spec.key, "seg0")).toBe(false);
		expect(traceBodyExpanded(reasoningBody(persistedMessages, state))).toBe(false);
		state = setReasoningBodyExpanded(state, persisted.spec, traceBodyKey(persisted), true);
		const replacementMessages = [reasoningBodyMessage("persisted-body", "replacement-block")];
		const replacement = activityBody(replacementMessages, state);
		expect(replacement.spec.key).not.toBe(persisted.spec.key);
		expect(traceBodyKey(replacement)).toBe(traceBodyKey(persisted));
		expect(traceBodyExpanded(replacement)).toBe(false);
		state = resetVListInteractionStateForLod(state, 5);
		expect(traceBodyExpanded(reasoningBody(persistedMessages, state))).toBe(true);
		expect(traceBodyExpanded(reasoningBody(nextMessages, state))).toBe(false);
	});

	it("isolates replacement reasoning blocks even when a leading tool keeps the trace and row keys unchanged", () => {
		const messagesFor = (blockId: string) => {
			const msg = reasoningBodyMessage("same-trace", blockId);
			return [
				{
					...msg,
					contentJson: [
						{
							type: "tool_use",
							id: "leading-tool",
							name: "Read",
							input: { file_path: "/a.ts" },
							status: "completed",
						},
						...(msg.contentJson as unknown[]),
					],
				},
			] as unknown as NarratorMsg[];
		};
		let state = createVListInteractionState(2);
		const oldMessages = messagesFor("previous-reasoning");
		const old = activityBody(oldMessages, state);
		const rowKey = traceBodyKey(old, 1);
		state = setReasoningBodyExpanded(state, old.spec, rowKey, true);
		expect(traceBodyExpanded(activityBody(oldMessages, state), 1)).toBe(true);
		const newMessages = messagesFor("replacement-reasoning");
		const next = activityBody(newMessages, state);
		expect(next.spec.key).toBe(old.spec.key);
		expect(traceBodyKey(next, 1)).toBe(rowKey);
		expect(traceBodyExpanded(next, 1)).toBe(false);
		state = resetVListInteractionStateForLod(state, 5);
		expect(traceBodyExpanded(reasoningBody(oldMessages, state))).toBe(true);
		expect(traceBodyExpanded(reasoningBody(newMessages, state))).toBe(false);
	});

	it.each([
		"",
		"streaming:reasoning:0",
	])("does not guess canonical identities for legacy/synthetic block %s", (blockId) => {
		const messages = [reasoningBodyMessage("legacy-body", blockId)];
		let state = createVListInteractionState(5);
		const high = reasoningBody(messages, state);
		expect(high.spec.lifecycleId).toBeUndefined();
		state = setReasoningBodyExpanded(state, high.spec, "seg0", true);
		state = resetVListInteractionStateForLod(state, 2);
		const low = activityBody(messages, state);
		expect(low.spec.textBodyPreferences).toBeUndefined();
		expect(traceBodyExpanded(low)).toBe(false);
		expect(resolveTextExpansionPreference(low.spec, traceBodyKey(low))).toEqual({
			specKey: low.spec.key,
			bodyKey: traceBodyKey(low),
		});
		state = setReasoningBodyExpanded(state, low.spec, traceBodyKey(low), true);
		expect(traceBodyExpanded(activityBody(messages, state))).toBe(true);
		state = setReasoningBodyExpanded(state, low.spec, traceBodyKey(low), false);
		state = resetVListInteractionStateForLod(state, 5);
		// Raw high/low legacy scopes intentionally stay separate, with no migration.
		expect(traceBodyExpanded(reasoningBody(messages, state))).toBe(true);
	});

	it("creates one exact layout manifest from the complete ordered message input", () => {
		const built = buildPretextDocumentLayout(
			[message("m0", 0, "user", "hello"), message("m1", 1, "assistant", "# answer\n\nbody")],
			{
				layoutRevision: "layout-1",
				documentRevision: 1,
				lod: 5,
				widthBucket: "860",
				contentWidth: 860,
				topPadding: 16,
				bottomPadding: 16,
				gap: 4,
			},
		);
		expect(built.manifest.items.length).toBeGreaterThan(0);
		expect(built.manifest.items.every((item) => item.height > 0)).toBe(true);
		expect(built.index.totalHeight).toBeGreaterThan(32);
		expect(built.manifest.items.some((item) => item.sourceMessageIds.includes("m0"))).toBe(true);
		expect(built.manifest.items.some((item) => item.sourceMessageIds.includes("m1"))).toBe(true);
	});

	it("reuses communication measurements on rebuild but invalidates receipt labels on language change", () => {
		const input = { id: "worker", message: "hello" };
		const messages = [
			{
				...message("communication-label-cache", 0, "assistant", ""),
				contentJson: [{ type: "tool_use", id: "send-label-cache", name: "Send", input }],
				toolCalls: [
					{
						toolUseId: "send-label-cache",
						toolName: "Send",
						status: "success",
						inputJson: input,
					},
				],
			},
		] as unknown as NarratorMsg[];
		const build = (language: string, receiptLabel: string) => {
			const result = buildPretextDocumentLayout(messages, {
				layoutRevision: "communication-label-cache",
				documentRevision: 1,
				lod: 5,
				widthBucket: "860",
				contentWidth: 860,
				labelsRevision: language,
				labels: { communicationReceiptLegacy: receiptLabel },
			});
			const row = result.items.find((item) => item.spec.kind === "communication-bubble");
			if (!row) throw new Error("missing communication bubble");
			return row;
		};
		const first = build("en", "Old receipt");
		const rebuilt = build("en", "Old receipt");
		expect(rebuilt.spec.data).not.toBe(first.spec.data);
		expect(rebuilt.measured).toBe(first.measured);
		const translated = build("zh-CN", "旧消息回执");
		expect(translated.spec.key).toBe(first.spec.key);
		expect(translated.measured.height).toBe(first.measured.height);
		expect(translated.measured).not.toBe(first.measured);
		expect(translated.spec.data).toMatchObject({
			labels: { communicationReceiptLegacy: "旧消息回执" },
		});
	});

	it("is deterministic for a 95-message mixed history with long, tool, compact, and tail content", () => {
		const input = historyFixture(95);
		const options = {
			layoutRevision: "layout-mixed-95",
			documentRevision: 95,
			lod: 5 as const,
			widthBucket: "860",
			contentWidth: 860,
			topPadding: 16,
			bottomPadding: 16,
			gap: 4,
		};
		const first = buildPretextDocumentLayout(input, options);
		const second = buildPretextDocumentLayout(input, options);
		expect(second.index.totalHeight).toBe(first.index.totalHeight);
		expect(second.manifest.items).toEqual(first.manifest.items);
		expect(first.manifest.items.some((item) => item.kind === "tool-call")).toBe(true);
		expect(first.manifest.items.some((item) => item.kind === "plan-card")).toBe(true);
		expect(first.manifest.items.some((item) => item.height > 500)).toBe(true);
		expect(first.index.itemIndicesForSourceSeq(94).length).toBeGreaterThan(0);
	});

	it("builds one finite exact manifest for a 451-message history", () => {
		const built = buildPretextDocumentLayout(historyFixture(451), {
			layoutRevision: "layout-mixed-451",
			documentRevision: 451,
			lod: 3,
			widthBucket: "720",
			contentWidth: 720,
			topPadding: 12,
			bottomPadding: 20,
			gap: 4,
		});
		expect(built.manifest.items.length).toBeGreaterThan(0);
		expect(
			built.manifest.items.every((item) => Number.isFinite(item.height) && item.height >= 0),
		).toBe(true);
		expect(built.index.totalHeight).toBeGreaterThan(0);
		expect(built.index.itemIndicesForSourceMessageId("message-450").length).toBeGreaterThan(0);
	});

	it("allows low LOD activity items to span multiple source messages", () => {
		const built = buildPretextDocumentLayout(
			[message("m0", 0, "assistant", "thinking"), message("m1", 1, "assistant", "more thinking")],
			{
				layoutRevision: "layout-l2",
				documentRevision: 2,
				lod: 2,
				widthBucket: "860",
				contentWidth: 860,
			},
		);
		expect(built.manifest.items.length).toBeGreaterThan(0);
		expect(built.manifest.items.every((item) => Number.isFinite(item.height))).toBe(true);
	});

	// ── Source attribution must not depend on document size ─────────────────────
	//
	// The owner lookup used to scan EVERY registered key for each item whose spec
	// key was not an exact match, making a rebuild O(items x keys). That is the
	// budget a live streaming rebuild needs, so the scan was replaced by a
	// probe-by-registered-length lookup. These two tests pin the replacement:
	// attribution stays identical as the document grows, and the growth stays
	// linear rather than quadratic.
	it("attributes derived items to the same source messages regardless of document size", () => {
		const options = {
			layoutRevision: "layout-attr",
			documentRevision: "attr",
			lod: 5 as const,
			widthBucket: "860",
			contentWidth: 860,
			topPadding: 16,
			bottomPadding: 16,
			gap: 4,
		};
		const small = buildPretextDocumentLayout(historyFixture(40), options);
		const large = buildPretextDocumentLayout(historyFixture(240), options);
		const attribution = (built: ReturnType<typeof buildPretextDocumentLayout>) =>
			new Map(built.manifest.items.map((item) => [item.itemKey, [...item.sourceMessageIds]]));
		const smallAttribution = attribution(small);
		const largeAttribution = attribution(large);
		// Every item of the small document also exists in the large one (the fixture
		// is a prefix-stable generator), with byte-identical source attribution.
		expect(smallAttribution.size).toBeGreaterThan(0);
		for (const [itemKey, sourceIds] of smallAttribution) {
			expect(largeAttribution.get(itemKey)).toEqual(sourceIds);
		}
		// No item may fall back to the synthetic `layout:<seq>` placeholder: that is
		// what a failed owner lookup produces.
		for (const item of large.manifest.items) {
			expect(item.sourceMessageIds.some((id) => id.startsWith("layout:"))).toBe(false);
		}
	});

	// ── The pinned latest-tasks card ──────────────────────────────────────────
	//
	// The pin is derived HERE, from the messages being laid out — never accepted as a
	// build option. The shell tracks its own copy for the task-board spinner, but that
	// one is scanned over a different list, so a caller-supplied id could disagree with
	// the document AND (being deliberately kept out of the build deps) never correct
	// itself. These tests pin the derivation, not a passed-in value.
	function tasksToolMessage(id: string, seq: number, toolUseId: string): NarratorMsg {
		return {
			...message(id, seq, "assistant", ""),
			contentJson: [
				{
					type: "tool_use",
					id: toolUseId,
					name: "Write",
					input: { file_path: "spec://tasks.json" },
					status: "completed",
				},
			],
			contentText: null,
			toolCalls: [
				{
					toolUseId,
					toolName: "Write",
					inputJson: { file_path: "spec://tasks.json" },
					status: "completed",
				},
			],
		} as unknown as NarratorMsg;
	}

	const PIN_OPTIONS = {
		layoutRevision: "layout-pin",
		documentRevision: "pin",
		widthBucket: "860",
		contentWidth: 860,
		topPadding: 16,
		bottomPadding: 16,
		gap: 4,
	};

	it("keeps the LATEST tasks card out of the low-LOD fold, deriving the id itself", () => {
		// Two completed tasks writes: only the second may escape the fold. At L2 every
		// completed call folds into a trace/count, so a standalone `tool-` item can only
		// come from the pin.
		const built = buildPretextDocumentLayout(
			[
				message("m0", 0, "user", "hello"),
				tasksToolMessage("m1", 1, "tu-old"),
				tasksToolMessage("m2", 2, "tu-new"),
			],
			{ ...PIN_OPTIONS, lod: 2 as const },
		);
		const keys = built.manifest.items.map((item) => item.itemKey);
		expect(keys.some((key) => key.includes("tu-new"))).toBe(true);
		// The superseded card is NOT pinned — it folds like any other completed call, so
		// no standalone item carries its id.
		expect(keys.some((key) => key.startsWith("tool-tu-old"))).toBe(false);
	});

	it("moves the pin when a newer tasks write lands (no stale id can persist)", () => {
		const before = buildPretextDocumentLayout([tasksToolMessage("m1", 1, "tu-a")], {
			...PIN_OPTIONS,
			lod: 2 as const,
		});
		const after = buildPretextDocumentLayout(
			[tasksToolMessage("m1", 1, "tu-a"), tasksToolMessage("m2", 2, "tu-b")],
			{ ...PIN_OPTIONS, lod: 2 as const },
		);
		expect(before.manifest.items.some((i) => i.itemKey.includes("tu-a"))).toBe(true);
		const afterKeys = after.manifest.items.map((item) => item.itemKey);
		expect(afterKeys.some((key) => key.includes("tu-b"))).toBe(true);
		expect(afterKeys.some((key) => key.startsWith("tool-tu-a"))).toBe(false);
	});

	it("leaves a document with no tasks write untouched (nothing pinned)", () => {
		// The fold gate must be a no-op when the derivation finds nothing: a plain tool
		// run at L2 keeps folding exactly as before.
		const built = buildPretextDocumentLayout(historyFixture(40), {
			...PIN_OPTIONS,
			lod: 2 as const,
		});
		expect(built.manifest.items.length).toBeGreaterThan(0);
		expect(built.manifest.items.some((item) => item.itemKey.startsWith("tool-tool-use-"))).toBe(
			false,
		);
	});

	/**
	 * ⚠️ Reported as "a low LOD swallowed a tool call".
	 *
	 * The pin used to leave the WHOLE tool-run out of the activity fold (the keep set
	 * was expressed in message ids). That run then reached the adapter as a plain
	 * tool-run, where L1/L2 collapse completed calls into a `tool-run-count` — a bare
	 * "tool calls ×N" line naming nothing. So a run of Write(tasks.json) + ShareFile
	 * showed the pinned task board plus an anonymous "×2", and the ShareFile call had
	 * no row anywhere: at L1/L2 it was unreachable, while the same document with no
	 * pin listed it as a named trace row.
	 *
	 * The invariant: at EVERY level, every call is addressable — as its own card, or
	 * as a named row inside a trace. A count line has no rows, so it may never be the
	 * only home of a call.
	 */
	it("keeps every sibling call addressable at low LOD when one is pinned", () => {
		// One run: Write(spec://tasks.json) then ShareFile — the reported shape.
		const runMessage = {
			...message("m-run", 1, "assistant", ""),
			contentJson: [
				{
					type: "tool_use",
					id: "tu-tasks",
					name: "Write",
					input: { file_path: "spec://tasks.json" },
				},
				{
					type: "tool_use",
					id: "tu-share",
					name: "ShareFile",
					input: { path: "dist/app.exe" },
				},
			],
			contentText: null,
			toolCalls: [
				{
					toolUseId: "tu-tasks",
					toolName: "Write",
					inputJson: { file_path: "spec://tasks.json" },
					status: "success",
				},
				{
					toolUseId: "tu-share",
					toolName: "ShareFile",
					inputJson: { path: "dist/app.exe" },
					status: "success",
				},
			],
		} as unknown as NarratorMsg;

		for (const lod of [1, 2, 3] as const) {
			const built = buildPretextDocumentLayout([runMessage], { ...PIN_OPTIONS, lod });
			// Every place a call can be named: a standalone card's key, or a trace row.
			const named = new Set<string>();
			for (const item of built.items) {
				named.add(item.spec.key);
				const rows = (item.spec.data as { items?: { key?: unknown }[] }).items ?? [];
				for (const row of rows) {
					if (typeof row?.key === "string") named.add(row.key);
				}
			}
			expect(named.has("tool-tu-tasks")).toBe(true);
			// The one that used to disappear behind the count line.
			expect(named.has("tool-tu-share")).toBe(true);
			// And no count line may stand in for it: a `tool-run-count` carries no rows.
			expect(built.items.some((item) => item.spec.kind === "tool-run-count")).toBe(false);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Owner attribution complexity
//
// The rebuild used to resolve each derived spec key by scanning EVERY registered
// owner key — O(items x keys), ~38ms of a ~49ms rebuild at 1600 items, i.e. the
// whole budget a live streaming rebuild needs.
//
// These tests guard the replacement DETERMINISTICALLY. A timing assertion was
// tried first and rejected: measured standalone, the old scan's 200 -> 800 cost
// ratio is ~4.3x and the new lookup's ~2.0x, so any threshold loose enough to
// survive CI noise also passes the bug. The invariant that actually separates them
// is the per-item PROBE COUNT, which is exact and clock-free.
// ─────────────────────────────────────────────────────────────────────────────
describe("createLongestPrefixLookup", () => {
	/** Owner keys in the shapes buildSourceResolver registers. */
	function ownerRegistry(count: number): Map<string, string> {
		const registry = new Map<string, string>();
		for (let index = 0; index < count; index++) {
			if (index % 13 === 0) {
				const toolKey = `tool-tool-use-${index}`;
				registry.set(toolKey, toolKey);
				registry.set(`toolrun-summary-${toolKey}`, toolKey);
				registry.set(`toolrun-count-${toolKey}`, toolKey);
				continue;
			}
			registry.set(`message-${index}`, `message-${index}`);
		}
		return registry;
	}

	/** The previous implementation, kept here purely as the equivalence oracle. */
	function scanEveryKey(registry: ReadonlyMap<string, string>, specKey: string) {
		let ownerKey = "";
		for (const key of registry.keys()) {
			if (key.length > ownerKey.length && specKey.startsWith(key)) ownerKey = key;
		}
		return ownerKey ? registry.get(ownerKey) : undefined;
	}

	it("returns the same owner as a full scan for every derived key shape", () => {
		const registry = ownerRegistry(120);
		const lookup = createLongestPrefixLookup(registry);
		const probes: string[] = [];
		for (let index = 0; index < 120; index++) {
			if (index % 13 === 0) {
				probes.push(`tool-tool-use-${index}`, `tool-tool-use-${index}#dup1`);
				probes.push(`toolrun-summary-tool-tool-use-${index}`);
				continue;
			}
			probes.push(`message-${index}`, `message-${index}-b0`, `message-${index}-b11`);
		}
		// Plus the shapes that must resolve to NOTHING.
		probes.push("", "m", "unknown-key", "message-", "tool-", "activity-nope-0");
		for (const specKey of probes) {
			expect(lookup.resolve(specKey)).toBe(scanEveryKey(registry, specKey));
		}
	});

	it("prefers the longest registered prefix when owner keys nest", () => {
		// `tool-tX` is a prefix of `tool-tXY`: a derived key of the longer id must
		// not be attributed to the shorter one.
		const registry = new Map([
			["tool-tX", "short"],
			["tool-tXY", "long"],
		]);
		const lookup = createLongestPrefixLookup(registry);
		expect(lookup.resolve("tool-tXY#dup1")).toBe("long");
		expect(lookup.resolve("tool-tX#dup1")).toBe("short");
	});

	it("bounds per-item probes by key SHAPE, not by document size", () => {
		// This is the complexity claim: the probe count per lookup is the number of
		// distinct registered key lengths, which is a property of the key shapes. A
		// 4x larger document must not widen it. (The old scan's per-item cost was
		// the full key count, which grows ~4x here.)
		const small = createLongestPrefixLookup(ownerRegistry(200));
		const large = createLongestPrefixLookup(ownerRegistry(800));
		expect(large.probeLengths.length).toBeLessThanOrEqual(small.probeLengths.length + 2);
		// And the bound must be far below the registry size it replaced.
		expect(large.probeLengths.length * 8).toBeLessThan(ownerRegistry(800).size);
	});
});
