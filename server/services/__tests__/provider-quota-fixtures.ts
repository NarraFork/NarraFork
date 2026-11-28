import type { CustomApiProviderConfig } from "@server/lib/settings";
import { providerQuotaSourceSchema, type QuotaQueryResult } from "@shared/provider-quota";
import type { ProviderQuotaSource } from "../provider-quota-service";

export function quotaProvider(
	overrides: Partial<CustomApiProviderConfig> = {},
): CustomApiProviderConfig {
	return {
		id: "custom-1",
		prefix: "custom",
		name: "Custom API",
		apiKey: "test-secret-key",
		baseUrl: "https://relay.test/v1",
		protocol: "completions-compatible",
		defaultModel: "model",
		...overrides,
	};
}

export function quotaSource(overrides: Partial<ProviderQuotaSource> = {}): ProviderQuotaSource {
	return {
		id: "third.party.quota/generic",
		pluginId: "third.party.quota",
		contributionId: "generic",
		revision: "installed-rev-1",
		declaration: providerQuotaSourceSchema.parse({
			id: "generic",
			title: "Independent quota source",
			match: { fallback: true },
			requests: [
				{ path: "/**/v1/usage", auth: "bearer", headers: ["user-agent"] },
				{ path: "/api/status", auth: "none" },
				{ path: "/usage", auth: "bearer-and-api-key" },
			],
		}),
		...overrides,
	};
}

export function quotaResult(remaining: number | null = 42): QuotaQueryResult {
	return {
		status: "supported",
		error: null,
		data: {
			amounts: [{ id: "remaining", unit: "CREDITS", remaining }],
			windows: [],
		},
		cursor: "confirmed-endpoint",
	};
}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

export async function settle(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("quota fixture did not settle");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

export function required<T>(value: T | null | undefined): T {
	if (value === undefined || value === null) throw new Error("Missing quota test fixture value");
	return value;
}
