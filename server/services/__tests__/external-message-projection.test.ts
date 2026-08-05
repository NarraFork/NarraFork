/**
 * Tier discipline for the layered external message projection.
 *
 * These are pure-function tests: they assert what each tier is ALLOWED to emit
 * given rows that already carry everything. The route-level suite
 * (routes/__tests__/external-v1.test.ts) covers the complementary half — that the
 * query does not even read the columns a lower tier must not disclose.
 */
import { describe, expect, test } from "bun:test";
import {
	EXTERNAL_MESSAGE_MAX_REASONING_STEPS,
	EXTERNAL_MESSAGE_MAX_SUBAGENT_ITEMS,
	EXTERNAL_MESSAGE_MAX_TOOL_ITEMS,
	EXTERNAL_MESSAGE_REASONING_BODY_MAX_CHARS,
	EXTERNAL_MESSAGE_REASONING_TITLE_MAX_CHARS,
	EXTERNAL_MESSAGE_REASONING_TOTAL_MAX_CHARS,
	type ExternalMessageDetail,
	externalMessageDetailAtLeast,
	messageDetailForLod,
	stricterExternalMessageDetail,
} from "@shared/external/message-detail";
import { SUBAGENT_SUMMARY_INPUT_KEYS } from "@shared/subagent-tool-summary";
import {
	type ExternalMessageRow,
	type ExternalToolCallRow,
	partitionExternalToolRows,
	projectExternalMessage,
	projectExternalReasoning,
	projectExternalToolCallDetail,
	projectExternalTools,
	resolveExternalToolTarget,
} from "../external-message-projection";

const STRUCTURAL_TIERS: ExternalMessageDetail[] = ["skeleton", "summary", "full"];

function messageRow(overrides: Partial<ExternalMessageRow> = {}): ExternalMessageRow {
	return {
		id: "m1",
		seq: 7,
		role: "assistant",
		createdAt: "2026-07-18T00:00:00.000Z",
		textChars: 20,
		contentText: "Running diagnostics.",
		reasoningTokens: 64,
		isCompact: false,
		...overrides,
	};
}

function toolRow(overrides: Partial<ExternalToolCallRow> = {}): ExternalToolCallRow {
	return {
		messageId: "m1",
		toolUseId: "t1",
		toolName: "Bash",
		status: "success",
		durationMs: 12,
		errorMessage: null,
		inputBytes: 40,
		outputBytes: 80,
		inputSummaryJson: JSON.stringify({ command: "systemctl status robot" }),
		...overrides,
	};
}

describe("tier ordering", () => {
	test("resolves the strictest of independent ceilings", () => {
		expect(stricterExternalMessageDetail("full", "summary")).toBe("summary");
		expect(stricterExternalMessageDetail("summary", "full")).toBe("summary");
		expect(stricterExternalMessageDetail("skeleton", "full")).toBe("skeleton");
		expect(stricterExternalMessageDetail("text", "skeleton")).toBe("text");
		expect(stricterExternalMessageDetail("full", "full")).toBe("full");
	});

	test("orders disclosure monotonically", () => {
		expect(externalMessageDetailAtLeast("full", "summary")).toBe(true);
		expect(externalMessageDetailAtLeast("summary", "summary")).toBe(true);
		expect(externalMessageDetailAtLeast("skeleton", "summary")).toBe(false);
		expect(externalMessageDetailAtLeast("text", "skeleton")).toBe(false);
	});

	test("maps every render LOD onto a tier and clamps out-of-range input", () => {
		expect([1, 2, 3, 4, 5, 6].map(messageDetailForLod)).toEqual([
			"skeleton",
			"summary",
			"summary",
			"summary",
			"full",
			"full",
		]);
		// Clamping matters because the LOD comes from a third-party client, not from
		// the internal slider that is already bounded.
		expect(messageDetailForLod(0)).toBe("skeleton");
		expect(messageDetailForLod(-5)).toBe("skeleton");
		expect(messageDetailForLod(99)).toBe("full");
		expect(messageDetailForLod(4.4)).toBe("summary");
	});
});

describe("reasoning projection", () => {
	test("skeleton emits the token count and nothing derived from the text", () => {
		const reasoning = projectExternalReasoning(
			messageRow({ reasoningBlocks: ["**Title**\n\nbody"] }),
			"skeleton",
		);
		expect(reasoning).toEqual({ tokens: 64 });
	});

	test("summary emits step titles and body lengths but no bodies", () => {
		const reasoning = projectExternalReasoning(
			messageRow({ reasoningBlocks: ["**Check the logs**\n\nThe drive faulted."] }),
			"summary",
		);
		expect(reasoning.steps).toEqual([
			{ title: "Check the logs", chars: "The drive faulted.".length },
		]);
		expect(JSON.stringify(reasoning)).not.toContain("The drive faulted.");
	});

	test("full emits bodies", () => {
		const reasoning = projectExternalReasoning(
			messageRow({ reasoningBlocks: ["**Check the logs**\n\nThe drive faulted."] }),
			"full",
		);
		expect(reasoning.steps?.[0]?.body).toBe("The drive faulted.");
		expect(reasoning.steps?.[0]?.bodyTruncated).toBeUndefined();
	});

	test("parses each stored block independently", () => {
		// Concatenating first would let the trailing prose of one block merge into the
		// next block's leading step, inventing a boundary the model never emitted.
		const reasoning = projectExternalReasoning(
			messageRow({ reasoningBlocks: ["**One**\n\nfirst", "**Two**\n\nsecond"] }),
			"summary",
		);
		expect(reasoning.steps?.map((step) => step.title)).toEqual(["One", "Two"]);
	});

	test("caps a step title", () => {
		const title = "T".repeat(EXTERNAL_MESSAGE_REASONING_TITLE_MAX_CHARS + 40);
		const reasoning = projectExternalReasoning(
			messageRow({ reasoningBlocks: [`**${title}**\n\nbody`] }),
			"summary",
		);
		expect(reasoning.steps?.[0]?.title).toHaveLength(EXTERNAL_MESSAGE_REASONING_TITLE_MAX_CHARS);
	});

	test("caps one step body while reporting its true length", () => {
		const body = "b".repeat(EXTERNAL_MESSAGE_REASONING_BODY_MAX_CHARS + 100);
		const reasoning = projectExternalReasoning(
			messageRow({ reasoningBlocks: [`**T**\n\n${body}`] }),
			"full",
		);
		expect(reasoning.steps?.[0]?.chars).toBe(body.length);
		expect(reasoning.steps?.[0]?.body).toHaveLength(EXTERNAL_MESSAGE_REASONING_BODY_MAX_CHARS);
		expect(reasoning.steps?.[0]?.bodyTruncated).toBe(true);
	});

	test("caps the aggregate body budget across steps", () => {
		// Each body fits its own cap, so only the per-message budget can stop them
		// from multiplying into an unbounded response.
		const chunk = "c".repeat(EXTERNAL_MESSAGE_REASONING_BODY_MAX_CHARS);
		const stepCount = Math.ceil(EXTERNAL_MESSAGE_REASONING_TOTAL_MAX_CHARS / chunk.length) + 4;
		const blocks = Array.from({ length: stepCount }, (_, i) => `**T${i}**\n\n${chunk}`);
		const reasoning = projectExternalReasoning(messageRow({ reasoningBlocks: blocks }), "full");
		const emitted = (reasoning.steps ?? []).reduce(
			(sum, step) => sum + (step.body?.length ?? 0),
			0,
		);
		expect(emitted).toBeLessThanOrEqual(EXTERNAL_MESSAGE_REASONING_TOTAL_MAX_CHARS);
		// Steps past the budget still appear, with an empty body and the flag set, so a
		// client can tell "no content" from "content withheld".
		expect(reasoning.steps?.at(-1)?.body).toBe("");
		expect(reasoning.steps?.at(-1)?.bodyTruncated).toBe(true);
	});

	test("caps the step count and flags the cut", () => {
		const blocks = Array.from(
			{ length: EXTERNAL_MESSAGE_MAX_REASONING_STEPS + 5 },
			(_, i) => `**T${i}**\n\nbody`,
		);
		const reasoning = projectExternalReasoning(messageRow({ reasoningBlocks: blocks }), "summary");
		expect(reasoning.steps).toHaveLength(EXTERNAL_MESSAGE_MAX_REASONING_STEPS);
		expect(reasoning.stepsTruncated).toBe(true);
	});

	test("distinguishes no reasoning from unread reasoning", () => {
		const none = projectExternalReasoning(messageRow({ reasoningBlocks: [] }), "summary");
		expect(none.steps).toEqual([]);
		expect(none.unavailable).toBeUndefined();

		const unread = projectExternalReasoning(
			messageRow({ reasoningBlocks: [], reasoningUnavailable: true }),
			"summary",
		);
		expect(unread.steps).toEqual([]);
		expect(unread.unavailable).toBe(true);
	});
});

describe("tool projection", () => {
	test("counts every status exactly and never truncates the tally", () => {
		const rows = [
			toolRow({ toolUseId: "a", status: "success" }),
			toolRow({ toolUseId: "b", status: "running" }),
			toolRow({ toolUseId: "c", status: "initializing" }),
			toolRow({ toolUseId: "d", status: "fail" }),
			toolRow({ toolUseId: "e", status: "pending" }),
		];
		expect(projectExternalTools(rows, "skeleton")).toEqual({
			count: 5,
			running: 2,
			failed: 1,
			awaitingPermission: 1,
		});
	});

	test("omits item enumeration at skeleton", () => {
		const tools = projectExternalTools([toolRow()], "skeleton");
		expect(tools.items).toBeUndefined();
	});

	test("summary enumerates identity without payloads", () => {
		const tools = projectExternalTools([toolRow()], "summary");
		expect(tools.items?.[0]).toEqual({
			toolUseId: "t1",
			name: "Bash",
			target: "systemctl status robot",
			status: "success",
			durationMs: 12,
			inputBytes: 40,
			outputBytes: 80,
			hasDetail: true,
		});
	});

	test("full attaches projected payloads and truncates an oversized leaf", () => {
		const huge = "z".repeat(64 * 1024);
		const tools = projectExternalTools(
			[toolRow({ inputJson: { command: "ls" }, outputJson: { stdout: huge } })],
			"full",
		);
		const item = tools.items?.[0];
		expect(item?.input).toEqual({ command: "ls" });
		expect(item?.inputTruncated).toBeUndefined();
		expect(item?.outputTruncated).toBe(true);
		const output = item?.output as { stdout: { _truncated: boolean; fullLength: number } };
		expect(output.stdout._truncated).toBe(true);
		expect(output.stdout.fullLength).toBe(huge.length);
	});

	test("reports hasDetail false when nothing was persisted", () => {
		const tools = projectExternalTools(
			[toolRow({ inputBytes: null, outputBytes: null })],
			"summary",
		);
		expect(tools.items?.[0]?.hasDetail).toBe(false);
	});

	test("caps the enumeration and flags the cut while keeping the count exact", () => {
		const rows = Array.from({ length: EXTERNAL_MESSAGE_MAX_TOOL_ITEMS + 3 }, (_, i) =>
			toolRow({ toolUseId: `t${i}` }),
		);
		const tools = projectExternalTools(rows, "summary");
		expect(tools.count).toBe(rows.length);
		expect(tools.items).toHaveLength(EXTERNAL_MESSAGE_MAX_TOOL_ITEMS);
		expect(tools.itemsTruncated).toBe(true);
	});
});

describe("tool target resolution", () => {
	test("prefers the most specific identifying key", () => {
		expect(
			resolveExternalToolTarget(
				toolRow({
					inputSummaryJson: JSON.stringify({
						description: "run a health check",
						command: "systemctl status robot",
						file_path: "/etc/robot.conf",
					}),
				}),
			),
		).toBe("/etc/robot.conf");
		expect(
			resolveExternalToolTarget(
				toolRow({
					inputSummaryJson: JSON.stringify({
						description: "run a health check",
						command: "systemctl status robot",
					}),
				}),
			),
		).toBe("systemctl status robot");
	});

	test("covers every whitelisted key, so no projected input yields a null target", () => {
		for (const key of SUBAGENT_SUMMARY_INPUT_KEYS) {
			const target = resolveExternalToolTarget(
				toolRow({ inputSummaryJson: JSON.stringify({ [key]: `value-${key}` }) }),
			);
			expect(target).toBe(`value-${key}`);
		}
	});

	test("returns null when the projection is absent or unusable", () => {
		expect(resolveExternalToolTarget(toolRow({ inputSummaryJson: null }))).toBeNull();
		expect(resolveExternalToolTarget(toolRow({ inputSummaryJson: "{" }))).toBeNull();
		expect(resolveExternalToolTarget(toolRow({ inputSummaryJson: "{}" }))).toBeNull();
	});
});

describe("subagent partitioning", () => {
	test("separates subagent spawns from inline tool calls", () => {
		const rows = [
			toolRow({ toolUseId: "bash", toolName: "Bash" }),
			toolRow({ toolUseId: "agent", toolName: "Agent" }),
			toolRow({ toolUseId: "task", toolName: "Task" }),
			toolRow({ toolUseId: "send", toolName: "Send" }),
		];
		const { tools, subagents } = partitionExternalToolRows(rows);
		expect(tools.map((row) => row.toolUseId)).toEqual(["bash"]);
		expect(subagents.map((row) => row.toolUseId)).toEqual(["agent", "task", "send"]);
	});

	test("caps subagent enumeration while keeping the count exact", () => {
		const rows = Array.from({ length: EXTERNAL_MESSAGE_MAX_SUBAGENT_ITEMS + 2 }, (_, i) =>
			toolRow({ toolUseId: `a${i}`, toolName: "Agent" }),
		);
		const node = projectExternalMessage({ row: messageRow(), toolRows: rows, detail: "summary" });
		expect(node.subagents.count).toBe(rows.length);
		expect(node.subagents.items).toHaveLength(EXTERNAL_MESSAGE_MAX_SUBAGENT_ITEMS);
		expect(node.subagents.itemsTruncated).toBe(true);
	});
});

describe("message projection", () => {
	test("withholds prose at skeleton and emits it from summary upward", () => {
		const text = { text: "Running diagnostics.", truncated: false };
		expect(
			projectExternalMessage({ row: messageRow(), toolRows: [], detail: "skeleton", text }).text,
		).toBeUndefined();
		for (const detail of ["summary", "full"] as const) {
			expect(projectExternalMessage({ row: messageRow(), toolRows: [], detail, text }).text).toBe(
				"Running diagnostics.",
			);
		}
	});

	test("reports textChars at every tier so a client can size a control", () => {
		for (const detail of STRUCTURAL_TIERS) {
			expect(projectExternalMessage({ row: messageRow(), toolRows: [], detail }).textChars).toBe(
				20,
			);
		}
	});

	test("propagates the caller's truncation flag", () => {
		const node = projectExternalMessage({
			row: messageRow(),
			toolRows: [],
			detail: "summary",
			text: { text: "cut", truncated: true },
		});
		expect(node.textTruncated).toBe(true);
	});

	test("never emits system prose, at any tier", () => {
		// A system row is externally meaningful only as a compaction boundary; its body
		// is internal scaffolding that must not reach the same field assistant text uses.
		for (const detail of STRUCTURAL_TIERS) {
			const node = projectExternalMessage({
				row: messageRow({ role: "system", isCompact: true, contentText: "internal prose" }),
				toolRows: [],
				detail,
				text: { text: "internal prose", truncated: false },
			});
			expect(node.role).toBe("system");
			expect(node.kind).toBe("compact");
			expect(node.text).toBeUndefined();
			expect(JSON.stringify(node)).not.toContain("internal prose");
		}
	});

	test("collapses internal display roles onto system", () => {
		for (const role of ["sys", "disp", "something-new"]) {
			expect(
				projectExternalMessage({ row: messageRow({ role }), toolRows: [], detail: "summary" }).role,
			).toBe("system");
		}
	});

	test("omits usage entirely when the row recorded none", () => {
		expect(
			projectExternalMessage({ row: messageRow(), toolRows: [], detail: "summary" }).usage,
		).toBeUndefined();
		expect(
			projectExternalMessage({
				row: messageRow({ usage: { outputTokens: 12 } }),
				toolRows: [],
				detail: "summary",
			}).usage,
		).toEqual({ outputTokens: 12 });
	});
});

describe("tool drill-down projection", () => {
	test("returns both payloads with explicit truncation flags", () => {
		const detail = projectExternalToolCallDetail({
			...toolRow({ inputJson: { command: "ls" }, outputJson: { stdout: "ok" } }),
			createdAt: "2026-07-18T00:00:00.000Z",
			completedAt: "2026-07-18T00:00:01.000Z",
		});
		expect(detail).toEqual({
			toolUseId: "t1",
			name: "Bash",
			status: "success",
			target: "systemctl status robot",
			durationMs: 12,
			inputBytes: 40,
			outputBytes: 80,
			input: { command: "ls" },
			output: { stdout: "ok" },
			inputTruncated: false,
			outputTruncated: false,
			createdAt: "2026-07-18T00:00:00.000Z",
			completedAt: "2026-07-18T00:00:01.000Z",
		});
	});

	test("uses a larger budget than an inline page item", () => {
		// 8KB exceeds the inline per-leaf budget (4KB) but fits the drill-down one
		// (32KB): the endpoint exists precisely so a client can retrieve what a page
		// had to cut.
		const body = "y".repeat(8 * 1024);
		const inline = projectExternalTools(
			[toolRow({ inputJson: { command: body }, outputJson: null })],
			"full",
		);
		expect(inline.items?.[0]?.inputTruncated).toBe(true);

		const detail = projectExternalToolCallDetail({
			...toolRow({ inputJson: { command: body }, outputJson: null }),
			createdAt: "2026-07-18T00:00:00.000Z",
			completedAt: null,
		});
		expect(detail.inputTruncated).toBe(false);
		expect((detail.input as { command: string }).command).toBe(body);
	});

	test("normalizes an absent payload to null rather than omitting it", () => {
		const detail = projectExternalToolCallDetail({
			...toolRow({ inputJson: null, outputJson: null, inputBytes: null, outputBytes: null }),
			createdAt: "2026-07-18T00:00:00.000Z",
			completedAt: null,
		});
		expect(detail.input).toBeNull();
		expect(detail.output).toBeNull();
		expect(detail.inputTruncated).toBe(false);
	});
});
