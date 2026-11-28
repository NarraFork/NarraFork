import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getNarraforkPath } from "../narrafork-home";
import { createPersistedCredentialCache } from "../persisted-credential-cache";
import {
	type PersistedProviderBalance,
	ProviderBalanceCache,
	parsePersistedProviderBalance,
} from "../provider-balance-cache";
import type { CustomApiProviderConfig } from "../settings";
import { parseQuotaSnapshot, QuotaStore } from "../sourcing/quota-store";

const parseNumber = (raw: unknown) => (typeof raw === "number" ? raw : null);

describe("persisted credential cache", () => {
	test("restores across instances only under the same identity, never writing it", async () => {
		const file = `persisted-cache-test-${crypto.randomUUID()}.json`;
		const first = createPersistedCredentialCache(file, parseNumber);
		first.save("p1", "identity-with-secret-key", 42);
		await first.flush();

		const raw = readFileSync(getNarraforkPath(file), "utf-8");
		expect(raw).not.toContain("identity-with-secret-key");

		const second = createPersistedCredentialCache(file, parseNumber);
		expect(second.restore("p1", "identity-with-secret-key")).toBe(42);
		expect(second.restore("p1", "another-account")).toBeUndefined();
		expect(second.restore("p2", "identity-with-secret-key")).toBeUndefined();

		second.remove("p1");
		await second.flush();
		const third = createPersistedCredentialCache(file, parseNumber);
		expect(third.restore("p1", "identity-with-secret-key")).toBeUndefined();
	});

	test("values that fail validation are dropped", async () => {
		const file = `persisted-cache-test-${crypto.randomUUID()}.json`;
		const writer = createPersistedCredentialCache<unknown>(file, (raw) => raw);
		writer.save("p1", "id", "not-a-number");
		await writer.flush();
		const reader = createPersistedCredentialCache(file, parseNumber);
		expect(reader.restore("p1", "id")).toBeUndefined();
	});
});

describe("provider balance cache persistence", () => {
	function provider(): CustomApiProviderConfig {
		return {
			id: "relay",
			name: "Relay",
			prefix: "relay",
			baseUrl: "https://relay.example/v1",
			apiKey: "secret-key",
			protocol: "completions-compatible",
			defaultModel: "model",
		};
	}

	test("a supported discovery survives a restart and keeps refreshing its endpoint", async () => {
		const file = `provider-balance-test-${crypto.randomUUID()}.json`;
		const persistence = createPersistedCredentialCache(file, parseQuotaSnapshot);
		let providers = [provider()];
		const fetch = mock(async () =>
			Response.json({ mode: "unrestricted", isValid: true, balance: 7, unit: "USD" }),
		);
		const before = new ProviderBalanceCache({
			providers: () => providers,
			globalProxy: () => null,
			fetch,
			store: new QuotaStore(persistence),
		});
		const found = await before.request("relay");
		expect(found?.status).toBe("supported");
		await persistence.flush();

		const restarted = new ProviderBalanceCache({
			providers: () => providers,
			globalProxy: () => null,
			fetch,
			store: new QuotaStore(createPersistedCredentialCache(file, parseQuotaSnapshot)),
		});
		const restored = restarted.peek("relay");
		expect(restored).toMatchObject({ status: "supported", adapter: "sub2api" });
		expect(restored?.balance?.amounts[0]?.remaining).toBe(7);

		// A different key must not see the old account's balance.
		providers = [{ ...provider(), apiKey: "other-key" }];
		const otherAccount = new ProviderBalanceCache({
			providers: () => providers,
			globalProxy: () => null,
			fetch,
			store: new QuotaStore(createPersistedCredentialCache(file, parseQuotaSnapshot)),
		});
		expect(otherAccount.peek("relay")).toMatchObject({ status: "pending", balance: null });
	});

	test("rejects persisted supported entries without an endpoint", () => {
		const value: Omit<PersistedProviderBalance, "endpoint"> = {
			status: "supported",
			balance: null,
			fetchedAt: 1,
			attemptedAt: 1,
		};
		expect(parsePersistedProviderBalance(value)).toBeNull();
	});
});
