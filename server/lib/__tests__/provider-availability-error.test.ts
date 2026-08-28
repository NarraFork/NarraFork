import { describe, expect, test } from "bun:test";
import { isProviderUnavailableError } from "../provider-availability-error";

describe("isProviderUnavailableError", () => {
	test("matches every resolver error that means the model reference is unusable", () => {
		// These three strings are produced verbatim by resolveProviderAndModel().
		expect(
			isProviderUnavailableError(
				new Error(
					'Provider "cun" is not configured. Please check your provider settings or choose a different model.',
				),
			),
		).toBe(true);
		expect(
			isProviderUnavailableError(
				new Error(
				),
			),
		).toBe(true);
		expect(
			isProviderUnavailableError(
			),
		).toBe(true);
	});

	test("matches an unconfigured default model, which retrying cannot fix", () => {
		// Matched by `name`, so this must hold even though the wording carries no
		// "not configured"/"is disabled" phrase that the string checks would catch.
		// The cost of missing it is silent: withSummaryRetry() treats anything it
		// does not recognize as transient, so an unconfigured default model was
		// retried with backoff for minutes and surfaced as a hang rather than as
		// "no default model is configured".
		const err = new Error("No default model is configured. Set agent.defaultModel in settings.");
		err.name = "DefaultModelNotConfiguredError";
		expect(isProviderUnavailableError(err)).toBe(true);
	});

	test("does not claim transient upstream failures, which must be retried instead", () => {
		expect(isProviderUnavailableError(new Error("429 Too Many Requests"))).toBe(false);
		expect(isProviderUnavailableError(new Error("Overloaded"))).toBe(false);
		expect(isProviderUnavailableError(new Error("fetch failed: ECONNRESET"))).toBe(false);
		expect(isProviderUnavailableError(new Error("Continuation claim was lost"))).toBe(false);
	});

	test("accepts a bare string reason, since rejections are not always Errors", () => {
		expect(isProviderUnavailableError('Provider "x" is not configured.')).toBe(true);
		expect(isProviderUnavailableError("socket hang up")).toBe(false);
	});

	test("ignores values that carry no message", () => {
		expect(isProviderUnavailableError(undefined)).toBe(false);
		expect(isProviderUnavailableError(null)).toBe(false);
		expect(isProviderUnavailableError({ code: "not configured" })).toBe(false);
	});
});
