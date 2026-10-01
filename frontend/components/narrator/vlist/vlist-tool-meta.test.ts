/** vlist-tool-meta.test.ts — unit tests for the per-row tool metadata derivation. */

import { describe, expect, it } from "bun:test";
import type { ContentBlock, NarratorMsg } from "../narrator-panel-types";
import { buildToolMetaIndex, deriveToolMeta, readSubagentIdTag } from "./vlist-tool-meta";

function toolBlock(props: Record<string, unknown>): ContentBlock {
	return { type: "tool_use", id: "tu-1", ...props } as unknown as ContentBlock;
}

function msg(contentJson: ContentBlock[], id = "m1", seq = 1): NarratorMsg {
	return { id, seq, role: "assistant", contentJson } as unknown as NarratorMsg;
}

describe("foreground Bash detachment", () => {
	it("uses the exact tool id and only executing/running foreground commands", () => {
		for (const status of [
			"executing",
			"running",
			"pending",
			"permission",
			"success",
			"fail",
			"cancelled",
			undefined,
		]) {
			const meta = deriveToolMeta(
				toolBlock({ name: "Bash", status, input: { command: "bun run build" } }),
			);
			expect(meta?.toolUseId).toBe("tu-1");
			expect(!!meta?.isRunningBash).toBe(status === "executing" || status === "running");
		}
		for (const input of [
			{},
			{ command: " " },
			{ stop: "task" },
			{ command: "build", stop: "task" },
			{ command: "build", run_in_background: true },
			{ command: "build", background: true },
		]) {
			expect(
				deriveToolMeta(toolBlock({ name: "Bash", status: "running", input }))?.isRunningBash,
			).toBeUndefined();
		}
		for (const name of ["Agent", "Send", "Await", "Execute"]) {
			expect(
				deriveToolMeta(toolBlock({ name, status: "running", input: { command: "build" } }))
					?.isRunningBash,
			).toBeUndefined();
		}
		expect(
			deriveToolMeta(
				toolBlock({
					name: "Bash",
					status: "running",
					input: { command: "build" },
					output: { _metadata: { background_task_id: "task", detached: true } },
				}),
			)?.isRunningBash,
		).toBeUndefined();
	});
});

describe("active question waits", () => {
	it("exposes only running question waits, not completed or other waits", () => {
		for (const status of ["running", "success", "fail", "cancelled", "pending", undefined]) {
			const meta = deriveToolMeta(
				toolBlock({ name: "Await", status, input: { type: "question", id: "q1" } }),
			);
			expect(meta?.awaitQuestionId).toBe(status === "running" ? "q1" : undefined);
		}
		expect(
			deriveToolMeta(
				toolBlock({ name: "Await", status: "running", input: { type: "bash", id: "q1" } }),
			)?.awaitQuestionId,
		).toBeUndefined();
	});

	it("carries the owning message seq so concurrent waits can pick the newest", () => {
		expect(
			deriveToolMeta(
				toolBlock({
					name: "Await",
					status: "running",
					seq: 7,
					input: { type: "question", id: "q1" },
				}),
			),
		).toMatchObject({ awaitQuestionId: "q1", awaitQuestionSeq: 7 });
		expect(
			buildToolMetaIndex([
				msg(
					[
						toolBlock({
							id: "wait-old",
							name: "Await",
							status: "running",
							input: { type: "question", id: "q1" },
						}),
					],
					"m-old",
					3,
				),
				msg(
					[
						toolBlock({
							id: "wait-new",
							name: "Await",
							status: "running",
							input: { type: "question", id: "q1" },
						}),
					],
					"m-new",
					11,
				),
			]).get("wait-new"),
		).toMatchObject({ awaitQuestionId: "q1", awaitQuestionSeq: 11 });
	});
});

describe("running Send navigation", () => {
	it("reads the live resolution without output or lifecycle mutation", () => {
		const block = toolBlock({
			name: "Send",
			input: { name: "worker", await: true },
			status: "running",
			_awaitAgentNarratorId: "sub-live",
		});
		expect(deriveToolMeta(block)?.sendTargetNarratorId).toBe("sub-live");
		expect(block).not.toHaveProperty("outputJson");
	});
	it("never overrides returned targets or guesses parent and multiple inputs", () => {
		for (const input of [{ id: "parent" }, { ids: ["a", "b"] }, { id: "a", name: "b" }]) {
			expect(
				deriveToolMeta(toolBlock({ name: "Send", input, _awaitAgentNarratorId: "sub-live" }))
					?.sendTargetNarratorId,
			).toBeUndefined();
		}
		for (const targets of [
			[],
			[{ id: "a" }, { id: "b" }],
			[{ id: "real-parent", label: "parent" }],
		]) {
			expect(
				deriveToolMeta(
					toolBlock({
						name: "Send",
						input: { id: "a" },
						_metadata: { targets },
						_awaitAgentNarratorId: "sub-live",
					}),
				)?.sendTargetNarratorId,
			).toBeUndefined();
		}
	});
});

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

	/**
	 * The regression this whole channel exists for: a RUNNING Await has no output, so
	 * neither `_metadata.subagentId` nor the `<subagent_id>` tag exists and the row's
	 * "open session" item stayed hidden for the entire wait. The server resolves the
	 * selector and ships `_awaitAgentNarratorId`; without reading it here the fix is
	 * invisible on the vlist path.
	 */
	it("resolves the await narrator id from the server field while the wait is running", () => {
		const meta = deriveToolMeta(
			toolBlock({
				name: "Await",
				input: { type: "agent", id: "paper-extract" },
				status: "running",
				_awaitAgentNarratorId: "sub-live",
			}),
		);
		expect(meta?.awaitAgentNarratorId).toBe("sub-live");
	});

	it("prefers the tool's own returned metadata over the server-derived field", () => {
		const meta = deriveToolMeta(
			toolBlock({
				name: "Await",
				input: { type: "agent", id: "t-1" },
				output: { _metadata: { subagentId: "sub-authoritative" } },
				_awaitAgentNarratorId: "sub-derived",
			}),
		);
		expect(meta?.awaitAgentNarratorId).toBe("sub-authoritative");
	});

	it("prefers the output tag over the server-derived field", () => {
		const meta = deriveToolMeta(
			toolBlock({
				name: "Await",
				input: { type: "agent", id: "t-1" },
				output: "done <subagent_id>sub-tag</subagent_id>",
				_awaitAgentNarratorId: "sub-derived",
			}),
		);
		expect(meta?.awaitAgentNarratorId).toBe("sub-tag");
	});

	it("ignores the server-derived field for a non-agent await", () => {
		const meta = deriveToolMeta(
			toolBlock({
				name: "Await",
				input: { type: "bash", id: "b-1" },
				_awaitAgentNarratorId: "sub-live",
			}),
		);
		expect(meta?.awaitAgentNarratorId).toBeUndefined();
	});

	// ── Send ───────────────────────────────────────────────────────────────────
	//
	// The regression these cover: a Send creates no child messages, so the
	// `_subagentActivity` join every other subagent card relies on is EMPTY for it
	// (628 of 649 Send calls in a real database). The real narrator id lives only
	// in `metadata.targets[]`, which no render path used to read — so "view
	// session" was hidden on essentially every Send card.
	//
	// Payload shapes below are copied from real rows, not invented.

	it("resolves the Send addressee from a single sibling target", () => {
		const meta = deriveToolMeta(
			toolBlock({
				name: "Send",
				input: { id: "verify-unstable", message: "done" },
				output: {
					_text: "Sent to verify-unstable; message queued.",
					_metadata: {
						kind: "send",
						targets: [
							{
								id: "SOuKPDwfvhldnXwHuZ6rN",
								title: "Verify unstable candidates",
								status: "queued",
								label: "verify-unstable",
								awaited: false,
							},
						],
					},
				},
			}),
		);
		expect(meta?.sendTargetNarratorId).toBe("SOuKPDwfvhldnXwHuZ6rN");
	});

	/**
	 * ⚠️ A report to the PARENT is excluded even though its `id` is a real narrator
	 * id: `tryRouteToParent` puts the parent's nanoid in `id` and the selector the
	 * model typed in `label`.
	 *
	 * The affordance this feeds opens a SUBAGENT session panel, which titles an
	 * untitled narrator "Subagent" and files it under subagent recent tabs. Aiming it
	 * at a primary narrator misrepresents what the reader is looking at, and nothing
	 * anywhere would report the mismatch.
	 */
	it("stays silent for a parent report, whose label is the reserved selector", () => {
		const meta = deriveToolMeta(
			toolBlock({
				name: "Send",
				input: { id: "parent", message: "done" },
				output: {
					_text: "Reported to the parent narrator; it will see the report on its next turn.",
					_metadata: {
						kind: "send",
						targets: [
							{
								id: "SOuKPDwfvhldnXwHuZ6rN",
								title: "未提交修改的代码审查",
								status: "queued",
								label: "parent",
								awaited: false,
							},
						],
					},
				},
			}),
		);
		expect(meta?.sendTargetNarratorId).toBeUndefined();
	});

	it("excludes every parent selector spelling, however it is cased or padded", () => {
		for (const label of ["parent", "main", "@parent", "@main", "PARENT", " parent "]) {
			const meta = deriveToolMeta(
				toolBlock({
					name: "Send",
					output: { _metadata: { targets: [{ id: "SOuKPDwfvhldnXwHuZ6rN", label }] } },
				}),
			);
			expect(meta?.sendTargetNarratorId).toBeUndefined();
		}
	});

	/**
	 * A fan-out Send addresses several sessions and one menu item cannot say
	 * which. Same rule as an ambiguous Await selector: resolve to nothing rather
	 * than navigate somewhere the reader did not ask for.
	 */
	it("stays silent for a fan-out Send", () => {
		const meta = deriveToolMeta(
			toolBlock({
				name: "Send",
				output: { _metadata: { targets: [{ id: "sub-a" }, { id: "sub-b" }] } },
			}),
		);
		expect(meta?.sendTargetNarratorId).toBeUndefined();
	});

	/**
	 * The mixed parent/sibling rejection path echoes the RAW selectors back
	 * instead of resolved ids — the one shape whose `id` is not a narrator id.
	 * It always has ≥2 targets, but the reserved-selector guard is asserted
	 * directly so a future single-target rejection cannot slip through.
	 */
	it("rejects a reserved selector sitting in the id field", () => {
		for (const reserved of ["parent", "main", "@parent", "@main", "PARENT"]) {
			const meta = deriveToolMeta(
				toolBlock({
					name: "Send",
					output: { _metadata: { targets: [{ id: reserved, status: "failed" }] } },
				}),
			);
			expect(meta?.sendTargetNarratorId).toBeUndefined();
		}
	});

	it("stays silent when a Send carries no targets", () => {
		expect(
			deriveToolMeta(toolBlock({ name: "Send", output: { _text: "Send error: ..." } }))
				?.sendTargetNarratorId,
		).toBeUndefined();
		expect(deriveToolMeta(toolBlock({ name: "Send" }))?.sendTargetNarratorId).toBeUndefined();
	});

	it("does not read targets for other tools", () => {
		const meta = deriveToolMeta(
			toolBlock({ name: "Bash", output: { _metadata: { targets: [{ id: "sub-a" }] } } }),
		);
		expect(meta?.sendTargetNarratorId).toBeUndefined();
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
