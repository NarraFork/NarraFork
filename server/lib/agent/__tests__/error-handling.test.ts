import { describe, expect, test } from "bun:test";
import { isRetryableInvalidStateReason } from "../error-handling";

describe("agent error handling", () => {
	test("treats truncated Responses API streams as retryable", () => {
		expect(isRetryableInvalidStateReason("stream_closed_before_response_completed")).toBe(true);
	});
});
