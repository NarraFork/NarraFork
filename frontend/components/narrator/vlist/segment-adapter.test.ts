import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { VLIST_REGISTRY } from "./registry";
import {
	type AdapterContext,
	type AdapterSegment,
	adaptSegment,
	adaptSegments,
	classifyContentBlock,
} from "./segment-adapter";

// The subagent-card enrichment suite exercises measureSubagentCard, which drives
// pretext's canvas measureText. Install the deterministic canvas stub so this file
// is self-contained and does not depend on another test file leaking the global
// OffscreenCanvas stub (test-order coupling → flaky under sharding).
beforeAll(() => {
	installCanvasStub();
});

const CTX: AdapterContext = { lod: 5 };

describe("classifyContentBlock", () => {
	it("routes content blocks to element kinds", () => {
		expect(classifyContentBlock({ type: "text", text: "hi" })).toBe("markdown");
		expect(classifyContentBlock({ type: "text", text: "  " })).toBeNull(); // blank
		expect(classifyContentBlock({ type: "image" })).toBe("media");
		expect(classifyContentBlock({ type: "text_file" })).toBe("media");
		expect(classifyContentBlock({ type: "image_generation" })).toBe("media");
		expect(classifyContentBlock({ type: "reasoning", text: "x" })).toBe("reasoning");
		expect(classifyContentBlock({ type: "thinking", text: "x" })).toBe("reasoning");
		expect(classifyContentBlock({ type: "web_search" })).toBe("web-search");
		expect(classifyContentBlock({ type: "tool_use" })).toBeNull(); // tool lane, not content
	});
});

describe("adaptSegment — prune divider", () => {
	it("maps to prune-divider kind", () => {
		const specs = adaptSegment({ kind: "prune-divider", label: "older" }, CTX);
		expect(specs).toHaveLength(1);
		expect(specs[0]!.kind).toBe("prune-divider");
	});
});

describe("adaptSegment — user message", () => {
	it("produces a single message-bubble with joined plain text", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "u1",
				role: "user",
				contentJson: [
					{ type: "text", text: "line1" },
					{ type: "text", text: "line2" },
				],
			},
		};
		const specs = adaptSegment(seg, CTX);
		expect(specs).toHaveLength(1);
		expect(specs[0]!.kind).toBe("message-bubble");
		expect((specs[0]!.data as { role: string; text: string }).role).toBe("user");
		expect((specs[0]!.data as { text: string }).text).toBe("line1\nline2");
	});

	it("carries creator + createdAt so the render layer can paint the header", () => {
		const creator = { id: "u1", username: "alice", avatarColor: "#f00", avatarImageId: null };
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "u1",
				role: "user",
				createdAt: "2026-01-01T12:34:00.000Z",
				creator,
				contentJson: [{ type: "text", text: "hi" }],
			},
		};
		const specs = adaptSegment(seg, CTX);
		const data = specs[0]!.data as {
			hasHeader: boolean;
			creator: typeof creator;
			createdAt: string;
		};
		expect(data.hasHeader).toBe(true);
		expect(data.creator).toEqual(creator);
		expect(data.createdAt).toBe("2026-01-01T12:34:00.000Z");
	});

	it("defaults creator/createdAt to null when the message omits them", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "u2", role: "user", contentJson: [{ type: "text", text: "hi" }] },
		};
		const specs = adaptSegment(seg, CTX);
		const data = specs[0]!.data as { creator: unknown; createdAt: unknown };
		expect(data.creator).toBeNull();
		expect(data.createdAt).toBeNull();
	});
});

describe("adaptSegment — assistant message", () => {
	it("dispatches each visible block to its kind", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "a1",
				role: "assistant",
				contentJson: [
					{ type: "reasoning", text: "thinking..." },
					{ type: "text", text: "Here is the answer." },
					{ type: "web_search", query: "cats", status: "completed" },
					{ type: "image" },
				],
			},
		};
		const specs = adaptSegment(seg, CTX);
		expect(specs.map((s) => s.kind)).toEqual(["reasoning", "markdown", "web-search", "media"]);
	});

	it("skips blank text blocks", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "a2", role: "assistant", contentJson: [{ type: "text", text: "   " }] },
		};
		expect(adaptSegment(seg, CTX)).toHaveLength(0);
	});

	it("honors visibleBlockIndices", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "a3",
				role: "assistant",
				contentJson: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
			visibleBlockIndices: [1],
		};
		const specs = adaptSegment(seg, CTX);
		expect(specs).toHaveLength(1);
		expect(specs[0]!.data).toBe("second");
	});

	it("passes reasoning expand state via opts", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "a4", role: "assistant", contentJson: [{ type: "reasoning", text: "x" }] },
		};
		const expanded = adaptSegment(seg, { lod: 5, isExpanded: () => true });
		expect((expanded[0]!.opts as { expanded: boolean }).expanded).toBe(true);
	});
});

describe("adaptSegment — system message", () => {
	it("routes plan subtype to plan-card", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "s1",
				role: "system",
				contentJson: [{ type: "compact", subtype: "plan", summary: "the plan" }],
			},
		};
		const specs = adaptSegment(seg, CTX);
		expect(specs[0]!.kind).toBe("plan-card");
	});

	it("routes compact to system-simple", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "s2", role: "system", contentJson: [{ type: "compact" }] },
		};
		expect(adaptSegment(seg, CTX)[0]!.kind).toBe("system-simple");
	});

	it("routes error to system-text", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "s3", role: "system", contentJson: [{ type: "error", text: "boom" }] },
		};
		expect(adaptSegment(seg, CTX)[0]!.kind).toBe("system-text");
	});
});

describe("adaptSegment — system card body composition (height-critical)", () => {
	const sysData = (
		contentJson: Array<{ type: string; [key: string]: unknown }>,
		ctx: AdapterContext = CTX,
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
	): any =>
		adaptSegment({ kind: "message", msg: { id: "s", role: "system", contentJson } }, ctx)[0]!.data;

	it("error: reads block.message (not empty block.text) as the wrapping body", () => {
		const data = sysData([{ type: "error", message: "module not found 'foo'" }]);
		expect(data.kind).toBe("error");
		expect(data.text).toBe("module not found 'foo'");
		expect(data.actions).toBe(true);
	});

	it("error: falls back to unknownError label when no message", () => {
		expect(sysData([{ type: "error" }]).text).toBe("Unknown error");
		expect(sysData([{ type: "error" }], { lod: 5, labels: { unknownError: "错误" } }).text).toBe(
			"错误",
		);
	});

	it("spec_goal_added: composes task text + protected/added badges + view button", () => {
		const data = sysData([
			{ type: "spec_goal_added", task: "Implement zero-DOM model", added: true },
		]);
		expect(data.kind).toBe("spec_goal_added");
		expect(data.text).toBe("Implement zero-DOM model");
		expect(data.added).toBe(true);
		expect(data.badges).toEqual(["Protected", "Goal added"]);
		expect(data.buttons).toEqual(["View tasks"]);
	});

	it("spec_goal_added: added=false → 'already tracked' badge; falls back to contentText", () => {
		const data = sysData([
			{ type: "text", text: "the objective" },
			{ type: "spec_goal_added", added: false },
		]);
		expect(data.text).toBe("the objective");
		expect(data.added).toBe(false);
		expect(data.badges[1]).toBe("Already tracked");
	});

	it("spec_continuation: reads block.task + protected flag + badge label", () => {
		const data = sysData([{ type: "spec_continuation", task: "Wire the flag", protected: true }]);
		expect(data.kind).toBe("spec_continuation");
		expect(data.text).toBe("Wire the flag");
		expect(data.protected).toBe(true);
		expect(data.badgeLabel).toBe("Task");
		expect(data.color).toBe("indigo");
	});

	it("spec_blocked_continuation: orange color + blocked badge", () => {
		const data = sysData([{ type: "spec_blocked_continuation", task: "Blocked task" }]);
		expect(data.color).toBe("orange");
		expect(data.badgeLabel).toBe("Blocked");
	});

	it("spec_fork_carryover: composes a summary description from counts", () => {
		const data = sysData([{ type: "spec_fork_carryover", total: 3, open: 2, protectedOpen: 1 }]);
		expect(data.kind).toBe("spec_fork_carryover");
		expect(data.variant).toBe("fork");
		expect(data.text).toContain("3");
		expect(data.text).toContain("2");
		expect(data.text).toContain("1");
		expect(data.buttons).toHaveLength(3);
	});

	it("spec_fork_carryover: uses injected localized template with placeholders", () => {
		const data = sysData([{ type: "spec_fork_carryover", total: 5, open: 4, protectedOpen: 2 }], {
			lod: 5,
			labels: { specForkCarryoverDesc: "带入 {count} 项（{open} 未完成，{protectedOpen} 受保护）" },
		});
		expect(data.text).toBe("带入 5 项（4 未完成，2 受保护）");
	});

	it("spec_context_cleared: contextCleared variant", () => {
		const data = sysData([{ type: "spec_context_cleared", total: 1, open: 1, protectedOpen: 0 }]);
		expect(data.kind).toBe("spec_context_cleared");
		expect(data.variant).toBe("contextCleared");
	});

	it("segment_compact failed → system-text card with title + dismiss; else simple", () => {
		const failed = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "s",
					role: "system",
					contentJson: [{ type: "segment_compact", status: "failed", error: "oom" }],
				},
			},
			CTX,
		)[0]!;
		expect(failed.kind).toBe("system-text");
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
		const fdata = failed.data as any;
		expect(fdata.kind).toBe("segment_compact_failed");
		expect(fdata.text).toBe("oom");
		expect(fdata.title).toBe("Compaction failed");
		expect(fdata.buttons).toEqual(["Dismiss"]);

		const compacting = sysData([{ type: "segment_compact", status: "compacting", text: "…" }]);
		expect(compacting.kind).toBe("segment_compact");
		expect(compacting.status).toBe("compacting");
	});

	it("merge_summary: reserves avatar; review_feedback: gray", () => {
		const merge = sysData([{ type: "merge_summary", text: "Merged X into trunk" }]);
		expect(merge.kind).toBe("merge_summary");
		expect(merge.hasAvatar).toBe(true);
		expect(merge.text).toBe("Merged X into trunk");
		const review = sysData([{ type: "review_feedback", text: "Review done" }]);
		expect(review.color).toBe("gray");
	});

	it("bash_command: carries the command as both body text and command field", () => {
		const data = sysData([{ type: "bash_command", command: "bun test" }]);
		expect(data.kind).toBe("bash_command");
		expect(data.text).toBe("bun test");
		expect(data.command).toBe("bun test");
	});
});

describe("adaptSegment — compact / segment_compact indicator text (status-synthesized)", () => {
	const compactSpec = (
		contentJson: Array<{ type: string; [key: string]: unknown }>,
		ctx: AdapterContext = CTX,
	) => adaptSegment({ kind: "message", msg: { id: "s", role: "system", contentJson } }, ctx)[0]!;

	// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
	const dataOf = (spec: { data: unknown }) => spec.data as any;

	const COMPACT_LABELS = {
		compacting: "压缩上下文中...",
		compacted: "上下文已压缩",
		compactFailed: "压缩失败",
		compactOutputChars: "{count} 字符",
		segmentCompacting: "正在区段压缩...",
		segmentCompacted: "区段已压缩（{count} 条消息）",
	};

	it("context compact compacting → '…compacting · N chars' (English fallback), never block.summary", () => {
		const spec = compactSpec([
			{ type: "compact", status: "compacting", outputChars: 42, summary: "SHOULD NOT SHOW" },
		]);
		expect(spec.kind).toBe("system-simple");
		expect(dataOf(spec).kind).toBe("compact");
		expect(dataOf(spec).status).toBe("compacting");
		expect(dataOf(spec).text).toBe("Compacting context… · 42 chars");
	});

	it("context compact compacting → localized labels substitute the live count", () => {
		const spec = compactSpec([{ type: "compact", status: "compacting", outputChars: 128 }], {
			lod: 5,
			labels: COMPACT_LABELS,
		});
		expect(dataOf(spec).text).toBe("压缩上下文中... · 128 字符");
	});

	it("context compact compacting → opts.progress folds the live count into the cache key", () => {
		const at0 = compactSpec([{ type: "compact", status: "compacting", outputChars: 0 }]);
		const at99 = compactSpec([{ type: "compact", status: "compacting", outputChars: 99 }]);
		expect(at0.opts?.progress).toBe(0);
		expect(at99.opts?.progress).toBe(99);
	});

	it("context compact compacted → terse 'compacted' label, NOT the summary body", () => {
		const spec = compactSpec([
			{ type: "compact", status: "compacted", summary: "a very long compact summary body" },
		]);
		expect(dataOf(spec).status).toBe("compacted");
		expect(dataOf(spec).text).toBe("Context compacted");
		// A completed marker is stable (cacheable): no progress opt.
		expect(spec.opts?.progress).toBeUndefined();
	});

	it("context compact failed → 'compact failed' label and failed status", () => {
		const spec = compactSpec([{ type: "compact", status: "failed", error: "boom" }]);
		expect(dataOf(spec).status).toBe("failed");
		expect(dataOf(spec).text).toBe("Compact failed");
	});

	it("segment_compact compacting → '…segment compacting · N chars' + progress opt", () => {
		const spec = compactSpec([{ type: "segment_compact", status: "compacting", outputChars: 7 }]);
		expect(dataOf(spec).kind).toBe("segment_compact");
		expect(dataOf(spec).status).toBe("compacting");
		expect(dataOf(spec).text).toBe("Segment compacting… · 7 chars");
		expect(spec.opts?.progress).toBe(7);
	});

	it("segment_compact compacted → 'segment compacted (N messages)', not summary", () => {
		const spec = compactSpec([
			{ type: "segment_compact", status: "compacted", messageCount: 12, summary: "hidden body" },
		]);
		expect(dataOf(spec).status).toBe("compacted");
		expect(dataOf(spec).text).toBe("Segment compacted (12 messages)");
		expect(spec.opts?.progress).toBeUndefined();
	});

	it("segment_compact compacted → localized message-count label", () => {
		const spec = compactSpec([{ type: "segment_compact", status: "compacted", messageCount: 3 }], {
			lod: 5,
			labels: COMPACT_LABELS,
		});
		expect(dataOf(spec).text).toBe("区段已压缩（3 条消息）");
	});
});

describe("adaptSegment — tool run", () => {
	it("maps subagent items to subagent-card and others to tool-call (L5, full cards)", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", summary: "read a file" } },
				{ blockIndex: 1, isSubagent: true, tc: { toolName: "Agent", summary: "spawn" } },
			],
		};
		const specs = adaptSegment(seg, CTX);
		expect(specs.map((s) => s.kind)).toEqual(["tool-call", "subagent-card"]);
	});

	it("L3 folds completed tools into a tool-run-summary", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", status: "completed" } },
				{ blockIndex: 1, isSubagent: false, tc: { toolName: "Bash", status: "completed" } },
			],
		};
		const specs = adaptSegment(seg, { lod: 3 });
		expect(specs).toHaveLength(1);
		expect(specs[0]!.kind).toBe("tool-run-summary");
		expect((specs[0]!.data as { items: unknown[] }).items).toHaveLength(2);
	});

	it("L2 folds completed tools into a tool-run-count", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", status: "completed" } },
				{ blockIndex: 1, isSubagent: false, tc: { toolName: "Bash", status: "completed" } },
				{ blockIndex: 2, isSubagent: false, tc: { toolName: "Grep", status: "completed" } },
			],
		};
		const specs = adaptSegment(seg, { lod: 2 });
		expect(specs).toHaveLength(1);
		expect(specs[0]!.kind).toBe("tool-run-count");
		expect((specs[0]!.data as { count: number }).count).toBe(3);
	});

	it("keeps active tools as standalone full cards even at low LOD", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", status: "completed" } },
				{ blockIndex: 1, isSubagent: false, tc: { toolName: "Bash", status: "running" } },
				{ blockIndex: 2, isSubagent: false, tc: { toolName: "Grep", status: "completed" } },
			],
		};
		const specs = adaptSegment(seg, { lod: 2 });
		// completed(0) → count, active(1) → full tool-call, completed(2) → count
		expect(specs.map((s) => s.kind)).toEqual(["tool-run-count", "tool-call", "tool-run-count"]);
	});
});

describe("adaptSegment — subagent card enrichment (height-safe field passthrough)", () => {
	const subagentData = (
		tc: Record<string, unknown>,
		ctx: AdapterContext = CTX,
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
	): any => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			// biome-ignore lint/suspicious/noExplicitAny: structural tc mirror for the test
			items: [{ blockIndex: 0, isSubagent: true, tc: tc as any }],
		};
		const spec = adaptSegment(seg, ctx)[0]!;
		expect(spec.kind).toBe("subagent-card");
		return spec.data;
	};

	it("wires prompt, isBackground, agentType, description from inputJson", () => {
		const data = subagentData({
			toolName: "Task",
			status: "running",
			inputJson: {
				subagent_type: "explore",
				prompt: "Investigate the failing test",
				description: "look at flaky test",
				run_in_background: true,
			},
		});
		expect(data.prompt).toBe("Investigate the failing test");
		expect(data.isBackground).toBe(true);
		expect(data.agentType).toBe("explore");
		expect(data.description).toBe("look at flaky test");
	});

	it("derives description from prompt when no explicit description", () => {
		const data = subagentData({
			toolName: "Task",
			status: "running",
			inputJson: { prompt: "single line prompt" },
		});
		expect(data.prompt).toBe("single line prompt");
		expect(data.description).toBe("single line prompt");
		expect(data.isBackground).toBe(false);
		expect(data.agentType).toBe("Task");
	});

	it("truncates multi-line prompt to first 80 chars for description", () => {
		const longFirst = "x".repeat(120);
		const data = subagentData({
			toolName: "Task",
			status: "running",
			inputJson: { prompt: `${longFirst}\nsecond line` },
		});
		expect(data.description).toBe(longFirst.slice(0, 80));
	});

	it("reads prompt from `message` and agentType 'send' for Send tools", () => {
		const data = subagentData({
			toolName: "Send",
			status: "success",
			inputJson: { message: "please continue" },
		});
		expect(data.prompt).toBe("please continue");
		expect(data.agentType).toBe("send");
	});

	it("omits prompt when inputJson carries none (no fabrication)", () => {
		const data = subagentData({
			toolName: "Task",
			status: "success",
			inputJson: {},
		});
		expect("prompt" in data).toBe(false);
		expect(data.isBackground).toBe(false);
	});

	it("remains height-safe: measureSubagentCard consumes the enriched data", async () => {
		const { measureSubagentCard } = await import("./measure/measure-subagent");
		const data = subagentData({
			toolName: "Task",
			status: "running",
			inputJson: { subagent_type: "plan", prompt: "line one\nline two\nline three" },
		});
		// Prompt-open path exercises the ContentViewer maxHeight cap.
		const measured = measureSubagentCard({ ...data, promptOpen: true }, 400, 6, { opened: true });
		expect(measured.height).toBeGreaterThan(0);
		expect(measured.promptBlockHeight).toBeGreaterThan(0);
		expect(Number.isFinite(measured.height)).toBe(true);
	});
});

describe("groupToolItemsForLod / isActiveToolItem", () => {
	it("classifies active statuses", async () => {
		const { isActiveToolItem } = await import("./segment-adapter");
		expect(
			isActiveToolItem({
				blockIndex: 0,
				isSubagent: false,
				tc: { toolName: "x", status: "running" },
			}),
		).toBe(true);
		expect(
			isActiveToolItem({
				blockIndex: 0,
				isSubagent: false,
				tc: { toolName: "x", status: "pending" },
			}),
		).toBe(true);
		expect(
			isActiveToolItem({
				blockIndex: 0,
				isSubagent: false,
				tc: { toolName: "x", status: "completed" },
			}),
		).toBe(false);
	});

	it("folds contiguous completed batches, breaks on active", async () => {
		const { groupToolItemsForLod } = await import("./segment-adapter");
		const items = [
			{ blockIndex: 0, isSubagent: false, tc: { toolName: "a", status: "completed" } },
			{ blockIndex: 1, isSubagent: false, tc: { toolName: "b", status: "running" } },
			{ blockIndex: 2, isSubagent: false, tc: { toolName: "c", status: "completed" } },
			{ blockIndex: 3, isSubagent: false, tc: { toolName: "d", status: "completed" } },
		];
		const groups = groupToolItemsForLod(items);
		expect(groups.map((g) => g.kind)).toEqual(["folded", "active", "folded"]);
	});
});

describe("adaptActivityUnit", () => {
	it("produces an activity-trace, collapsed only at L1", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const l2 = adaptActivityUnit([{ kind: "tool" }], "act-1", { lod: 2 });
		expect(l2.kind).toBe("activity-trace");
		expect((l2.opts as { collapsed: boolean }).collapsed).toBe(false);
		const l1 = adaptActivityUnit([{ kind: "tool" }], "act-1", { lod: 1 });
		expect((l1.opts as { collapsed: boolean }).collapsed).toBe(true);
	});
});

/**
 * ⚠️ Folded-row identity. The activity fold walks reasoning blocks ONE BY ONE,
 * while the selection index merges adjacent reasoning blocks and registers an
 * entry only for the run's START index. A row must therefore report the run start,
 * or its blockId would match no entry and every selection action on it would
 * silently do nothing. These tests pin that mapping on the vlist/adapter path
 * (the frontend path is covered by trace-row-identity.test.ts).
 */
describe("adaptActivityUnit — folded row identity", () => {
	const reasoning = (text: string) => ({ type: "reasoning", text });
	const msgWith = (blocks: unknown[], id = "m1") =>
		({ id, role: "assistant", contentJson: blocks }) as never;

	it("maps every row of an adjacent reasoning run to the run's start index", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const blocks = [reasoning("**A**\n\nfirst"), reasoning("**B**\n\nsecond")];
		const msg = msgWith(blocks);
		const spec = adaptActivityUnit(
			[
				{ kind: "reasoning", msg, blockIndex: 0, block: blocks[0] as never },
				{ kind: "reasoning", msg, blockIndex: 1, block: blocks[1] as never },
			],
			"act-1",
			{ lod: 2 },
		);
		const items = (spec.data as { items: { identity?: Record<string, unknown> }[] }).items;
		expect(items.length).toBeGreaterThanOrEqual(2);
		// Both source blocks fold into rows that identify as the run start (0), and
		// carry the run's full index list so delete can act on each.
		for (const item of items) {
			expect(item.identity?.messageId).toBe("m1");
			expect(item.identity?.blockIndex).toBe(0);
			expect(item.identity?.blockIndices).toEqual([0, 1]);
		}
	});

	it("keeps runs split by a tool call on their own start indices", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const blocks = [
			reasoning("first"),
			{ type: "tool_use", id: "tu-1", name: "Read" },
			reasoning("second"),
			reasoning("third"),
		];
		const msg = msgWith(blocks);
		const spec = adaptActivityUnit(
			[
				{ kind: "reasoning", msg, blockIndex: 2, block: blocks[2] as never },
				{ kind: "reasoning", msg, blockIndex: 3, block: blocks[3] as never },
			],
			"act-1",
			{ lod: 2 },
		);
		const items = (spec.data as { items: { identity?: Record<string, unknown> }[] }).items;
		for (const item of items) {
			expect(item.identity?.blockIndex).toBe(2);
			expect(item.identity?.blockIndices).toEqual([2, 3]);
		}
	});

	it("carries toolUseId on tool rows and omits identity for streaming rows", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const msg = msgWith([{ type: "tool_use", id: "tu-9", name: "Read" }]);
		const spec = adaptActivityUnit(
			[{ kind: "tool", msg, blockIndex: 0, tc: { toolName: "Read", toolUseId: "tu-9" } }],
			"act-1",
			{ lod: 2 },
		);
		const items = (spec.data as { items: { identity?: Record<string, unknown> }[] }).items;
		expect(items[0]?.identity?.toolUseId).toBe("tu-9");
		expect(items[0]?.identity?.toolName).toBe("Read");

		// Streaming output has no committed message → non-selectable.
		const streaming = adaptActivityUnit(
			[
				{
					kind: "tool",
					msg: msgWith([], "__streaming__"),
					blockIndex: 0,
					tc: { toolName: "Read", toolUseId: "tu-9" },
				},
			],
			"act-2",
			{ lod: 2 },
		);
		const streamItems = (streaming.data as { items: { identity?: unknown }[] }).items;
		expect(streamItems[0]?.identity).toBeUndefined();
	});

	it("omits identity for a tool call without a toolUseId (no selection entry)", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const spec = adaptActivityUnit(
			[{ kind: "tool", msg: msgWith([]), blockIndex: 0, tc: { toolName: "Read" } }],
			"act-1",
			{ lod: 2 },
		);
		const items = (spec.data as { items: { identity?: unknown }[] }).items;
		expect(items[0]?.identity).toBeUndefined();
	});
});

describe("LOD matrix adapter semantics", () => {
	it("routes structured reasoning to titles-only steps at L3/L4 and full steps at L5/L6", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "reasoning-1",
				role: "assistant",
				contentJson: [
					{ type: "reasoning", text: ["**Plan**", "<!-- -->", "**Check**", "body"].join("\n\n") },
				],
			},
		};
		for (const lod of [3, 4] as const) {
			const spec = adaptSegment(seg, { lod })[0]!;
			expect(spec.kind).toBe("reasoning-steps");
			expect((spec.opts as { titlesOnly: boolean }).titlesOnly).toBe(true);
		}
		for (const lod of [5, 6] as const) {
			const spec = adaptSegment(seg, { lod })[0]!;
			expect(spec.kind).toBe("reasoning-steps");
			expect((spec.opts as { titlesOnly: boolean }).titlesOnly).toBe(false);
			expect((spec.data as { steps: unknown[] }).steps).toHaveLength(2);
		}
	});

	it("keeps L5 recent and old cards distinct", () => {
		const sourceMessages = [
			{ id: "old", role: "assistant", contentJson: [] },
			{ id: "recent", role: "assistant", contentJson: [] },
		];
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages,
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					msg: sourceMessages[0],
					tc: { toolName: "Read", status: "success" },
				},
				{
					blockIndex: 1,
					isSubagent: false,
					msg: sourceMessages[1],
					tc: { toolName: "Read", status: "success" },
				},
			],
		};
		const specs = adaptSegment(seg, { lod: 5, recentMessageIds: new Set(["recent"]) });
		expect(specs).toHaveLength(2);
		expect((specs[0]!.opts as { isRecent: boolean }).isRecent).toBe(false);
		expect((specs[1]!.opts as { isRecent: boolean }).isRecent).toBe(true);
	});

	it("preserves full-run geometry and sole-subagent default expansion", () => {
		const messages = [
			{ id: "tool-msg", role: "assistant", contentJson: [] },
			{ id: "agent-msg", role: "assistant", contentJson: [] },
		];
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: messages,
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					msg: messages[0],
					tc: { toolName: "Read", status: "success", toolUseId: "read-1" },
				},
				{
					blockIndex: 0,
					isSubagent: true,
					msg: messages[1],
					tc: { toolName: "Agent", status: "success", toolUseId: "agent-1" },
				},
			],
		};
		const specs = adaptSegment(seg, {
			lod: 5,
			recentMessageIds: new Set(["tool-msg", "agent-msg"]),
		});
		expect((specs[0]?.data as { inRun: boolean; isLast: boolean }).inRun).toBe(true);
		expect((specs[0]?.data as { isLast: boolean }).isLast).toBe(false);
		expect((specs[1]?.opts as { inRun: boolean; isLast: boolean; opened: boolean }).inRun).toBe(
			true,
		);
		expect((specs[1]?.opts as { isLast: boolean }).isLast).toBe(true);
		expect((specs[1]?.opts as { opened: boolean }).opened).toBe(true);
	});

	it("maps _streamingChars to a streaming active tool card", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					tc: { toolName: "Edit", status: "success", inputJson: { _streamingChars: 12 } },
				},
			],
		};
		for (const lod of [2, 3] as const) {
			const specs = adaptSegment(seg, { lod });
			expect(specs[0]?.kind).toBe("tool-call");
			expect((specs[0]?.data as { isStreaming: boolean }).isStreaming).toBe(true);
		}
	});

	it("preserves active-tool exemption and completed batch order", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", status: "success" } },
				{ blockIndex: 1, isSubagent: false, tc: { toolName: "Bash", status: "running" } },
				{ blockIndex: 2, isSubagent: false, tc: { toolName: "Grep", status: "success" } },
			],
		};
		const specs = adaptSegment(seg, { lod: 3 });
		expect(specs.map((spec) => spec.kind)).toEqual([
			"tool-run-summary",
			"tool-call",
			"tool-run-summary",
		]);
	});
});

describe("adaptSegments + registry integration", () => {
	it("every produced kind exists in the registry", () => {
		const segments: AdapterSegment[] = [
			{ kind: "prune-divider" },
			{
				kind: "message",
				msg: { id: "u", role: "user", contentJson: [{ type: "text", text: "hi" }] },
			},
			{
				kind: "message",
				msg: {
					id: "a",
					role: "assistant",
					contentJson: [
						{ type: "text", text: "yo" },
						{ type: "reasoning", text: "r" },
					],
				},
			},
			{
				kind: "tool-run",
				sourceMessages: [],
				items: [{ blockIndex: 0, isSubagent: false, tc: { toolName: "Bash" } }],
			},
		];
		const specs = adaptSegments(segments, CTX);
		expect(specs.length).toBeGreaterThan(0);
		for (const spec of specs) {
			expect(VLIST_REGISTRY[spec.kind]).toBeDefined();
			expect(typeof spec.key).toBe("string");
			expect(spec.key.length).toBeGreaterThan(0);
		}
	});

	it("marks unitStart on the first spec of each unit, not intra-unit blocks", () => {
		const segments: AdapterSegment[] = [
			{
				kind: "message",
				msg: { id: "u", role: "user", contentJson: [{ type: "text", text: "hi" }] },
			},
			{
				// One assistant message that yields multiple content-block specs.
				kind: "message",
				msg: {
					id: "a",
					role: "assistant",
					contentJson: [
						{ type: "text", text: "yo" },
						{ type: "web_search", query: "cats", status: "completed" },
						{ type: "image" },
					],
				},
			},
		];
		const specs = adaptSegments(segments, CTX);
		// First unit (user bubble) → unitStart. Second unit's FIRST spec →
		// unitStart; its remaining content blocks stay tight (no unitStart), so the
		// wide segment gap is applied only between the two messages.
		expect(specs.map((s) => s.unitStart === true)).toEqual([true, true, false, false]);
	});
});

describe("adaptSegment — pending permission injection", () => {
	const seg: AdapterSegment = {
		kind: "tool-run",
		sourceMessages: [],
		items: [
			{ blockIndex: 0, isSubagent: false, tc: { toolName: "Bash", toolUseId: "tu-perm" } },
			{ blockIndex: 1, isSubagent: false, tc: { toolName: "Read", toolUseId: "tu-plain" } },
		],
	};

	it("flags only the tool whose toolUseId has a pending permission", () => {
		const ctx: AdapterContext = {
			lod: 5,
			resolveHasPendingPermission: (toolUseId) => toolUseId === "tu-perm",
		};
		const specs = adaptSegment(seg, ctx);
		const permSpec = specs.find((s) => s.key === "tool-tu-perm");
		const plainSpec = specs.find((s) => s.key === "tool-tu-plain");
		expect((permSpec?.opts as { hasPendingPermission?: boolean })?.hasPendingPermission).toBe(true);
		// The non-pending card carries no hasPendingPermission opt (absent, not false).
		expect("hasPendingPermission" in (plainSpec?.opts ?? {})).toBe(false);
	});

	it("keeps a pending card out of LOD collapse (collapsesByLod false)", () => {
		const ctx: AdapterContext = {
			lod: 4, // L4 would normally collapse completed cards to headers
			resolveHasPendingPermission: (toolUseId) => toolUseId === "tu-perm",
		};
		const specs = adaptSegment(seg, ctx);
		const permSpec = specs.find((s) => s.key === "tool-tu-perm");
		expect((permSpec?.opts as { collapsesByLod?: boolean })?.collapsesByLod).toBe(false);
	});

	it("injects nothing when no resolver is provided (parity with old behaviour)", () => {
		const specs = adaptSegment(seg, { lod: 5 });
		for (const spec of specs) {
			expect("hasPendingPermission" in (spec.opts ?? {})).toBe(false);
		}
	});
});
