import { describe, expect, test } from "bun:test";
import { isModelNetworkError, resolveModelTestTarget } from "./model-network-error";

describe("isModelNetworkError", () => {
	test("recognizes structured and legacy transport errors", () => {
		expect(
			isModelNetworkError(
				"Network request failed [connection_reset/ECONNRESET] after 42 ms: POST https://api.example.com/v1/responses",
			),
		).toBe(true);
		expect(
			isModelNetworkError(
				"The socket connection was closed unexpectedly. For more information, pass verbose: true",
			),
		).toBe(true);
		expect(isModelNetworkError("Unable to connect to provider: ECONNREFUSED")).toBe(true);
		expect(isModelNetworkError("OpenAI Responses stream error (stream_read_error)")).toBe(true);
	});

	test("recognizes upstream gateway statuses worth reproducing with model test", () => {
		expect(isModelNetworkError("OpenAI API error 502: Bad Gateway")).toBe(true);
		for (let status = 520; status <= 529; status++) {
			expect(isModelNetworkError(`provider returned HTTP ${status} gateway failure`)).toBe(true);
		}
	});

	test("does not classify unrelated narrator failures as network errors", () => {
		expect(isModelNetworkError("Tool error: file not found")).toBe(false);
		expect(isModelNetworkError("Context length exceeded")).toBe(false);
		expect(isModelNetworkError("Aborted")).toBe(false);
		expect(isModelNetworkError("")).toBe(false);
	});
});

describe("resolveModelTestTarget", () => {
	test("prefers the concrete runtime member over an aggregation reference", () => {
		expect(
			resolveModelTestTarget("__agg__:balanced", {
				provider: "openai",
				model: "gpt-5.4",
			}),
		).toBe("openai:gpt-5.4");
	});

	test("falls back to the selected model when runtime metadata is absent or invalid", () => {
		expect(resolveModelTestTarget("__agg__:balanced", null)).toBe("__agg__:balanced");
		expect(
			resolveModelTestTarget(" anthropic:claude-sonnet-4.6 ", { provider: "", model: "x" }),
		).toBe("anthropic:claude-sonnet-4.6");
	});
});
