import { describe, expect, test } from "bun:test";
import {
	builtinProviderBalanceEngine,
	getProviderBalanceEngine,
	resetProviderBalanceEngine,
	setProviderBalanceEngine,
} from "@server/lib/provider-balance-engine";
import type { ProviderBalanceData } from "@shared/provider-balance";

describe("provider balance engine registry", () => {
	test("defaults to the bundled engine", () => {
		resetProviderBalanceEngine();
		expect(getProviderBalanceEngine()).toBe(builtinProviderBalanceEngine);
		expect(getProviderBalanceEngine().id).toBe("builtin");
	});

	test("can be replaced and restored", () => {
		const fake = {
			id: "test",
			probe: async () => null,
			refresh: async () => ({ scope: "key" as const, unlimited: true, amounts: [] }),
		};
		try {
			setProviderBalanceEngine(fake);
			expect(getProviderBalanceEngine().id).toBe("test");
		} finally {
			resetProviderBalanceEngine();
		}
		expect(getProviderBalanceEngine()).toBe(builtinProviderBalanceEngine);
	});

	test("treats a null engine as 'restore builtin' rather than 'no engine'", () => {
		try {
			setProviderBalanceEngine({
				id: "test",
				probe: async () => null,
				refresh: async () => ({ scope: "key" as const, unlimited: true, amounts: [] }),
			});
			setProviderBalanceEngine(null);
			expect(getProviderBalanceEngine()).toBe(builtinProviderBalanceEngine);
		} finally {
			resetProviderBalanceEngine();
		}
	});

	test("the bundled engine still reports an unusable base URL instead of throwing raw", async () => {
		const balance: ProviderBalanceData = { scope: "key", unlimited: true, amounts: [] };
		expect(balance.unlimited).toBe(true);
		// A URL with a query string is rejected by the transport before any I/O.
		await expect(
			builtinProviderBalanceEngine.probe({
				config: {
					id: "p1",
					name: "p1",
					prefix: "p1",
					baseUrl: "https://relay.invalid/v1?x=1",
					protocol: "completions-compatible",
					apiKey: "k",
					defaultModel: "m",
				},
				signal: AbortSignal.timeout(1_000),
			}),
		).rejects.toThrow();
	});
});
