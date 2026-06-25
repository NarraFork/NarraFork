import { describe, expect, mock, test } from "bun:test";

mock.module("../../db", () => ({
	db: {},
	sqlite: {},
}));

const { formatAgentAwaitResult } = await import("../agent-communication");
const { formatResult } = await import("../../lib/agent/tools/await");

const AGENT_ID = "-tLSXSnYCPV_Z9m6gyRgX";
const TASK_ID = "bg-task-123";

describe("Await agent result wording", () => {
	test("aborted wait makes clear the subagent is still running and can be awaited again", () => {
		const text = formatAgentAwaitResult(AGENT_ID, "aborted", null);
		// Must not look like the subagent itself was killed.
		expect(text).not.toMatch(/status: aborted/);
		expect(text).not.toMatch(/\(no output\)/);
		expect(text.toLowerCase()).toContain("still running");
		expect(text.toLowerCase()).toContain("await again");
		// Subagent id tag is preserved so the frontend can still resolve it.
		expect(text).toContain(`<subagent_id>${AGENT_ID}</subagent_id>`);
	});

	test("timeout/running wait reminds the caller to await again rather than implying failure", () => {
		for (const status of ["timeout", "running"]) {
			const text = formatAgentAwaitResult(AGENT_ID, status, null);
			expect(text.toLowerCase()).toContain("still running");
			expect(text.toLowerCase()).toContain("await again");
			expect(text).not.toMatch(/\(no output\)/);
		}
	});

	test("aborted wait surfaces real partial output but drops empty placeholders", () => {
		const withPartial = formatAgentAwaitResult(AGENT_ID, "aborted", "halfway through the task");
		expect(withPartial).toContain("Partial output so far:");
		expect(withPartial).toContain("halfway through the task");

		// Placeholder stand-ins must not be shown as if they were real output.
		const withPlaceholder = formatAgentAwaitResult(AGENT_ID, "aborted", "Await aborted.");
		expect(withPlaceholder).not.toContain("Partial output so far:");
	});

	test("terminal statuses keep the explicit result wording", () => {
		const completed = formatAgentAwaitResult(AGENT_ID, "completed", "done");
		expect(completed).toContain(`Agent ${AGENT_ID} status: completed`);
		expect(completed).toContain("done");

		const failed = formatAgentAwaitResult(AGENT_ID, "failed", "boom");
		expect(failed).toContain(`Agent ${AGENT_ID} status: failed`);
	});
});

describe("Await bash result wording", () => {
	test("aborted wait makes clear the task is still running and can be awaited again", () => {
		const text = formatResult(TASK_ID, "aborted", null);
		expect(text.toLowerCase()).toContain("still running");
		expect(text.toLowerCase()).toContain("await again");
		// The old wording implied the await/task was over.
		expect(text).not.toMatch(/await was aborted/i);
	});

	test("timeout/running wait keeps the task alive in the wording", () => {
		const text = formatResult(TASK_ID, "timeout", "partial log line");
		expect(text.toLowerCase()).toContain("still running");
		expect(text.toLowerCase()).toContain("await again");
		expect(text).toContain("partial log line");
	});

	test("completed/failed/cancelled keep their terminal wording", () => {
		expect(formatResult(TASK_ID, "completed", "ok")).toContain("completed");
		expect(formatResult(TASK_ID, "failed", "err")).toContain("failed");
		expect(formatResult(TASK_ID, "cancelled", null)).toContain("was cancelled");
	});
});
