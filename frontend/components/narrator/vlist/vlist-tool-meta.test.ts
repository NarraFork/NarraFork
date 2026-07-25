/** vlist-tool-meta.test.ts — unit tests for the per-row tool metadata derivation. */

import { describe, expect, it } from "bun:test";
import type { ContentBlock, NarratorMsg } from "../narrator-panel-types";
import { buildToolMetaIndex, deriveToolMeta, readSubagentIdTag } from "./vlist-tool-meta";

function toolBlock(props: Record<string, unknown>): ContentBlock {
	return { type: "tool_use", id: "tu-1", ...props } as unknown as ContentBlock;
}

function msg(contentJson: ContentBlock[], id = "m1"): NarratorMsg {
	return { id, seq: 1, role: "assistant", contentJson } as unknown as NarratorMsg;
}

describe("deriveToolMeta", () => {
	it("returns null for non tool_use blocks", () => {
		expect(deriveToolMeta({ type: "text", text: "hi" } as ContentBlock)).toBeNull();
	});

	it("carries the tool name", () => {
		expect(deriveToolMeta(toolBlock({ name: "Read" }))?.toolName).toBe("Read");
	});

	it("reads the subagent narrator id from _subagentActivity", () => {
		const meta = deriveToolMeta(
			toolBlock({ name: "Agent", _subagentActivity: { subagentNarratorId: "sub-9" } }),
		);
		expect(meta?.subagentNarratorId).toBe("sub-9");
	});

	it("omits the subagent narrator id when the activity summary lacks one", () => {
		const meta = deriveToolMeta(toolBlock({ name: "Agent", _subagentActivity: {} }));
		expect(meta?.subagentNarratorId).toBeUndefined();
	});

	// ── file-oriented tools ────────────────────────────────────────────────────

	it("exposes the file path for Read/Write/Edit and flags Read as previewable", () => {
		const read = deriveToolMeta(toolBlock({ name: "Read", input: { file_path: "/a/b.ts" } }));
		expect(read?.filePath).toBe("/a/b.ts");
		expect(read?.isReadTool).toBe(true);

		const write = deriveToolMeta(toolBlock({ name: "Write", input: { file_path: "/a/c.ts" } }));
		expect(write?.filePath).toBe("/a/c.ts");
		expect(write?.isReadTool).toBeUndefined();
	});

	it("ignores file paths for non-file tools", () => {
		const meta = deriveToolMeta(toolBlock({ name: "Bash", input: { file_path: "/a/b.ts" } }));
		expect(meta?.filePath).toBeUndefined();
	});

	it("accepts the filePath / path aliases", () => {
		expect(deriveToolMeta(toolBlock({ name: "Read", input: { path: "/p" } }))?.filePath).toBe("/p");
		expect(deriveToolMeta(toolBlock({ name: "Read", input: { filePath: "/q" } }))?.filePath).toBe(
			"/q",
		);
	});

	// ── Await({type:"agent"}) ──────────────────────────────────────────────────

	it("derives the await-agent target id from the input", () => {
		const meta = deriveToolMeta(toolBlock({ name: "Await", input: { type: "agent", id: "t-1" } }));
		expect(meta?.awaitAgentTargetId).toBe("t-1");
	});

	it("ignores await calls that are not agent waits", () => {
		const bash = deriveToolMeta(toolBlock({ name: "Await", input: { type: "bash", id: "b-1" } }));
		expect(bash?.awaitAgentTargetId).toBeUndefined();
		const task = deriveToolMeta(toolBlock({ name: "Await", input: { id: "x-1" } }));
		expect(task?.awaitAgentTargetId).toBeUndefined();
	});

	it("falls back to _metadata for the await type and target", () => {
		const meta = deriveToolMeta(
			toolBlock({
				name: "Await",
				input: {},
				output: { _metadata: { awaitType: "agent", targetId: "t-meta" } },
			}),
		);
		expect(meta?.awaitAgentTargetId).toBe("t-meta");
	});

	it("resolves the await-agent narrator id from _metadata subagentId, then resolvedId", () => {
		const bySubagent = deriveToolMeta(
			toolBlock({
				name: "Await",
				input: { type: "agent", id: "t-1" },
				output: { _metadata: { subagentId: "sub-a" } },
			}),
		);
		expect(bySubagent?.awaitAgentNarratorId).toBe("sub-a");

		const byResolved = deriveToolMeta(
			toolBlock({
				name: "Await",
				input: { type: "agent", id: "t-1" },
				output: { _metadata: { resolvedId: "sub-b" } },
			}),
		);
		expect(byResolved?.awaitAgentNarratorId).toBe("sub-b");
	});

	it("resolves the await-agent narrator id from the <subagent_id> output tag", () => {
		const meta = deriveToolMeta(
			toolBlock({
				name: "Await",
				input: { type: "agent", id: "t-1" },
				output: "done <subagent_id>sub-tag</subagent_id>",
			}),
		);
		expect(meta?.awaitAgentNarratorId).toBe("sub-tag");
	});

	it("never reports an await narrator id when the call is not an agent wait", () => {
		const meta = deriveToolMeta(
			toolBlock({
				name: "Await",
				input: { type: "bash", id: "b-1" },
				output: { _metadata: { subagentId: "sub-a" } },
			}),
		);
		expect(meta?.awaitAgentNarratorId).toBeUndefined();
	});

	// ── background / terminal state ────────────────────────────────────────────

	it("flags background subagents from either input key", () => {
		expect(
			deriveToolMeta(toolBlock({ name: "Agent", input: { background: true } }))?.isBackground,
		).toBe(true);
		expect(
			deriveToolMeta(toolBlock({ name: "Agent", input: { run_in_background: true } }))
				?.isBackground,
		).toBe(true);
		expect(deriveToolMeta(toolBlock({ name: "Agent", input: {} }))?.isBackground).toBeUndefined();
	});

	it("flags terminal statuses only", () => {
		expect(deriveToolMeta(toolBlock({ name: "Agent", status: "success" }))?.isTerminal).toBe(true);
		expect(deriveToolMeta(toolBlock({ name: "Agent", status: "cancelled" }))?.isTerminal).toBe(
			true,
		);
		expect(
			deriveToolMeta(toolBlock({ name: "Agent", status: "running" }))?.isTerminal,
		).toBeUndefined();
	});

	it("carries the result message id when present", () => {
		expect(
			deriveToolMeta(toolBlock({ name: "Agent", resultMessageId: "rm-1" }))?.resultMessageId,
		).toBe("rm-1");
	});

	it("tolerates truncated input payloads", () => {
		const meta = deriveToolMeta(
			toolBlock({ name: "Read", input: { _truncated: true, _originalLength: 9 } }),
		);
		expect(meta?.filePath).toBeUndefined();
		expect(meta?.isBackground).toBeUndefined();
	});
});

describe("readSubagentIdTag", () => {
	it("extracts the tagged id", () => {
		expect(readSubagentIdTag("a <subagent_id>x1</subagent_id> b")).toBe("x1");
	});
	it("returns undefined without a tag", () => {
		expect(readSubagentIdTag("plain text")).toBeUndefined();
	});
});

describe("buildToolMetaIndex", () => {
	it("indexes tool blocks by toolUseId across messages", () => {
		const index = buildToolMetaIndex([
			msg([toolBlock({ id: "tu-a", name: "Read", input: { file_path: "/a" } })], "m1"),
			msg(
				[
					{ type: "text", text: "hi" } as ContentBlock,
					toolBlock({ id: "tu-b", name: "Agent", _subagentActivity: { subagentNarratorId: "s1" } }),
				],
				"m2",
			),
		]);
		expect(index.size).toBe(2);
		expect(index.get("tu-a")?.filePath).toBe("/a");
		expect(index.get("tu-b")?.subagentNarratorId).toBe("s1");
	});

	it("skips blocks without an id and messages without contentJson", () => {
		const index = buildToolMetaIndex([
			msg([{ type: "tool_use", name: "Read" } as ContentBlock], "m1"),
			{ id: "m2", seq: 2, role: "assistant" } as unknown as NarratorMsg,
		]);
		expect(index.size).toBe(0);
	});
});
