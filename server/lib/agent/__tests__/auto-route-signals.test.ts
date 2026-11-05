import { afterEach, describe, expect, test } from "bun:test";
import { getProviderKeyStore } from "../../provider-keys";
import { settings } from "../../settings";
import { autoSourceFacts } from "../auto-route-signals";
import { reportKeyFault, resetProviderKeyRuntimeForTests } from "../pooled-provider";
import { ApiError } from "../types";

// Live facts the auto: router orders sources by. Runs under tests/preload.ts's temp home.

const saved = structuredClone(settings.customApiProviders);
const provider = (id: string, prefix: string, baseUrl: string) => ({
	id,
	name: prefix,
	prefix,
	apiKey: "",
	baseUrl,
	defaultModel: "m",
	protocol: "completions-compatible" as const,
});

afterEach(() => {
	settings.customApiProviders = saved;
	for (const id of ["sigRelay", "sigKimi"]) getProviderKeyStore().removeProvider(id);
	resetProviderKeyRuntimeForTests();
});

describe("auto route signals", () => {
	test("unknown prefixes are available pay-per-use", () => {
		expect(autoSourceFacts("not-configured")).toEqual({ available: true, subscription: false });
	});

	test("a Kimi Code plan is a subscription; a relay is not", () => {
		settings.customApiProviders = [
			provider("sigRelay", "sigrelay", "https://relay.example/v1"),
			provider("sigKimi", "sigkimi", "https://api.kimi.com/coding/v1"),
		];
		getProviderKeyStore().add("sigRelay", { apiKey: "sk-relay" });
		getProviderKeyStore().add("sigKimi", { apiKey: "sk-kimi" });
		expect(autoSourceFacts("sigkimi")).toEqual({ available: true, subscription: true });
		expect(autoSourceFacts("sigrelay")).toEqual({ available: true, subscription: false });
	});

	test("a provider whose every key is cooling down cannot serve until one recovers", () => {
		settings.customApiProviders = [provider("sigRelay", "sigrelay", "https://relay.example/v1")];
		const [first, second] = [
			getProviderKeyStore().add("sigRelay", { apiKey: "sk-1" }),
			getProviderKeyStore().add("sigRelay", { apiKey: "sk-2" }),
		];
		const now = Date.now();
		const rateLimited = new ApiError(429, "Too many requests");
		reportKeyFault(first, rateLimited, now);
		expect(autoSourceFacts("sigrelay", now).available).toBe(true);
		reportKeyFault(second, rateLimited, now);
		expect(autoSourceFacts("sigrelay", now).available).toBe(false);
		expect(autoSourceFacts("sigrelay", now + 61_000).available).toBe(true);
	});
});
