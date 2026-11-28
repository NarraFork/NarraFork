import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getCodexCredentialDedupeKeys } from "../codex-credential-dedupe";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("pure Codex credential dedupe", () => {
	test("returns all five identity keys in the manager's original order", () => {
		expect(
			getCodexCredentialDedupeKeys({
				agentRuntimeId: " runtime-1 \n",
				refreshToken: " rt-secret \n",
				sub: "subject-1",
				accountId: "account-1",
				email: "user@example.com",
				accessToken: " at-secret \t",
			}),
		).toEqual([
			"agent:runtime-1",
			`rt:${hash("rt-secret")}`,
			"sub:subject-1",
			"account-email:account-1:user@example.com",
			`at:${hash("at-secret")}`,
		]);
	});

	test("blank tokens and runtime ids are absent, not hashes of whitespace", () => {
		expect(getCodexCredentialDedupeKeys({})).toEqual([]);
		expect(
			getCodexCredentialDedupeKeys({
				refreshToken: " \n",
				accessToken: "\t ",
				agentRuntimeId: " ",
			}),
		).toEqual([]);
	});

	test("account claims keep their original case and whitespace semantics", () => {
		expect(
			getCodexCredentialDedupeKeys({ sub: " subject ", accountId: " account ", email: " A@B " }),
		).toEqual(["sub: subject ", "account-email: account : A@B "]);
		expect(getCodexCredentialDedupeKeys({ accountId: "account" })).toEqual([]);
		expect(getCodexCredentialDedupeKeys({ email: "user@example.com" })).toEqual([]);
	});

	test("token keys never expose their secret input", () => {
		const keys = getCodexCredentialDedupeKeys({
			refreshToken: "rt-private-refresh-token",
			accessToken: "at-private-access-token",
		});
		expect(keys).toEqual([
			`rt:${hash("rt-private-refresh-token")}`,
			`at:${hash("at-private-access-token")}`,
		]);
		for (const key of keys) {
			expect(key).not.toContain("rt-private-refresh-token");
			expect(key).not.toContain("at-private-access-token");
		}
	});
});
