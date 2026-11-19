import { describe, expect, test } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api";
import { messageBody, rowWithElements } from "@shared/narrator-blocks/message-blocks";
import {
	mergeToolCallFieldsInRows,
	replaceSubagentActivitySnapshot,
	updateSubagentActivityInMessages,
	upsertSubagentToolCallHeader,
} from "./message-tree-utils";

/** A row; a body in `overrides` is split again as this row's, as the server would. */
function message(overrides: Partial<TreeMessage> = {}): TreeMessage {
	const { blocks, ...rest } = overrides;
	return rowWithElements(
		{
			id: "msg-1",
			narratorId: "narrator-1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			toolCalls: [],
			tokensIn: null,
			costUsd: null,
			createdAt: "2026-05-14T00:00:00.000Z",
			...rest,
		},
		messageBody({ blocks }),
	);
}

describe("subagent activity reducers", () => {
	test("deduplicates by stable id, falls back to toolUseId, and keeps latest three", () => {
		let activity = upsertSubagentToolCallHeader(undefined, {
			toolCallId: null,
			toolUseId: "tool-1",
			toolName: "Read",
			status: "running",
			createdAt: 1,
			timing: null,
		});
		activity = upsertSubagentToolCallHeader(activity, {
			toolCallId: "call-1",
			toolUseId: "tool-1",
			toolName: "Read",
			status: "success",
			createdAt: 1,
			timing: { completedAt: 2 },
		});
		for (let index = 2; index <= 4; index++) {
			activity = upsertSubagentToolCallHeader(activity, {
				toolCallId: `call-${index}`,
				toolUseId: `tool-${index}`,
				toolName: "Bash",
				status: "running",
				createdAt: index,
				timing: null,
			});
		}
		expect(activity.latestToolCalls.map((header) => header.toolUseId)).toEqual([
			"tool-2",
			"tool-3",
			"tool-4",
		]);
	});

	test("does not regress a terminal header to running", () => {
		const completed = upsertSubagentToolCallHeader(undefined, {
			toolCallId: "call-1",
			toolUseId: "tool-1",
			toolName: "Edit",
			status: "success",
			createdAt: 1,
			timing: { completedAt: 2 },
		});
		const regressed = upsertSubagentToolCallHeader(completed, {
			toolCallId: "call-1",
			toolUseId: "tool-1",
			toolName: "Edit",
			status: "running",
			createdAt: 1,
			timing: { startedAt: 1 },
		});
		expect(regressed.latestToolCalls[0].status).toBe("success");
		expect(regressed.latestToolCalls[0].timing?.completedAt).toBe(2);
	});

	test("sparse snapshots retain only exact-child persisted-call labels and explicit null clears", () => {
		const header = {
			toolCallId: "call-1",
			toolUseId: "grep",
			toolName: "Grep",
			status: "success",
			createdAt: 1,
			timing: { completedAt: 3, durationMs: 2 },
		};
		const previous = {
			subagentNarratorId: "child-1",
			model: null,
			latestToolCalls: [{ ...header, inputSummary: { pattern: "listen" } }],
		};
		const sparse = { ...previous, latestToolCalls: [header] };
		expect(
			replaceSubagentActivitySnapshot(sparse, previous).latestToolCalls[0].inputSummary,
		).toEqual({ pattern: "listen" });
		for (const activity of [
			{ ...sparse, subagentNarratorId: "child-2" },
			{ ...sparse, subagentNarratorId: null },
			{ ...sparse, latestToolCalls: [{ ...header, toolCallId: "retry-call" }] },
			{ ...sparse, latestToolCalls: [{ ...header, toolCallId: null }] },
			{ ...sparse, latestToolCalls: [{ ...header, toolUseId: "other-tool" }] },
		]) {
			expect(
				replaceSubagentActivitySnapshot(activity, previous).latestToolCalls[0].inputSummary,
			).toBeUndefined();
		}
		expect(
			replaceSubagentActivitySnapshot(
				{ ...sparse, latestToolCalls: [{ ...header, inputSummary: null }] },
				previous,
			).latestToolCalls[0].inputSummary,
		).toBeNull();
		expect(
			replaceSubagentActivitySnapshot(
				{ ...sparse, latestToolCalls: [{ ...header, status: "streaming", timing: null }] },
				previous,
			).latestToolCalls[0],
		).toMatchObject({ status: "success", timing: { durationMs: 2, completedAt: 3 } });
	});

	test("authoritative snapshot clear revokes a terminal label without reopening the call", () => {
		const header = {
			toolCallId: "call",
			toolUseId: "grep",
			toolName: "Grep",
			executionAttempt: 2,
			status: "success",
			createdAt: 1,
			timing: { durationMs: 2000 },
			inputSummary: { pattern: "x" },
		};
		const previous = { subagentNarratorId: "child", model: null, latestToolCalls: [header] };
		for (const inputSummary of [null, { path: "rejected" } as never]) {
			const incoming = {
				...previous,
				latestToolCalls: [{ ...header, status: "running", inputSummary }],
			};
			const cleared = replaceSubagentActivitySnapshot(incoming, previous);
			expect(cleared.latestToolCalls[0]).toMatchObject({
				status: "success",
				executionAttempt: 2,
				inputSummary: null,
				timing: { durationMs: 2000 },
			});
			const late = replaceSubagentActivitySnapshot(
				{
					...incoming,
					latestToolCalls: [{ ...header, status: "streaming", inputSummary: { pattern: "late" } }],
				},
				cleared,
			);
			expect(late.latestToolCalls[0].inputSummary).toBeNull();
			for (const executionAttempt of [undefined, 1]) {
				const stale = replaceSubagentActivitySnapshot(
					{
						...incoming,
						latestToolCalls: [
							{ ...header, executionAttempt, status: "running", inputSummary: null },
						],
					},
					previous,
				);
				expect(stale.latestToolCalls[0]).toEqual(header);
			}
		}
	});

	test("undefined summary preserves a label while null clears and terminal clear resists late chunks", () => {
		const header = {
			toolCallId: "clear-call",
			toolUseId: "grep",
			toolName: "Grep",
			executionAttempt: 1,
			status: "running",
			createdAt: 1,
			timing: null,
			inputSummary: { pattern: "listen" },
		};
		const first = upsertSubagentToolCallHeader(undefined, header);
		const sparse = upsertSubagentToolCallHeader(first, { ...header, inputSummary: undefined });
		expect(sparse.latestToolCalls[0].inputSummary).toEqual({ pattern: "listen" });
		const completed = upsertSubagentToolCallHeader(sparse, {
			...header,
			status: "success",
			inputSummary: null,
		});
		expect(completed.latestToolCalls[0].inputSummary).toBeNull();
		expect(
			upsertSubagentToolCallHeader(completed, header).latestToolCalls[0].inputSummary,
		).toBeNull();
		const omitted = upsertSubagentToolCallHeader(undefined, { ...header, inputSummary: undefined });
		const cleared = upsertSubagentToolCallHeader(omitted, { ...header, inputSummary: null });
		expect(cleared).not.toBe(omitted);
		expect(cleared.latestToolCalls[0].inputSummary).toBeNull();
	});

	test("late old calls cannot displace a newer recent window and invalid input explicitly clears", () => {
		let activity: ReturnType<typeof upsertSubagentToolCallHeader> | undefined;
		for (const createdAt of [2, 3, 4])
			activity = upsertSubagentToolCallHeader(activity, {
				toolCallId: `call-${createdAt}`,
				toolUseId: `tool-${createdAt}`,
				toolName: "Grep",
				status: "running",
				createdAt,
				timing: null,
				inputSummary: { pattern: "label" },
			});
		if (!activity) throw new Error("missing activity fixture");
		expect(
			upsertSubagentToolCallHeader(activity, {
				toolCallId: "call-1",
				toolUseId: "tool-1",
				toolName: "Grep",
				status: "success",
				createdAt: 1,
				timing: null,
			}),
		).toBe(activity);
		const cleared = upsertSubagentToolCallHeader(activity, {
			...activity.latestToolCalls[0],
			inputSummary: { path: "invalid" } as never,
		});
		expect(cleared.latestToolCalls.map((call) => call.toolUseId)).toEqual([
			"tool-2",
			"tool-3",
			"tool-4",
		]);
		expect(cleared.latestToolCalls[0].inputSummary).toBeNull();
		const snapshot = replaceSubagentActivitySnapshot(
			{
				subagentNarratorId: "child",
				model: null,
				latestToolCalls: [{ ...cleared.latestToolCalls[0], inputSummary: undefined }],
			},
			{ ...cleared, subagentNarratorId: "child" },
		);
		expect(snapshot.latestToolCalls[0].inputSummary).toBeNull();
	});

	test("repeated identical child chunks retain the activity reference", () => {
		const header = {
			toolCallId: null,
			toolUseId: "grep",
			toolName: "Grep",
			status: "streaming",
			createdAt: null,
			timing: null,
			inputSummary: { pattern: "listen" },
		};
		const first = upsertSubagentToolCallHeader(undefined, header);
		expect(upsertSubagentToolCallHeader(first, { ...header })).toBe(first);
	});

	test("does not merge known attempts or let unknown/older events change an assigned attempt", () => {
		const header = {
			toolCallId: "call",
			toolUseId: "grep",
			toolName: "Grep",
			executionAttempt: 1,
			status: "success",
			createdAt: 1,
			timing: { durationMs: 10 },
			inputSummary: { pattern: "attempt-1" },
		};
		const first = upsertSubagentToolCallHeader(undefined, header);
		const retry = upsertSubagentToolCallHeader(first, {
			...header,
			executionAttempt: 2,
			status: "running",
			timing: null,
			inputSummary: { pattern: "attempt-2" },
		});
		expect(retry.latestToolCalls).toHaveLength(1);
		expect(retry.latestToolCalls[0]).toMatchObject({
			status: "running",
			timing: null,
			executionAttempt: 2,
		});
		expect(upsertSubagentToolCallHeader(retry, header)).toBe(retry);
		const { executionAttempt: _attempt, ...unknown } = header;
		expect(upsertSubagentToolCallHeader(retry, { ...unknown, status: "streaming" })).toBe(retry);
		expect(upsertSubagentToolCallHeader(retry, unknown)).toBe(retry);
		const { inputSummary: _summary, ...sparse } = header;
		const activity = { subagentNarratorId: "child", model: null, latestToolCalls: [sparse] };
		const previous = { ...activity, latestToolCalls: [{ ...header, executionAttempt: 2 }] };
		expect(replaceSubagentActivitySnapshot(activity, previous).latestToolCalls[0]).toEqual(
			previous.latestToolCalls[0],
		);
		const { executionAttempt: _known, ...unknownSparse } = sparse;
		expect(
			replaceSubagentActivitySnapshot({ ...activity, latestToolCalls: [unknownSparse] }, previous)
				.latestToolCalls[0],
		).toEqual(previous.latestToolCalls[0]);
	});

	test("stale snapshots cannot restore a cleared attempt label or re-add calls outside the authoritative window", () => {
		const header = {
			toolCallId: "call",
			toolUseId: "grep",
			toolName: "Grep",
			executionAttempt: 2,
			status: "success",
			createdAt: 1,
			timing: { durationMs: 2000 },
			inputSummary: null,
		};
		const previous = { subagentNarratorId: "child", model: null, latestToolCalls: [header] };
		for (const executionAttempt of [undefined, 1]) {
			const result = replaceSubagentActivitySnapshot(
				{
					...previous,
					latestToolCalls: [
						{
							...header,
							executionAttempt,
							inputSummary: { pattern: "old-secret" },
							status: "streaming",
						},
					],
				},
				previous,
			);
			expect(result.latestToolCalls[0]).toMatchObject({
				executionAttempt: 2,
				status: "success",
				inputSummary: null,
				timing: { durationMs: 2000 },
			});
		}
		expect(
			replaceSubagentActivitySnapshot({ ...previous, latestToolCalls: [] }, previous)
				.latestToolCalls,
		).toEqual([]);
		const known = replaceSubagentActivitySnapshot(
			{
				...previous,
				latestToolCalls: [{ ...header, executionAttempt: 3, inputSummary: undefined }],
			},
			previous,
		);
		expect(known.latestToolCalls[0].executionAttempt).toBe(3);
		expect(known.latestToolCalls[0].inputSummary).toBeUndefined();
		const unknown = {
			...previous,
			latestToolCalls: [
				{ ...header, executionAttempt: undefined, inputSummary: { pattern: "unproven" } },
			],
		};
		expect(
			replaceSubagentActivitySnapshot(
				{ ...previous, latestToolCalls: [{ ...header, inputSummary: undefined }] },
				unknown,
			).latestToolCalls[0].inputSummary,
		).toBeUndefined();
	});

	test("does not let an empty snapshot erase known model or reasoning metadata", () => {
		const replaced = replaceSubagentActivitySnapshot(
			{
				subagentNarratorId: "sub-1",
				model: "   ",
				reasoningEffort: " ",
				latestToolCalls: [],
			},
			{
				subagentNarratorId: "sub-1",
				model: "known-model",
				reasoningEffort: "high",
				latestToolCalls: [],
			},
		);

		expect(replaced.model).toBe("known-model");
		expect(replaced.reasoningEffort).toBe("high");
	});

	test("replaces snapshots and updates the matching parent tool block", () => {
		const parent = message(
			rowWithElements(
				{
					toolCalls: [{ toolUseId: "parent-tool", toolName: "Agent" }],
				},
				[{ type: "tool_use", id: "parent-tool", name: "Agent" }],
			),
		);
		const snapshot = replaceSubagentActivitySnapshot({
			subagentNarratorId: "sub-1",
			model: "model-1",
			latestToolCalls: [
				{
					toolCallId: "call-1",
					toolUseId: "child-tool",
					toolName: "Read",
					status: "success",
					createdAt: 1,
					timing: null,
				},
			],
		});
		const result = updateSubagentActivityInMessages([parent], "parent-tool", () => snapshot);
		expect(result.changed).toBe(true);
		expect(messageBody(result.messages[0])[0]._subagentActivity).toEqual(snapshot);
		expect(result.messages[0].toolCalls[0]).toMatchObject({ _subagentActivity: snapshot });
	});
});

describe("message-tree-utils tool state parity", () => {
	test("mergeToolCallFieldsInRows syncs permission fields into enriched content blocks", () => {
		const messages = [
			message(
				rowWithElements(
					{
						toolCalls: [
							{
								toolUseId: "tool-1",
								toolName: "Edit",
								status: "permission_pending",
							},
						],
					},
					[
						{ type: "text", text: "before" },
						{
							type: "tool_use",
							id: "tool-1",
							name: "Edit",
							status: "permission_pending",
						},
					],
				),
			),
		];

		const result = mergeToolCallFieldsInRows(messages, "tool-1", {
			status: "denied",
			permissionDenyMessage: "Needs a smaller diff",
			permissionDecisionReason: "user_feedback",
		});

		expect(result.changed).toBe(true);
		expect(result.messages[0].toolCalls[0]).toMatchObject({
			status: "denied",
			permissionDenyMessage: "Needs a smaller diff",
			permissionDecisionReason: "user_feedback",
		});
		expect(messageBody(result.messages[0])[1]).toMatchObject({
			type: "tool_use",
			id: "tool-1",
			status: "denied",
			permissionDenyMessage: "Needs a smaller diff",
			permissionDecisionReason: "user_feedback",
		});
	});
});
