/**
 * tool-executing-event.test.ts — `tool_executing` marks the start of EXECUTION, and
 * nothing earlier.
 *
 * WHY THIS EXISTS
 * The frontend had no way to learn that a tool had actually started running. The only
 * available signal was `tool_call` (→ `tool_started`), which the server yields the
 * moment the tool's INPUT finishes parsing — before `executeTool` runs the permission
 * gate. So a card blocked on an approve/deny prompt was indistinguishable from one
 * mid-execution, and the UI painted both as working. Worse, the auto-allow path writes
 * `running` to the database and broadcasts nothing, so no later frame ever corrected
 * it: the client was forced to assume execution from `tool_call` alone.
 *
 * `tool_executing` closes that gap. These tests pin the two properties that make it
 * trustworthy — it fires only AFTER the gate approves, and never when the gate
 * refuses. Without the second, a denied tool would animate as though it had run.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { settings } from "../../settings";
import { executeTool } from "../tool-executor";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

const TOOL_NAME = "__ToolExecutingEventTest";

afterEach(() => {
	toolRegistry.unregister(TOOL_NAME);
});

/** Register a trivial tool that records when its body ran, relative to the events. */
function registerProbeTool(onExecute: () => void) {
	toolRegistry.register({
		name: TOOL_NAME,
		description: "probe",
		parameters: z.object({}),
		execute: async () => {
			onExecute();
			return { output: "done" };
		},
	} as never);
}

function makeConfig(
	permissionHandler: AgentConfig["permissionHandler"],
	onEvent: (event: AgentEvent) => void,
): AgentConfig {
	return {
		narratorId: "narrator-self",
		conversationId: "conversation-test",
		model: "codex:gpt-5.5",
		provider: "codex",
		cwd: "/tmp",
		signal: new AbortController().signal,
		permissionHandler,
		onEvent,
	} as AgentConfig;
}

describe("tool_executing marks the start of execution", () => {
	test("fires after the permission gate allows, and before the tool body runs", async () => {
		// The ordering IS the contract. `tool_executing` must land after approval (so it
		// cannot be mistaken for "input parsed") and before the tool body (so a fast tool
		// still gets one frame in which the UI can show it as running).
		const order: string[] = [];
		registerProbeTool(() => order.push("execute"));
		const result = await executeTool(
			{ toolUseId: "tu-allow", name: TOOL_NAME, input: {} },
			makeConfig(
				async () => {
					order.push("permission");
					return { behavior: "allow" };
				},
				(event) => {
					if (event.type === "tool_executing") order.push("tool_executing");
				},
			),
		);
		expect(result.output).toBe("done");
		expect(order).toEqual(["permission", "tool_executing", "execute"]);
	});

	test("carries the same executionStartedAt the result reports", async () => {
		// The event and the persisted timing must agree, or the header's elapsed counter
		// would jump when the tool finishes. Sharing one variable is what guarantees it —
		// notably a tool resumed after a transparent update wait re-stamps that variable.
		let eventStamp: number | undefined;
		registerProbeTool(() => {});
		const result = await executeTool(
			{ toolUseId: "tu-stamp", name: TOOL_NAME, input: {} },
			makeConfig(
				async () => ({ behavior: "allow" }),
				(event) => {
					if (event.type === "tool_executing") eventStamp = event.executionStartedAt;
				},
			),
		);
		expect(eventStamp).toBeDefined();
		expect(eventStamp).toBe(result.executionStartedAt);
	});

	test("does NOT fire when the gate DENIES the tool", async () => {
		// The property that keeps the blue shimmer honest: a refused tool never executed,
		// so claiming it did would be a straightforward lie about what the narrator did.
		let executingCount = 0;
		let executed = false;
		registerProbeTool(() => {
			executed = true;
		});
		const result = await executeTool(
			{ toolUseId: "tu-deny", name: TOOL_NAME, input: {} },
			makeConfig(
				async () => ({ behavior: "deny", message: "nope" }),
				(event) => {
					if (event.type === "tool_executing") executingCount++;
				},
			),
		);
		expect(result.isError).toBe(true);
		expect(executed).toBe(false);
		expect(executingCount).toBe(0);
	});

	test("fires exactly once per execution", async () => {
		// A duplicate would restart the one-shot outcome sweep bookkeeping downstream.
		let executingCount = 0;
		registerProbeTool(() => {});
		await executeTool(
			{ toolUseId: "tu-once", name: TOOL_NAME, input: {} },
			makeConfig(
				async () => ({ behavior: "allow" }),
				(event) => {
					if (event.type === "tool_executing") executingCount++;
				},
			),
		);
		expect(executingCount).toBe(1);
	});

	test("still fires for a tool whose body throws", async () => {
		// Execution DID begin; the card must have been able to show that before the
		// failure arrives, otherwise a crashing tool would flash straight from neutral to
		// red with no running phase at all.
		let executingCount = 0;
		toolRegistry.register({
			name: TOOL_NAME,
			description: "probe",
			parameters: z.object({}),
			execute: async () => {
				throw new Error("boom");
			},
		} as never);
		const result = await executeTool(
			{ toolUseId: "tu-throw", name: TOOL_NAME, input: {} },
			makeConfig(
				async () => ({ behavior: "allow" }),
				(event) => {
					if (event.type === "tool_executing") executingCount++;
				},
			),
		);
		expect(result.isError).toBe(true);
		expect(executingCount).toBe(1);
	});
});

// Keep the settings singleton untouched for the rest of the suite.
void settings;
