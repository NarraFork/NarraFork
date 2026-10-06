import { describe, expect, test } from "bun:test";
import {
	consumeMfaToken,
	invalidateMfaToken,
	issueMfaToken,
	MFA_STAGE,
	verifyMfaToken,
} from "../mfa";

describe("mfa challenge tokens", () => {
	test("issued token verifies and carries the pending stage + subject", async () => {
		const token = await issueMfaToken("user-1");
		const payload = await verifyMfaToken(token);
		expect(payload).not.toBeNull();
		expect(payload?.sub).toBe("user-1");
		expect(payload?.stage).toBe(MFA_STAGE);
		expect(payload?.jti).toBeTruthy();
	});

	test("a consumed token cannot be verified again (single-use)", async () => {
		const token = await issueMfaToken("user-2");
		const payload = await verifyMfaToken(token);
		if (!payload) throw new Error("expected payload");
		// Simulate a successful second-factor verification.
		consumeMfaToken(payload);
		expect(await verifyMfaToken(token)).toBeNull();
	});

	test("an invalidated token is rejected", async () => {
		const token = await issueMfaToken("user-3");
		const payload = await verifyMfaToken(token);
		if (!payload) throw new Error("expected payload");
		invalidateMfaToken(payload);
		expect(await verifyMfaToken(token)).toBeNull();
	});

	test("garbage / tampered tokens are rejected", async () => {
		expect(await verifyMfaToken("not-a-jwt")).toBeNull();
		expect(await verifyMfaToken("")).toBeNull();
	});
});
