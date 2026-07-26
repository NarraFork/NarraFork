import { describe, expect, it } from "bun:test";
import type { NarratorMsg, PendingPermission } from "../narrator-panel-types";
import {
	buildReflectionSourceIndex,
	reflectionToolCallData,
	resolveRowReflection,
	type VListReflectionSource,
} from "./vlist-reflection-index";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

type ToolBlockOverrides = {
	id: string;
	name?: string;
	tcId?: string;
	status?: string;
	errorMessage?: string;
	permissionDecisionReason?: string;
	permissionSuggestions?: unknown[] | null;
};

function toolBlock(overrides: ToolBlockOverrides) {
	return { type: "tool_use", name: "Bash", ...overrides };
}

function msg(overrides: Partial<NarratorMsg> & { id: string }): NarratorMsg {
	return {
		role: "assistant",
		contentJson: [],
		contentText: null,
		toolCalls: [],
		children: [],
		narratorId: "n1",
		parentToolUseId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as unknown as NarratorMsg;
}

function suggestion(type: string, status: string, extra: Record<string, unknown> = {}) {
	return { type, status, requestId: `req-${type}`, ...extra };
}

const perm = (overrides: Partial<PendingPermission> = {}): PendingPermission => ({
	id: "req-1",
	toolName: "Bash",
	inputJson: {},
	...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// buildReflectionSourceIndex
// ─────────────────────────────────────────────────────────────────────────────

describe("buildReflectionSourceIndex", () => {
	it("indexes a reflection carried on an enriched tool_use block", () => {
		const index = buildReflectionSourceIndex([
			msg({
				id: "m1",
				contentJson: [
					toolBlock({
						id: "tu-1",
						tcId: "tc-1",
						status: "success",
						permissionDecisionReason: "approved by gate",
						permissionSuggestions: [suggestion("danger_reflection", "confirmed")],
					}),
				],
			}) as NarratorMsg,
		]);
		expect(index.size).toBe(1);
		const source = index.get("tu-1");
		expect(source?.toolCallId).toBe("tc-1");
		expect(source?.toolName).toBe("Bash");
		expect(source?.status).toBe("success");
		expect(source?.permissionDecisionReason).toBe("approved by gate");
		expect(source?.suggestions).toHaveLength(1);
	});

	it("falls back to the toolCalls row for a non-enriched block", () => {
		const index = buildReflectionSourceIndex([
			msg({
				id: "m1",
				contentJson: [toolBlock({ id: "tu-1" })],
				toolCalls: [
					{
						id: "tc-1",
						toolUseId: "tu-1",
						toolName: "Write",
						status: "fail",
						errorMessage: "boom",
						permissionSuggestions: [suggestion("plan_reflection", "running")],
					},
				],
			}) as NarratorMsg,
		]);
		const source = index.get("tu-1");
		expect(source?.toolCallId).toBe("tc-1");
		expect(source?.status).toBe("fail");
		expect(source?.errorMessage).toBe("boom");
		expect(source?.suggestions).toHaveLength(1);
	});

	it("indexes a reflection row that has no matching content block", () => {
		const index = buildReflectionSourceIndex([
			msg({
				id: "m1",
				contentJson: [],
				toolCalls: [
					{
						id: "tc-9",
						toolUseId: "tu-9",
						toolName: "ExitPlanMode",
						status: "pending",
						permissionSuggestions: [suggestion("plan_reflection", "awaiting_user")],
					},
				],
			}) as NarratorMsg,
		]);
		expect(index.get("tu-9")?.toolName).toBe("ExitPlanMode");
	});

	it("omits tool calls that carry no reflection suggestion", () => {
		const index = buildReflectionSourceIndex([
			msg({
				id: "m1",
				contentJson: [
					toolBlock({ id: "tu-1", status: "success" }),
					toolBlock({
						id: "tu-2",
						status: "pending",
						// A plain permission suggestion is not a reflection.
						permissionSuggestions: [{ type: "permission", status: "awaiting_user" }],
					}),
				],
			}) as NarratorMsg,
		]);
		expect(index.size).toBe(0);
	});

	it("walks child messages (subagent tool calls)", () => {
		const index = buildReflectionSourceIndex([
			msg({
				id: "m1",
				contentJson: [toolBlock({ id: "tu-parent", name: "Agent" })],
				children: [
					msg({
						id: "m1c",
						parentToolUseId: "tu-parent",
						contentJson: [
							toolBlock({
								id: "tu-child",
								status: "success",
								permissionSuggestions: [suggestion("task_reflection", "confirmed")],
							}),
						],
					}) as NarratorMsg,
				],
			}) as NarratorMsg,
		]);
		expect(index.get("tu-child")?.suggestions).toHaveLength(1);
	});

	it("keeps the newest occurrence of a reused tool use id", () => {
		const index = buildReflectionSourceIndex([
			msg({
				id: "m1",
				contentJson: [
					toolBlock({
						id: "tu-dup",
						tcId: "tc-old",
						permissionSuggestions: [suggestion("danger_reflection", "cancelled")],
					}),
				],
			}) as NarratorMsg,
			msg({
				id: "m2",
				contentJson: [
					toolBlock({
						id: "tu-dup",
						tcId: "tc-new",
						permissionSuggestions: [suggestion("danger_reflection", "confirmed")],
					}),
				],
			}) as NarratorMsg,
		]);
		expect(index.get("tu-dup")?.toolCallId).toBe("tc-new");
		expect(resolveRowReflection(index.get("tu-dup"), null)?.status).toBe("confirmed");
	});

	it("a newer reflection-less occurrence clears the older entry", () => {
		const index = buildReflectionSourceIndex([
			msg({
				id: "m1",
				contentJson: [
					toolBlock({
						id: "tu-dup",
						permissionSuggestions: [suggestion("danger_reflection", "confirmed")],
					}),
				],
			}) as NarratorMsg,
			msg({
				id: "m2",
				contentJson: [toolBlock({ id: "tu-dup", status: "success" })],
			}) as NarratorMsg,
		]);
		expect(index.has("tu-dup")).toBe(false);
	});

	it("child occurrences override their parent message rows", () => {
		const index = buildReflectionSourceIndex([
			msg({
				id: "m1",
				contentJson: [
					toolBlock({
						id: "tu-1",
						tcId: "tc-parent",
						permissionSuggestions: [suggestion("danger_reflection", "running")],
					}),
				],
				children: [
					msg({
						id: "m1c",
						contentJson: [
							toolBlock({
								id: "tu-1",
								tcId: "tc-child",
								permissionSuggestions: [suggestion("danger_reflection", "confirmed")],
							}),
						],
					}) as NarratorMsg,
				],
			}) as NarratorMsg,
		]);
		expect(index.get("tu-1")?.toolCallId).toBe("tc-child");
	});

	it("tolerates empty / malformed input", () => {
		expect(buildReflectionSourceIndex([]).size).toBe(0);
		expect(buildReflectionSourceIndex(undefined as unknown as NarratorMsg[]).size).toBe(0);
		expect(
			buildReflectionSourceIndex([
				msg({ id: "m1", contentJson: null as unknown as [] }) as NarratorMsg,
			]).size,
		).toBe(0);
		// A tool_use block without an id cannot be keyed.
		expect(
			buildReflectionSourceIndex([
				msg({
					id: "m1",
					contentJson: [
						{
							type: "tool_use",
							name: "Bash",
							permissionSuggestions: [suggestion("danger_reflection", "confirmed")],
						},
					] as unknown as [],
				}) as NarratorMsg,
			]).size,
		).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveRowReflection
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveRowReflection", () => {
	const KINDS = [
		"danger_reflection",
		"plan_reflection",
		"question_reflection",
		"task_reflection",
	] as const;
	const STATUSES = ["running", "awaiting_user", "confirmed", "cancelled", "aborted"] as const;

	it("resolves every reflection kind × status from the persisted suggestions", () => {
		for (const kind of KINDS) {
			for (const status of STATUSES) {
				const source: VListReflectionSource = {
					toolName: "Bash",
					status: "success",
					suggestions: [suggestion(kind, status, { reason: `${kind}:${status}` })],
				};
				const resolved = resolveRowReflection(source, null);
				expect(resolved?.kind).toBe(kind);
				expect(resolved?.status).toBe(status);
				expect(resolved?.reason).toBe(`${kind}:${status}`);
			}
		}
	});

	it("returns null with no source and no pending permission", () => {
		expect(resolveRowReflection(undefined, null)).toBeNull();
		expect(resolveRowReflection({ toolName: "Bash", suggestions: null }, null)).toBeNull();
	});

	it("ignores non-reflection suggestions", () => {
		const source: VListReflectionSource = {
			toolName: "Bash",
			suggestions: [{ type: "permission", status: "awaiting_user" }],
		};
		expect(resolveRowReflection(source, null)).toBeNull();
	});

	it("prefers the live permission's suggestions over the persisted ones", () => {
		const source: VListReflectionSource = {
			toolName: "Bash",
			suggestions: [suggestion("danger_reflection", "confirmed", { reason: "stale" })],
		};
		const pending = perm({
			suggestions: [suggestion("danger_reflection", "awaiting_user", { reason: "live" })],
		});
		const resolved = resolveRowReflection(source, pending);
		expect(resolved?.status).toBe("awaiting_user");
		expect(resolved?.reason).toBe("live");
	});

	it("maps legacy allow/deny suggestion statuses", () => {
		expect(
			resolveRowReflection(
				{ toolName: "Bash", suggestions: [suggestion("plan_reflection", "allow")] },
				null,
			)?.status,
		).toBe("confirmed");
		expect(
			resolveRowReflection(
				{ toolName: "Bash", suggestions: [suggestion("plan_reflection", "deny")] },
				null,
			)?.status,
		).toBe("cancelled");
	});

	it("downgrades an active reflection on a failed tool call to aborted with the error text", () => {
		const source: VListReflectionSource = {
			toolName: "Bash",
			status: "fail",
			errorMessage: "Narrator aborted",
			suggestions: [suggestion("danger_reflection", "running")],
		};
		const resolved = resolveRowReflection(source, null);
		expect(resolved?.status).toBe("aborted");
		expect(resolved?.reason).toBe("Narrator aborted");
	});

	it("uses the decision reason when a failed call has no error message", () => {
		const source: VListReflectionSource = {
			toolName: "Bash",
			status: "fail",
			permissionDecisionReason: "Danger reflection aborted",
			suggestions: [suggestion("task_reflection", "awaiting_user")],
		};
		expect(resolveRowReflection(source, null)?.reason).toBe("Danger reflection aborted");
	});

	it("keeps an active reflection intact while a permission is still pending", () => {
		const source: VListReflectionSource = {
			toolName: "Bash",
			status: "fail",
			errorMessage: "boom",
			suggestions: [suggestion("danger_reflection", "running")],
		};
		expect(resolveRowReflection(source, perm())?.status).toBe("running");
	});

	it("leaves a resolved reflection untouched on a failed tool call", () => {
		const source: VListReflectionSource = {
			toolName: "Bash",
			status: "fail",
			errorMessage: "boom",
			suggestions: [suggestion("danger_reflection", "cancelled", { reason: "user denied" })],
		};
		const resolved = resolveRowReflection(source, null);
		expect(resolved?.status).toBe("cancelled");
		expect(resolved?.reason).toBe("user denied");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// reflectionToolCallData
// ─────────────────────────────────────────────────────────────────────────────

describe("reflectionToolCallData", () => {
	it("carries the persisted identity and reason the notice reads", () => {
		const source: VListReflectionSource = {
			toolCallId: "tc-1",
			toolName: "Bash",
			status: "fail",
			errorMessage: "Narrator aborted",
			permissionDecisionReason: "Danger reflection aborted",
			suggestions: [suggestion("danger_reflection", "aborted")],
		};
		const data = reflectionToolCallData("tu-1", source, null);
		expect(data.id).toBe("tc-1");
		expect(data.toolUseId).toBe("tu-1");
		expect(data.toolName).toBe("Bash");
		expect(data.status).toBe("fail");
		expect(data.errorMessage).toBe("Narrator aborted");
		expect(data.permissionDecisionReason).toBe("Danger reflection aborted");
		expect(data.permissionSuggestions).toHaveLength(1);
	});

	it("falls back to the pending permission, then the tool use id", () => {
		const fromPending = reflectionToolCallData(
			"tu-2",
			undefined,
			perm({ id: "req-7", toolName: "ExitPlanMode", decisionReason: "live reason" }),
		);
		expect(fromPending.id).toBe("req-7");
		expect(fromPending.toolName).toBe("ExitPlanMode");
		expect(fromPending.permissionDecisionReason).toBe("live reason");

		const bare = reflectionToolCallData("tu-3", undefined, null);
		expect(bare.id).toBe("tu-3");
		expect(bare.status).toBe("pending");
		expect(bare.errorMessage).toBeUndefined();
	});
});
