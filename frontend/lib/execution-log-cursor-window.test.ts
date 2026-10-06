import { describe, expect, test } from "bun:test";
import { appendExecutionLogFilters } from "./execution-log-api";
import {
	advanceExecutionLogCursor,
	currentExecutionLogCursor,
	executionLogListQueryKey,
	retreatExecutionLogCursor,
} from "./execution-log-cursor-window";

describe("execution log cursor window", () => {
	test("advances and retreats through pages", () => {
		let stack: string[] = [];
		expect(currentExecutionLogCursor(stack)).toBeUndefined();

		stack = advanceExecutionLogCursor(stack, "cursor-2");
		stack = advanceExecutionLogCursor(stack, "cursor-3");
		expect(stack).toEqual(["cursor-2", "cursor-3"]);
		expect(currentExecutionLogCursor(stack)).toBe("cursor-3");

		stack = retreatExecutionLogCursor(stack);
		expect(currentExecutionLogCursor(stack)).toBe("cursor-2");
		stack = retreatExecutionLogCursor(stack);
		expect(stack).toEqual([]);
	});

	test("ignores a missing or repeated next cursor", () => {
		// A repeated cursor would otherwise grow the stack while showing the same
		// page, making the page counter lie.
		expect(advanceExecutionLogCursor(["a"], null)).toEqual(["a"]);
		expect(advanceExecutionLogCursor(["a"], undefined)).toEqual(["a"]);
		expect(advanceExecutionLogCursor(["a"], "a")).toEqual(["a"]);
	});

	test("query key distinguishes filters, page size and cursor", () => {
		const a = executionLogListQueryKey({ toolName: "Bash" }, 50, undefined);
		const b = executionLogListQueryKey({ toolName: "Read" }, 50, undefined);
		const c = executionLogListQueryKey({ toolName: "Bash" }, 100, undefined);
		const d = executionLogListQueryKey({ toolName: "Bash" }, 50, "cursor-2");
		const keys = [a, b, c, d].map((key) => JSON.stringify(key));
		expect(new Set(keys).size).toBe(4);
	});
});

describe("execution log filter serialization", () => {
	test("omits empty values", () => {
		const params = new URLSearchParams();
		appendExecutionLogFilters(params, { toolName: "", q: undefined, provider: "codex" });
		expect(params.toString()).toBe("provider=codex");
	});

	test("only sends the checkpoint flag when opting out of the default", () => {
		const hidden = new URLSearchParams();
		appendExecutionLogFilters(hidden, { hideFileHistoryCheckpoints: true });
		expect(hidden.toString()).toBe("");

		const shown = new URLSearchParams();
		appendExecutionLogFilters(shown, { hideFileHistoryCheckpoints: false });
		expect(shown.get("hideFileHistoryCheckpoints")).toBe("0");
	});

	test("never sends searchPayload without a needle", () => {
		// The server rejects that combination, so the client must not construct it.
		const alone = new URLSearchParams();
		appendExecutionLogFilters(alone, { searchPayload: true });
		expect(alone.has("searchPayload")).toBe(false);

		const withNeedle = new URLSearchParams();
		appendExecutionLogFilters(withNeedle, { q: "boom", searchPayload: true });
		expect(withNeedle.get("q")).toBe("boom");
		expect(withNeedle.get("searchPayload")).toBe("1");
	});

	test("serializes isBackground false explicitly", () => {
		const params = new URLSearchParams();
		appendExecutionLogFilters(params, { isBackground: false });
		expect(params.get("isBackground")).toBe("0");
	});
});
