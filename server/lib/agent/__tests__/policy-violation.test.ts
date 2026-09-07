import { describe, expect, test } from "bun:test";
import {
	CYBER_POLICY_VIOLATION_CODE,
	extractPolicyViolationCode,
	isPolicyViolationCode,
} from "@shared/agent-protocol/policy-violation";

describe("isPolicyViolationCode", () => {
	test("matches the canonical cyber_policy code", () => {
		expect(isPolicyViolationCode(CYBER_POLICY_VIOLATION_CODE)).toBe(true);
	});

	test("normalizes case and separators", () => {
		expect(isPolicyViolationCode("Cyber_Policy")).toBe(true);
		expect(isPolicyViolationCode("cyber-policy")).toBe(true);
		expect(isPolicyViolationCode(" cyber_policy ")).toBe(true);
	});

	test("rejects non-violation codes and empty input", () => {
		expect(isPolicyViolationCode("api_error")).toBe(false);
		expect(isPolicyViolationCode("content_filter")).toBe(false);
		// Substring-shaped prose must not match — detection is exact code only.
		expect(isPolicyViolationCode("cyber_policy_violation_extended")).toBe(false);
		expect(isPolicyViolationCode("")).toBe(false);
		expect(isPolicyViolationCode(null)).toBe(false);
		expect(isPolicyViolationCode(undefined)).toBe(false);
	});
});

describe("extractPolicyViolationCode", () => {
	test("reads ApiError-shaped diagnostics.code", () => {
		const err = Object.assign(new Error("OpenAI API error 400: blocked"), {
			status: 400,
			diagnostics: { code: "cyber_policy", message: "blocked" },
		});
		expect(extractPolicyViolationCode(err)).toBe(CYBER_POLICY_VIOLATION_CODE);
	});

	test("reads diagnostics.reason when code is absent", () => {
		const err = Object.assign(new Error("blocked"), {
			diagnostics: { reason: "cyber_policy" },
		});
		expect(extractPolicyViolationCode(err)).toBe(CYBER_POLICY_VIOLATION_CODE);
	});

	test("reads a flat code property (WS retryable / wrapped error events)", () => {
		const err = Object.assign(new Error("stream failed"), { code: "cyber_policy" });
		expect(extractPolicyViolationCode(err)).toBe(CYBER_POLICY_VIOLATION_CODE);
	});

	test("returns null for non-violation errors", () => {
		expect(extractPolicyViolationCode(new Error("boom"))).toBeNull();
		expect(
			extractPolicyViolationCode(
				Object.assign(new Error("quota"), { diagnostics: { code: "quota_exceeded" } }),
			),
		).toBeNull();
		expect(extractPolicyViolationCode(null)).toBeNull();
		expect(extractPolicyViolationCode("cyber_policy")).toBeNull();
	});
});
