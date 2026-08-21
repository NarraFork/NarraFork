/**
 * trace-row-identity.test.ts — guards the folded-trace-row identity rules.
 *
 * The load-bearing case is the reasoning RUN-START mapping: the activity fold
 * walks reasoning blocks one by one, while buildSelectionIndex registers only a
 * run's start index. If a row identified itself by its own blockIndex the
 * resulting blockId would match no selection entry and every selection action
 * would silently do nothing. Each reasoning case below therefore cross-checks the
 * produced blockId against the REAL selection index built from the same fixture.
 */

import { describe, expect, test } from "bun:test";
import type { ContentBlock, NarratorMsg } from "./narrator-panel-types";
import {
	reasoningRunIndices,
	reasoningTraceRowIdentity,
	toolTraceRowIdentity,
	traceRowAwaitAgentNarratorId,
	traceRowToolBlockId,
	traceRowToolMeta,
} from "./trace-row-identity";

// The selection index lives in vlist/, which non-vlist files may not import
// statically (vlist-isolation.guard.test.ts). A dynamic import is allowed and
// still lets us cross-validate against the REAL implementation rather than a
// hand-copied expectation.
const { buildSelectionIndex } = await import("./vlist/vlist-selection");

// biome-ignore lint/suspicious/noExplicitAny: structural test fixtures
function msg(partial: Record<string, any>): NarratorMsg {
	return { children: [], contentText: null, ...partial } as unknown as NarratorMsg;
}

const reasoning = (text: string): ContentBlock =>
	({ type: "reasoning", text }) as unknown as ContentBlock;
const thinking = (text: string): ContentBlock =>
	({ type: "thinking", thinking: text }) as unknown as ContentBlock;
const textBlock = (text: string): ContentBlock =>
	({ type: "text", text }) as unknown as ContentBlock;
const toolBlock = (id: string, name: string): ContentBlock =>
	({ type: "tool_use", id, name, input: {} }) as unknown as ContentBlock;

/** Every blockId the real selection index knows for a fixture message. */
function selectableBlockIds(message: NarratorMsg): Set<string> {
	return new Set(buildSelectionIndex([message]).byBlockId.keys());
}

const MSG_ID = "m-1";

describe("reasoningRunIndices — run-start mapping", () => {
	test("both blocks of an adjacent pair map to the run start", () => {
		const blocks = [reasoning("**A**\n\nfirst"), reasoning("**B**\n\nsecond")];
		expect(reasoningRunIndices(blocks, 0)).toEqual({ startIndex: 0, indices: [0, 1] });
		// The absorbed index must NOT identify itself as block 1.
		expect(reasoningRunIndices(blocks, 1)).toEqual({ startIndex: 0, indices: [0, 1] });
	});

	test("runs separated by a tool call keep independent starts", () => {
		const blocks = [
			reasoning("first"),
			toolBlock("tu-1", "Read"),
			reasoning("second"),
			reasoning("third"),
		];
		expect(reasoningRunIndices(blocks, 0).startIndex).toBe(0);
		expect(reasoningRunIndices(blocks, 2).startIndex).toBe(2);
		// The second run's absorbed block maps back to 2, never to 0 or 3.
		expect(reasoningRunIndices(blocks, 3)).toEqual({ startIndex: 2, indices: [2, 3] });
	});

	test("adjacent reasoning and thinking blocks form one run", () => {
		const blocks = [thinking("hmm"), reasoning("ok"), thinking("more")];
		expect(reasoningRunIndices(blocks, 2)).toEqual({ startIndex: 0, indices: [0, 1, 2] });
	});

	test("falls back to the block itself when it is in no run", () => {
		expect(reasoningRunIndices([textBlock("hi")], 0)).toEqual({ startIndex: 0, indices: [0] });
		expect(reasoningRunIndices(undefined, 4)).toEqual({ startIndex: 4, indices: [4] });
	});
});

describe("reasoningTraceRowIdentity — cross-validated against buildSelectionIndex", () => {
	test("adjacent reasoning blocks both resolve to a blockId the selection index knows", () => {
		const blocks = [reasoning("**A**\n\nfirst"), reasoning("**B**\n\nsecond")];
		const message = msg({ id: MSG_ID, role: "assistant", seq: 1, contentJson: blocks });
		const known = selectableBlockIds(message);

		const first = reasoningTraceRowIdentity(MSG_ID, blocks, 0);
		const second = reasoningTraceRowIdentity(MSG_ID, blocks, 1);

		// Both rows share the run's identity …
		expect(first.blockId).toBe(`msg-${MSG_ID}-0`);
		expect(second.blockId).toBe(first.blockId);
		expect(second.blockIndex).toBe(0);
		expect(second.blockIndices).toEqual([0, 1]);
		// … and that identity is one the selection system actually registered.
		expect(known.has(first.blockId)).toBe(true);
		expect(known.has(second.blockId)).toBe(true);
		// Regression sentinel: the naive per-block id does NOT exist.
		expect(known.has(`msg-${MSG_ID}-1`)).toBe(false);
	});

	test("a second run after a tool call resolves to its own registered blockId", () => {
		const blocks = [
			reasoning("first"),
			toolBlock("tu-1", "Read"),
			reasoning("second"),
			reasoning("third"),
		];
		const message = msg({ id: MSG_ID, role: "assistant", seq: 1, contentJson: blocks });
		const known = selectableBlockIds(message);

		for (const blockIndex of [2, 3]) {
			const identity = reasoningTraceRowIdentity(MSG_ID, blocks, blockIndex);
			expect(identity.blockId).toBe(`msg-${MSG_ID}-2`);
			expect(identity.blockIndices).toEqual([2, 3]);
			expect(known.has(identity.blockId)).toBe(true);
		}
		expect(known.has(`msg-${MSG_ID}-3`)).toBe(false);
	});

	test("keeps copyText only when it has content", () => {
		const blocks = [reasoning("body")];
		expect(reasoningTraceRowIdentity(MSG_ID, blocks, 0, "  ").copyText).toBeUndefined();
		expect(reasoningTraceRowIdentity(MSG_ID, blocks, 0, "body").copyText).toBe("body");
	});
});

describe("tool row identity", () => {
	test("encodes tc-/sa- prefixes the selection index registers", () => {
		const blocks = [toolBlock("tu-9", "Read")];
		const message = msg({ id: MSG_ID, role: "assistant", seq: 1, contentJson: blocks });
		const known = selectableBlockIds(message);

		const identity = toolTraceRowIdentity(
			MSG_ID,
			0,
			{ toolName: "Read", toolUseId: "tu-9" },
			false,
		);
		expect(identity?.blockId).toBe("tc-tu-9");
		expect(known.has("tc-tu-9")).toBe(true);

		const subagent = toolTraceRowIdentity(
			MSG_ID,
			0,
			{ toolName: "Agent", toolUseId: "tu-9" },
			true,
		);
		expect(subagent?.blockId).toBe("sa-tu-9");
		// buildSelectionIndex registers both aliases for a tool entry.
		expect(known.has("sa-tu-9")).toBe(true);
	});

	test("returns null without a toolUseId (no selection entry exists)", () => {
		expect(traceRowToolBlockId({ toolName: "Read" }, false)).toBeNull();
		expect(toolTraceRowIdentity(MSG_ID, 0, { toolName: "Read" }, false)).toBeNull();
	});
});

describe("traceRowToolMeta — subagent lifecycle facts", () => {
	test("reads the child narrator id from the embedded activity summary", () => {
		const meta = traceRowToolMeta({
			toolName: "Agent",
			toolUseId: "tu-1",
			_subagentActivity: { subagentNarratorId: "sub-3" },
		});
		expect(meta.subagentNarratorId).toBe("sub-3");
	});

	test("omits the child id when the activity summary has not resolved one", () => {
		expect(
			traceRowToolMeta({ toolName: "Agent", toolUseId: "tu-1", _subagentActivity: {} })
				.subagentNarratorId,
		).toBeUndefined();
		expect(
			traceRowToolMeta({ toolName: "Agent", toolUseId: "tu-1" }).subagentNarratorId,
		).toBeUndefined();
		// A blank id is not a usable target.
		expect(
			traceRowToolMeta({
				toolName: "Agent",
				toolUseId: "tu-1",
				_subagentActivity: { subagentNarratorId: "  " },
			}).subagentNarratorId,
		).toBeUndefined();
	});

	test("flags background mode from either input key", () => {
		expect(
			traceRowToolMeta({ toolName: "Agent", toolUseId: "t", inputJson: { background: true } })
				.isBackground,
		).toBe(true);
		expect(
			traceRowToolMeta({
				toolName: "Agent",
				toolUseId: "t",
				inputJson: { run_in_background: true },
			}).isBackground,
		).toBe(true);
		expect(
			traceRowToolMeta({ toolName: "Agent", toolUseId: "t", inputJson: {} }).isBackground,
		).toBeUndefined();
	});

	test("flags terminal statuses so detach/cancel can hide", () => {
		for (const status of ["success", "error", "cancelled", "timeout", "failed"]) {
			expect(traceRowToolMeta({ toolName: "Agent", toolUseId: "t", status }).isTerminal).toBe(true);
		}
		for (const status of ["running", "pending", "initializing", undefined]) {
			expect(traceRowToolMeta({ toolName: "Agent", toolUseId: "t", status }).isTerminal).toBe(
				undefined,
			);
		}
	});

	test("carries the result message id when present", () => {
		expect(
			traceRowToolMeta({ toolName: "Agent", toolUseId: "t", resultMessageId: "m-9" })
				.resultMessageId,
		).toBe("m-9");
		expect(
			traceRowToolMeta({ toolName: "Agent", toolUseId: "t", resultMessageId: null })
				.resultMessageId,
		).toBeUndefined();
	});
});

describe("traceRowToolMeta", () => {
	test("exposes file paths for Read/Write/Edit and flags Read as previewable", () => {
		const read = traceRowToolMeta({
			toolName: "Read",
			toolUseId: "t1",
			inputJson: { file_path: "/a/b.ts" },
		});
		expect(read.filePath).toBe("/a/b.ts");
		expect(read.isReadTool).toBe(true);

		const write = traceRowToolMeta({
			toolName: "Write",
			toolUseId: "t2",
			inputJson: { file_path: "/a/c.ts" },
		});
		expect(write.filePath).toBe("/a/c.ts");
		expect(write.isReadTool).toBeUndefined();
	});

	test("ignores file paths on non-file tools", () => {
		const meta = traceRowToolMeta({
			toolName: "Bash",
			toolUseId: "t3",
			inputJson: { file_path: "/a/b.ts" },
		});
		expect(meta.filePath).toBeUndefined();
	});

	test("accepts the alternate file-path keys", () => {
		expect(traceRowToolMeta({ toolName: "Read", inputJson: { path: "/p" } }).filePath).toBe("/p");
		expect(traceRowToolMeta({ toolName: "Read", inputJson: { filePath: "/q" } }).filePath).toBe(
			"/q",
		);
	});
});

describe("traceRowAwaitAgentNarratorId — embedded metadata only", () => {
	test("reads the resolved id from embedded metadata", () => {
		expect(
			traceRowAwaitAgentNarratorId({
				toolName: "Await",
				inputJson: { type: "agent", id: "alias-1" },
				outputJson: { _metadata: { subagentId: "sub-7" } },
			}),
		).toBe("sub-7");

		expect(
			traceRowAwaitAgentNarratorId({
				toolName: "Await",
				inputJson: { type: "agent", id: "alias-1" },
				outputJson: { _metadata: { resolvedId: "sub-8" } },
			}),
		).toBe("sub-8");
	});

	test("reads the subagent id tag from the output text", () => {
		expect(
			traceRowAwaitAgentNarratorId({
				toolName: "Await",
				inputJson: { type: "agent", id: "alias-1" },
				outputJson: "done <subagent_id>sub-9</subagent_id>",
			}),
		).toBe("sub-9");
	});

	test("returns undefined for non-agent awaits, other tools, and unresolved targets", () => {
		expect(
			traceRowAwaitAgentNarratorId({
				toolName: "Await",
				inputJson: { type: "bash", id: "b-1" },
				outputJson: { _metadata: { subagentId: "sub-1" } },
			}),
		).toBeUndefined();
		expect(
			traceRowAwaitAgentNarratorId({ toolName: "Agent", outputJson: { _metadata: {} } }),
		).toBeUndefined();
		// Agent-type await with no target id → nothing to open.
		expect(
			traceRowAwaitAgentNarratorId({ toolName: "Await", inputJson: { type: "agent" } }),
		).toBeUndefined();
	});

	test("returns undefined when the id is not embedded (no network fallback)", () => {
		// ToolCallCard would fall back to resolveBackgroundTaskTarget here; folded
		// rows must not, so the menu item is simply hidden.
		expect(
			traceRowToolMeta({
				toolName: "Await",
				toolUseId: "t1",
				inputJson: { type: "agent", id: "alias-1" },
				outputJson: { _metadata: {} },
			}).awaitAgentNarratorId,
		).toBeUndefined();
	});

	/**
	 * The server-derived field keeps this path within its performance invariant: it
	 * arrives EMBEDDED on the row, so a running Await gains its "open session" item
	 * without the per-row query the invariant forbids.
	 */
	test("uses the server-derived id while the wait is still running", () => {
		expect(
			traceRowToolMeta({
				toolName: "Await",
				toolUseId: "t1",
				inputJson: { type: "agent", id: "paper-extract" },
				status: "running",
				_awaitAgentNarratorId: "sub-live",
			}).awaitAgentNarratorId,
		).toBe("sub-live");
	});

	test("prefers embedded metadata and the output tag over the server-derived id", () => {
		expect(
			traceRowAwaitAgentNarratorId({
				toolName: "Await",
				inputJson: { type: "agent", id: "t-1" },
				outputJson: { _metadata: { subagentId: "sub-authoritative" } },
				_awaitAgentNarratorId: "sub-derived",
			}),
		).toBe("sub-authoritative");
		expect(
			traceRowAwaitAgentNarratorId({
				toolName: "Await",
				inputJson: { type: "agent", id: "t-1" },
				outputJson: "ok <subagent_id>sub-tag</subagent_id>",
				_awaitAgentNarratorId: "sub-derived",
			}),
		).toBe("sub-tag");
	});

	test("ignores the server-derived id for a bash await", () => {
		expect(
			traceRowAwaitAgentNarratorId({
				toolName: "Await",
				inputJson: { type: "bash", id: "b-1" },
				_awaitAgentNarratorId: "sub-live",
			}),
		).toBeUndefined();
	});
});
