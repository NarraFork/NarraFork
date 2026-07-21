import { afterEach, describe, expect, test } from "bun:test";
import {
	__setCodexPatWhoamiUrlForTests,
	CodexPatValidationError,
	isCodexPersonalAccessToken,
	validateCodexPersonalAccessToken,
} from "../codex-pat";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	__setCodexPatWhoamiUrlForTests(undefined);
});

function mockFetch(status: number, body: unknown): void {
	globalThis.fetch = (async () =>
		new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

describe("isCodexPersonalAccessToken", () => {
	test("detects at- prefix", () => {
		expect(isCodexPersonalAccessToken("at-abc123")).toBe(true);
		expect(isCodexPersonalAccessToken("  at-abc123 ")).toBe(true);
		expect(isCodexPersonalAccessToken("rt_abc")).toBe(false);
		expect(isCodexPersonalAccessToken(undefined)).toBe(false);
	});
});

describe("validateCodexPersonalAccessToken", () => {
	test("rejects tokens without at- prefix", async () => {
		await expect(validateCodexPersonalAccessToken("sk-nope")).rejects.toThrow(
			CodexPatValidationError,
		);
	});

	test("returns identity on success", async () => {
		mockFetch(200, {
			email: "user@example.com",
			chatgpt_user_id: "user-1",
			chatgpt_account_id: "acc-1",
			chatgpt_plan_type: "pro",
			chatgpt_account_is_fedramp: false,
		});
		const identity = await validateCodexPersonalAccessToken("at-token");
		expect(identity).toEqual({
			accountId: "acc-1",
			userId: "user-1",
			email: "user@example.com",
			planType: "pro",
			fedramp: false,
		});
	});

	test("treats 401 as invalid", async () => {
		mockFetch(401, { error: "unauthorized" });
		await expect(validateCodexPersonalAccessToken("at-token")).rejects.toMatchObject({
			status: 401,
		});
	});

	test("fails when required fields are missing", async () => {
		mockFetch(200, { email: "user@example.com" });
		await expect(validateCodexPersonalAccessToken("at-token")).rejects.toThrow(
			CodexPatValidationError,
		);
	});
});
