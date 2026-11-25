import { describe, expect, test } from "bun:test";
import { providerBalanceQuotaIdentity } from "../provider-balance-cache";
import type { CustomApiProviderConfig } from "../settings";
import { quotaNetworkIdentity } from "../sourcing/quota-identity";

const config: CustomApiProviderConfig = {
	id: "network-identity",
	name: "Identity",
	prefix: "identity",
	baseUrl: "https://relay.example/v1",
	apiKey: "identity-secret",
	defaultModel: "m",
	protocol: "completions-compatible",
};
const direct = { mode: "direct" };
const changes: Array<{
	name: string;
	fields?: Partial<CustomApiProviderConfig>;
	global?: unknown;
}> = [
	{
		name: "per-key proxy",
		fields: { proxy: { mode: "custom", url: "http://proxy.example:8080" } },
	},
	{ name: "TLS verification", fields: { tlsRejectUnauthorized: false } },
	{ name: "UA mode", fields: { userAgentMode: "codex" } },
	{ name: "custom UA", fields: { customUserAgent: "quota-agent" } },
	{ name: "headers", fields: { extraHeaders: { "X-Account": "other" } } },
	{ name: "global proxy", global: { mode: "custom", url: "http://global.example:8080" } },
];

// Relay/site balances still have their own serializer. Keep its field coverage until
// production delegates to quotaNetworkIdentity too, without multiplying every source.
for (const [name, identity] of [
	["shared network", quotaNetworkIdentity],
	["relay/site network", providerBalanceQuotaIdentity],
] as const) {
	describe(name, () => {
		for (const change of changes) {
			test(`${change.name} changes identity`, () => {
				expect(identity({ ...config, ...change.fields }, change.global ?? direct)).not.toBe(
					identity(config, direct),
				);
			});
		}
		test("header insertion order alone does not change identity", () => {
			expect(identity({ ...config, extraHeaders: { "X-One": "1", "X-Two": "2" } }, direct)).toBe(
				identity({ ...config, extraHeaders: { "X-Two": "2", "X-One": "1" } }, direct),
			);
		});
	});
}

for (const fields of [
	{ quotaSiteUrl: "https://site.example" },
	{ quotaAccessToken: "site-token" },
	{ quotaUserId: "other-user" },
	{ protocol: "anthropic-messages" as const },
]) {
	test(`relay/site ${Object.keys(fields)[0]} changes account identity`, () => {
		expect(providerBalanceQuotaIdentity({ ...config, ...fields }, direct)).not.toBe(
			providerBalanceQuotaIdentity(config, direct),
		);
	});
}
