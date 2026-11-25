import { describe, expect, test } from "bun:test";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { publicQuotaSnapshot } from "../../lib/sourcing/quota-snapshots";

const secret = "401 from https://kimi.com/api/internal/usage (key sk-live-abc123 rejected)";
const snapshot = (error?: string): QuotaSnapshot => ({
	fetchedAt: 1_700_000_000_000,
	scope: "subscription",
	windows: [{ kind: "5h", usedRatio: 0.1, resetsAt: null }],
	balances: [],
	...(error ? { error } : {}),
	detail: { apiKey: "sk-private", account: "private@example.com", headers: secret },
});

describe("unified quota public projection", () => {
	test("no role receives upstream errors or private detail", () => {
		const publicSnapshot = publicQuotaSnapshot(snapshot(secret));
		expect(publicSnapshot).toMatchObject({ hasError: true, error: "quota_unavailable" });
		expect(JSON.stringify(publicSnapshot)).not.toMatch(
			/sk-live|sk-private|private@example|kimi\.com|headers|detail/,
		);
	});
	test("numbers and fetchedAt survive; success remains distinguishable from failure", () => {
		expect(publicQuotaSnapshot(snapshot())).toEqual({
			fetchedAt: 1_700_000_000_000,
			scope: "subscription",
			windows: [{ kind: "5h", usedRatio: 0.1, resetsAt: null }],
			balances: [],
			hasError: false,
		});
	});
	test("cold snapshots remain unknown, never zero allowance", () => {
		expect(publicQuotaSnapshot(undefined)).toBeNull();
	});
});
