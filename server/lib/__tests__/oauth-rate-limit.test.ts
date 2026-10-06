import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { oauthSecurityEvents } from "../../db/schema";
import { getOAuthRateLimitSnapshot, oauthRateLimitTesting } from "../oauth-rate-limit";
import { recordOAuthRateLimitTransition } from "../oauth-security-observability";

afterEach(async () => {
	await db.delete(oauthSecurityEvents).where(eq(oauthSecurityEvents.endpoint, "token"));
	oauthRateLimitTesting.resetNamespace("token");
	oauthRateLimitTesting.resetNamespace("revoke");
});

describe("OAuth bounded rate limiter", () => {
	test("returns a retry delay after a bucket is exhausted and refills", () => {
		const start = 1_000_000;
		for (let index = 0; index < 30; index++) {
			expect(oauthRateLimitTesting.consume("token", "fixed-client", start)).toBe(0);
		}
		expect(oauthRateLimitTesting.consume("token", "fixed-client", start)).toBeGreaterThan(0);
		expect(oauthRateLimitTesting.consume("token", "fixed-client", start + 2_000)).toBe(0);
	});

	test("persists only the transition into a limited state without bearer material", async () => {
		const start = 2_000_000;
		for (let index = 0; index < 30; index++) {
			oauthRateLimitTesting.consumeDecision("token", "audited-client", start);
		}
		const first = oauthRateLimitTesting.consumeDecision("token", "audited-client", start);
		const repeated = oauthRateLimitTesting.consumeDecision("token", "audited-client", start);
		expect(first.enteredLimitedState).toBe(true);
		expect(repeated.enteredLimitedState).toBe(false);
		if (first.enteredLimitedState) {
			await recordOAuthRateLimitTransition({
				endpoint: "token",
				bucketType: "ip",
				retryAfterSeconds: first.retryAfterMs / 1_000,
			});
		}
		if (repeated.enteredLimitedState) {
			await recordOAuthRateLimitTransition({
				endpoint: "token",
				bucketType: "ip",
				retryAfterSeconds: repeated.retryAfterMs / 1_000,
			});
		}
		const rows = await db.query.oauthSecurityEvents.findMany({
			where: eq(oauthSecurityEvents.endpoint, "token"),
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			eventType: "rate_limited",
			bucketType: "ip",
			clientId: null,
			grantId: null,
			userId: null,
		});
		expect(JSON.stringify(rows)).not.toContain("nfat_");
		expect(JSON.stringify(rows)).not.toContain("nfrt_");
	});

	test("keeps attacker-controlled key cardinality bounded", () => {
		for (let index = 0; index < 5_000; index++) {
			oauthRateLimitTesting.consume("revoke", `random-${index}`, 3_000_000);
		}
		const snapshot = getOAuthRateLimitSnapshot();
		expect(snapshot.namespaces.revoke.activeKeys).toBeLessThanOrEqual(
			snapshot.maxKeysPerNamespace + 1,
		);
		expect(snapshot.namespaces.revoke.limited).toBeGreaterThan(0);
	});
});
