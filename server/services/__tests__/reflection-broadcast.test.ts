/**
 * Fan-out contract for reflection-gate lifecycle frames.
 *
 * The bug this pins: a subagent's reflection gate was broadcast only to the
 * PARENT narrator, so a client viewing the subagent's own page never learned the
 * gate had stopped/resolved and kept rendering a running notice forever (these
 * frames do not bump messageVersion, so no structural reload rescues them).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const sent: Array<{ target: string; message: Record<string, unknown> }> = [];
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };

mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWsModule,
	broadcastToNarrator: (narratorId: string, message: Record<string, unknown>) => {
		sent.push({ target: narratorId, message });
	},
}));

const { broadcastReflectionFrame, reflectionBroadcastTargets, reflectionRoutingIdentityFor } =
	await import("../reflection-broadcast");

const OWNER = "subagent-narrator";
const PARENT = "parent-narrator";
const PARENT_TOOL_USE = "parent-agent-tool-use";

const subagentRoute = {
	narratorId: OWNER,
	broadcastTargetId: PARENT,
	parentToolUseId: PARENT_TOOL_USE,
};
const topLevelRoute = { narratorId: OWNER, broadcastTargetId: OWNER };

beforeEach(() => {
	sent.length = 0;
});

afterAll(() => {
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

describe("reflectionBroadcastTargets", () => {
	test("a subagent gate reaches both the owner and the parent page", () => {
		expect(reflectionBroadcastTargets(subagentRoute)).toEqual([OWNER, PARENT]);
	});

	test("a top-level gate stays a single target", () => {
		expect(reflectionBroadcastTargets(topLevelRoute)).toEqual([OWNER]);
	});

	test("blank ids are dropped rather than broadcast to", () => {
		expect(reflectionBroadcastTargets({ narratorId: OWNER, broadcastTargetId: "" })).toEqual([
			OWNER,
		]);
	});
});

describe("reflectionRoutingIdentityFor", () => {
	test("the parent view keeps the child-pointing fields", () => {
		expect(reflectionRoutingIdentityFor(subagentRoute, PARENT)).toEqual({
			ownerNarratorId: OWNER,
			subagentNarratorId: OWNER,
			parentToolUseId: PARENT_TOOL_USE,
		});
	});

	test("the owner's own view sees the gate as top-level", () => {
		// The frontend routes an event carrying parentToolUseId into a PARENT card's
		// activity summary instead of a top-level row (useVListLivePatches.routeParent),
		// so sharing the parent's identity would make the subagent's own page discard it.
		expect(reflectionRoutingIdentityFor(subagentRoute, OWNER)).toEqual({
			ownerNarratorId: OWNER,
		});
	});
});

describe("broadcastReflectionFrame", () => {
	test("stops frame reaches both pages, each stamped with its own narratorId", () => {
		broadcastReflectionFrame(subagentRoute, {
			type: "danger_reflection_stopped",
			requestId: "req-1",
			toolUseId: "tool-use-1",
			toolName: "Bash",
			danger: { severity: "high", summary: "rm -rf" },
			inputJson: { command: "rm -rf /tmp/x" },
			reason: "stopped by user",
		});

		expect(sent).toHaveLength(2);
		const ownerFrame = sent.find((entry) => entry.target === OWNER);
		const parentFrame = sent.find((entry) => entry.target === PARENT);

		expect(ownerFrame?.message).toMatchObject({
			type: "danger_reflection_stopped",
			narratorId: OWNER,
			ownerNarratorId: OWNER,
			requestId: "req-1",
			toolUseId: "tool-use-1",
			reason: "stopped by user",
		});
		// The owner's copy must NOT claim to describe a child of itself.
		expect(ownerFrame?.message.subagentNarratorId).toBeUndefined();
		expect(ownerFrame?.message.parentToolUseId).toBeUndefined();

		expect(parentFrame?.message).toMatchObject({
			narratorId: PARENT,
			ownerNarratorId: OWNER,
			subagentNarratorId: OWNER,
			parentToolUseId: PARENT_TOOL_USE,
		});
	});

	test("frame-specific payloads survive the fan-out", () => {
		broadcastReflectionFrame(subagentRoute, {
			type: "task_reflection_stopped",
			requestId: "req-2",
			toolUseId: "tool-use-2",
			toolName: "Write",
			inputJson: { file_path: "spec://tasks.json" },
			mutations: [{ kind: "complete" }],
			reason: "taken over",
		});

		expect(sent).toHaveLength(2);
		for (const entry of sent) {
			expect(entry.message.mutations).toEqual([{ kind: "complete" }]);
			expect(entry.message.toolName).toBe("Write");
		}
	});

	test("a top-level gate is broadcast exactly once", () => {
		broadcastReflectionFrame(topLevelRoute, {
			type: "plan_reflection_resolved",
			requestId: "req-3",
			toolUseId: "tool-use-3",
			decision: "allow",
			reason: "confirmed",
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]?.target).toBe(OWNER);
		expect(sent[0]?.message.subagentNarratorId).toBeUndefined();
	});
});
