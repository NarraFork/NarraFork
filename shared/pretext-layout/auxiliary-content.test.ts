import { describe, expect, test } from "bun:test";
import { rowWithElements } from "../narrator-blocks/message-blocks";
import {
	type AuxiliaryContentData,
	auxiliaryContentKey,
	auxiliaryContentViews,
	buildAuxiliaryContentData,
} from "./auxiliary-content";
import { type AdapterMessage, adaptActivityUnit, adaptSegment } from "./segment-adapter";

function message(
	blocks: { type: string; [key: string]: unknown }[],
	extra: Partial<AdapterMessage> = {},
): AdapterMessage {
	return rowWithElements({ id: "message", role: "sys", ...extra }, blocks);
}
function injection(source = "bg_bash", preview = "output") {
	return {
		type: "system_injection",
		source,
		modelText: "EXACT MODEL COPY",
		body: {
			kind: "tasksDone",
			flavor: source === "bg_agent" ? "agent" : "bash",
			items: [{ id: "task", alias: "checks", title: "Checks", status: "failed", preview }],
		},
	};
}

describe("auxiliary content projection", () => {
	test("uses physical source ownership and the same key across LODs", () => {
		const msg = message([
			{ type: "text", text: "before" },
			injection(),
			{ type: "text", text: "after" },
		]);
		const [view] = auxiliaryContentViews(msg);
		expect(view.sourceIndices).toEqual([1]);
		expect(auxiliaryContentViews(msg, [0, 2])).toEqual([]);
		const specs = adaptSegment({ kind: "message", msg }, { lod: 3, compactAuxiliaryContent: true });
		expect(specs.map((spec) => spec.kind)).toEqual(["markdown", "auxiliary-content", "markdown"]);
		expect(specs[1].key).toBe(auxiliaryContentKey(msg, 1));
		expect((specs[1].data as AuxiliaryContentData).detail).toBeUndefined();
		expect(specs[1].data).toMatchObject({
			toolName: "Bash",
			summary: "checks",
			sourceStatus: "failed",
		});
		expect(
			buildAuxiliaryContentData(view, {
				labels: { sidecarSourceBgBash: "Background command notification" },
			}),
		).toMatchObject({ toolName: "Bash", summary: "checks" });
		const trace = adaptActivityUnit([{ kind: "auxiliary", msg, ...view }], "trace", {
			lod: 2,
			compactAuxiliaryContent: true,
		});
		const row = (trace.data as { items: Record<string, unknown>[] }).items[0];
		expect(row.key).toBe(specs[1].key);
		expect(row.unitId).toBe(specs[1].unitId);
		expect(row.status).toBe("fail");
		expect(row.card).toBeUndefined();
		expect(row.identity).toMatchObject({
			auxiliary: true,
			messageId: "message",
			blockIndex: 1,
			blockIndices: [1],
		});
		expect(row.identity).not.toHaveProperty("toolUseId");
		expect(row.identity).not.toHaveProperty("toolDetailRef");
	});

	test("legacy companion text is consumed once and filtered indices never reappear", () => {
		const legacy = { ...injection(), modelText: undefined };
		const msg = message([
			{ type: "text", text: "legacy model" },
			legacy,
			{ type: "text", text: "answer" },
		]);
		expect(auxiliaryContentViews(msg)[0].sourceIndices).toEqual([0, 1]);
		const specs = adaptSegment(
			{ kind: "message", msg, visibleBlockIndices: [1] },
			{ lod: 5, compactAuxiliaryContent: true },
		);
		expect(specs).toHaveLength(1);
		expect((specs[0].data as AuxiliaryContentData).modelFacing).toBe("legacy model");
		const companionOnly = adaptSegment(
			{ kind: "message", msg, visibleBlockIndices: [0] },
			{ lod: 3, compactAuxiliaryContent: true },
		);
		expect(companionOnly).toHaveLength(1);
		expect(companionOnly[0]).toMatchObject({ kind: "markdown", data: "legacy model" });
	});

	test("actual human sources, shown messages, unknown types and controls stay on their old path", () => {
		for (const extra of [{ role: "user" }, { role: "user", origin: "user" }]) {
			expect(auxiliaryContentViews(message([injection()], extra))).toEqual([]);
		}
		for (const block of [
			{ ...injection(), status: "pending" },
			{ ...injection(), source: "pipeline_exit_confirmation" },
			{ ...injection(), source: "unknown_source" },
			{ type: "subagent_recovery" },
			{
				type: "system_injection",
				source: "team_message",
				modelText: "human",
				body: { kind: "messages", items: [{ text: "hello", fromType: "human" }] },
			},
			{
				type: "system_injection",
				source: "team_message",
				modelText: "shown",
				body: {
					kind: "messages",
					items: [{ text: "hello", fromType: "primary", showToUser: true }],
				},
			},
		])
			expect(auxiliaryContentViews(message([block]))).toEqual([]);
	});

	test("human origins and asynchronous answer receipts retain their dedicated legacy path", () => {
		const answered = message(
			[
				{
					type: "system_injection",
					source: "async_question_answer",
					modelText: "EXACT ANSWER MODEL COPY",
					body: {
						kind: "asyncQuestionAnswers",
						questionId: "q1",
						outcome: "answered",
						items: [{ header: "Choice", answer: "Actual human answer" }],
					},
				},
			],
			{ role: "user", origin: "user", creator: { username: "Person" } },
		);
		for (const msg of [answered, message([injection()], { role: "user", origin: "user" })]) {
			const legacy = adaptSegment({ kind: "message", msg }, { lod: 3 });
			const compact = adaptSegment(
				{ kind: "message", msg },
				{ lod: 3, compactAuxiliaryContent: true },
			);
			expect(compact).toEqual(legacy);
			expect(compact.some((spec) => spec.kind === "auxiliary-content")).toBe(false);
		}
		const [receipt] = adaptSegment(
			{ kind: "message", msg: answered },
			{ lod: 3, compactAuxiliaryContent: true },
		);
		expect(receipt.kind).toBe("system-text");
		expect(receipt.data).toMatchObject({ questionReference: { questionId: "q1" } });
		expect(auxiliaryContentViews(answered)).toEqual([]);
	});

	test("knowledge is one row with personal/global structured navigation", () => {
		const msg = message([
			{
				type: "knowledge_hint",
				source: "tool_output",
				modelText: "knowledge model",
				entries: [
					{ entryId: "one", scope: "personal", title: "One", summary: "Excerpt one" },
					{ entryId: "two", title: "Two", summary: "Excerpt two" },
				],
			},
		]);
		const [view] = auxiliaryContentViews(msg);
		const header = buildAuxiliaryContentData(view);
		expect(header.category).toBe("knowledge");
		expect(header.sourceStatus).toBeUndefined();
		expect(header.detail).toBeUndefined();
		const detail = buildAuxiliaryContentData(view, { includeDetail: true }).detail;
		expect(detail?.sections[0].body).toMatchObject({
			kind: "structured",
			entries: [
				{ target: { kind: "knowledge", entryId: "one", scope: "personal" } },
				{ target: { kind: "knowledge", entryId: "two", scope: "global" } },
			],
		});
	});

	test("folded summaries never read the background output and recent preview is bounded", () => {
		const block = injection();
		Object.defineProperty(block.body.items[0], "preview", {
			get() {
				throw new Error("folded output read");
			},
		});
		const [view] = auxiliaryContentViews(message([block]));
		expect(() => buildAuxiliaryContentData(view)).not.toThrow();
		const large = message([injection("bg_bash", "x".repeat(1_000_000))]);
		const [spec] = adaptSegment(
			{ kind: "message", msg: large },
			{ lod: 4, compactAuxiliaryContent: true },
		);
		const data = spec.data as AuxiliaryContentData;
		const body = data.detail?.sections[0].body;
		expect(body).toMatchObject({ kind: "capped", format: "text", textTruncated: true });
		if (body?.kind === "capped") expect(body.text?.length).toBeLessThanOrEqual(8192);
		expect(data.modelFacing).toBe("EXACT MODEL COPY");
		expect(spec.opts).toMatchObject({ defaultOpened: true });
		expect(spec.opts).not.toHaveProperty("opened");
	});

	test("a preview budget exhausted exactly at a task boundary never reads subsequent output", () => {
		const block = injection("bg_bash", "x".repeat(8192));
		const later = {
			id: "later",
			alias: "later",
			title: "Later",
			status: "completed",
			preview: "later",
		};
		Object.defineProperty(later, "preview", {
			get() {
				throw new Error("preview budget exhausted");
			},
		});
		block.body.items.push(later);
		const [view] = auxiliaryContentViews(message([block]));
		expect(() =>
			buildAuxiliaryContentData(view, { includeDetail: true, preview: true }),
		).not.toThrow();
		const detail = buildAuxiliaryContentData(view, { includeDetail: true, preview: true }).detail;
		expect(detail?.sections[0].body).toMatchObject({ kind: "capped", textTruncated: true });
	});

	test("manually opened old rows cannot hide behind L1 or earlier", () => {
		const msg = message(Array.from({ length: 12 }, () => injection()));
		const views = auxiliaryContentViews(msg);
		const key = auxiliaryContentKey(msg, 0);
		const spec = adaptActivityUnit(
			views.map((view) => ({ kind: "auxiliary", msg, ...view })),
			"old-trace",
			{
				lod: 1,
				compactAuxiliaryContent: true,
				recentMessageIds: new Set(),
				isRowExpanded: (_traceKey, rowKey) => rowKey === key,
			},
		);
		expect(spec.opts).toMatchObject({ collapsed: false, showEarlier: true, expandedIndices: [0] });
		const row = (spec.data as { items: Record<string, unknown>[] }).items[0];
		expect(row.cardKind).toBe("auxiliary-content");
		expect(row.card).toMatchObject({ sourceStatus: "failed", status: "fail" });
	});

	test("L3 explicit override constructs detail and later failures stay discoverable without auto-opening", () => {
		const block = injection();
		block.body.items.unshift({
			id: "ok",
			alias: "ok",
			title: "OK",
			status: "completed",
			preview: "done",
		});
		const msg = message([block]);
		const key = auxiliaryContentKey(msg, 0);
		const [spec] = adaptSegment(
			{ kind: "message", msg },
			{
				lod: 3,
				compactAuxiliaryContent: true,
				isLodUserOverride: (candidate) => candidate === key,
			},
		);
		expect(spec.opts).toMatchObject({ lodUserOverride: true, defaultOpened: false });
		expect((spec.data as AuxiliaryContentData).detail).toBeDefined();
		const [view] = auxiliaryContentViews(msg);
		const trace = adaptActivityUnit([{ kind: "auxiliary", msg, ...view }], "trace", {
			lod: 1,
			compactAuxiliaryContent: true,
			recentMessageIds: new Set(),
			labels: { status_fail: "失败" },
		});
		expect(trace.data).toMatchObject({ failureCount: 1, headerCount: "1 · 1 失败" });
		expect(trace.opts).toMatchObject({ collapsed: true, expandedIndices: [] });
	});

	test("internal Send is a bubble from L3 up and authoritative question lifecycle reaches adapter", () => {
		const msg = message([], { role: "assistant" });
		const item = {
			blockIndex: 0,
			msg,
			isSubagent: true,
			tc: {
				toolName: "Send",
				toolUseId: "send",
				status: "success",
				inputJson: { id: "child", show_to_user: false },
			},
		};
		// show_to_user only decides which bubbles survive L1/L2; L3+ shows every one.
		for (const lod of [3, 4, 5] as const) {
			const [send] = adaptSegment(
				{ kind: "tool-run", items: [item], sourceMessages: [msg] },
				{ lod, compactAuxiliaryContent: true },
			);
			expect(send.kind).toBe("communication-bubble");
			// The identity its L1/L2 trace row carries, so a level switch pairs the two.
			expect(send.unitId).toBe("tool-send");
		}
		const row = adaptActivityUnit([{ kind: "tool", ...item }], "trace", {
			lod: 2,
			compactAuxiliaryContent: true,
		});
		expect((row.data as { items: { unitId: string }[] }).items[0].unitId).toBe("tool-send");
		const ask = {
			...item,
			isSubagent: false,
			tc: {
				toolName: "AskUserQuestion",
				toolUseId: "ask",
				status: "success",
				inputJson: { async: true },
			},
		};
		for (const questionStatus of ["open", "answered", undefined]) {
			const [spec] = adaptSegment(
				{ kind: "tool-run", items: [ask], sourceMessages: [msg] },
				{ lod: 3, compactAuxiliaryContent: true, resolveQuestionStatus: () => questionStatus },
			);
			expect(spec.opts?.preferOpen).toBe(questionStatus !== "answered");
		}
	});

	test("compact outgoing communication and completed decisions summarize their actual content", () => {
		const msg = message([], { role: "assistant" });
		const cases = [
			{
				tc: {
					toolName: "Send",
					toolUseId: "send",
					status: "success",
					inputJson: { id: "child", message: "Review is ready\nwith details", show_to_user: false },
					_metadata: { targets: [{ id: "child", title: "Readable Child" }] },
				},
				summary: "Readable Child：Review is ready with details",
			},
			{
				tc: {
					toolName: "AskUserQuestion",
					toolUseId: "ask",
					status: "success",
					inputJson: {
						questions: [{ header: "Which choice?" }],
						answers: { choice: "Actual answer" },
					},
				},
				summary: "Answer: Actual answer",
			},
			{
				tc: {
					toolName: "ExitPlanMode",
					toolUseId: "plan",
					status: "denied",
					inputJson: {},
					permissionDenyMessage: "Narrow the scope",
				},
				summary: "Denied · Narrow the scope",
			},
		];
		for (const { tc, summary } of cases) {
			const item = { msg, blockIndex: 0, tc, isSubagent: false };
			const ctx = {
				lod: 3 as const,
				compactAuxiliaryContent: true,
				resolveToolSummary: () => "legacy summary",
				resolveToolTitle: () => "legacy title",
			};
			const [spec] = adaptSegment({ kind: "tool-run", items: [item], sourceMessages: [msg] }, ctx);
			// From L3 up a Send is a bubble carrying its own text, not a summarized card.
			if (tc.toolName === "Send") expect(spec.kind).toBe("communication-bubble");
			else expect(spec.data).toMatchObject({ summary });
			const trace = adaptActivityUnit([{ kind: "tool", ...item }], "trace", ctx);
			expect((trace.data as { items: { title: string }[] }).items[0].title).toBe(
				`${tc.toolName} · ${summary}`,
			);
		}
		const inbound = message([
			{
				type: "system_injection",
				source: "team_message",
				modelText: "model",
				body: {
					kind: "messages",
					items: [
						{
							fromId: "sender",
							fromTitle: "Reviewer",
							fromType: "primary",
							text: "Found the issue",
						},
					],
				},
			},
		]);
		const [view] = auxiliaryContentViews(inbound);
		expect(buildAuxiliaryContentData(view)).toMatchObject({
			toolName: "Reviewer",
			summary: "Found the issue",
		});
	});

	test("received agent messages are rows at L1/L2 and bubbles from L3 up, under one identity", () => {
		const inbound = message([
			{
				type: "system_injection",
				source: "team_message",
				modelText: "model",
				body: {
					kind: "messages",
					items: [
						{ fromId: "sender", fromTitle: "Reviewer", fromType: "primary", text: "Found it" },
					],
				},
			},
		]);
		const rowKey = auxiliaryContentKey(inbound, 0);
		for (const lod of [1, 2] as const) {
			const [spec] = adaptSegment(
				{ kind: "message", msg: inbound },
				{ lod, compactAuxiliaryContent: true },
			);
			expect(spec.kind).toBe("auxiliary-content");
			expect(spec.unitId).toBe(rowKey);
		}
		for (const lod of [3, 4, 5] as const) {
			const [spec] = adaptSegment(
				{ kind: "message", msg: inbound },
				{ lod, compactAuxiliaryContent: true },
			);
			expect(spec.kind).toBe("injection-bubble");
			// Without this the bubble and its row have different keys and never pair.
			expect(spec.unitId).toBe(rowKey);
		}
		// Background results are not messages: they stay tool rows at every level.
		const background = message([injection()]);
		expect(
			adaptSegment(
				{ kind: "message", msg: background },
				{ lod: 3, compactAuxiliaryContent: true },
			)[0].kind,
		).toBe("auxiliary-content");
	});

	test("false and omitted preserve the legacy bubble projection", () => {
		const msg = message([injection()]);
		for (const compactAuxiliaryContent of [false, undefined]) {
			expect(
				adaptSegment({ kind: "message", msg }, { lod: 2, compactAuxiliaryContent })[0].kind,
			).toBe("injection-bubble");
		}
	});
});
