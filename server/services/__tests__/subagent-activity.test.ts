import { describe, expect, test } from "bun:test";
import { summarizeSubagentToolCall } from "../subagent-activity";

describe("summarizeSubagentToolCall", () => {
	test("shows the ContextAsk target without exposing questions or answers", () => {
		expect(
			summarizeSubagentToolCall("ContextAsk", {
				targetId: "worker-123",
			}),
		).toBe("from worker-123");
	});
});
