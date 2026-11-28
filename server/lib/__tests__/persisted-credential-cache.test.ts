import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { providerQuotaSourceSchema } from "@shared/provider-quota";
import { parsePersistedProviderQuota } from "../../services/provider-quota-persistence";
import {
	ProviderQuotaService,
	type ProviderQuotaSource,
} from "../../services/provider-quota-service";
import { CustomApiQuotaTargetDirectory } from "../../services/provider-quota-targets";
import { getNarraforkPath } from "../narrafork-home";
import { createPersistedCredentialCache } from "../persisted-credential-cache";
import type { CustomApiProviderConfig } from "../settings";
import { quotaConfig, walletQuota } from "./provider-quota-legacy-fixture";

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

const services: ProviderQuotaService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
});

describe("provider quota persistence replaces the independent balance cache", () => {
	test("source discovery and balance survive restart only under the same account identity", async () => {
		const file = `provider-quota-test-${crypto.randomUUID()}.json`;
		const persistence = createPersistedCredentialCache(file, parsePersistedProviderQuota);
		const source: ProviderQuotaSource = {
			id: "test-quota/relay",
			pluginId: "test-quota",
			contributionId: "relay",
			revision: "v1",
			declaration: providerQuotaSourceSchema.parse({
				id: "relay",
				title: "Relay",
				match: { fallback: true },
				requests: [{ path: "/quota", auth: "bearer" }],
			}),
		};
		const query = mock(async () => ({
			status: "supported" as const,
			data: walletQuota,
			error: null,
			cursor: "sub2api:/",
		}));
		let providers: CustomApiProviderConfig[] = [];
		const create = () => {
			const service = new ProviderQuotaService({
				directory: new CustomApiQuotaTargetDirectory({
					providers: () => providers,
					globalProxy: () => null,
					userAgent: () => "quota-test",
				}),
				driver: { listSources: () => [source], query },
				persistence: createPersistedCredentialCache(file, parsePersistedProviderQuota),
				onChanged: () => {},
			});
			services.push(service);
			service.start();
			return service;
		};
		const before = new ProviderQuotaService({
			directory: new CustomApiQuotaTargetDirectory({
				providers: () => providers,
				globalProxy: () => null,
				userAgent: () => "quota-test",
			}),
			driver: { listSources: () => [source], query },
			persistence,
			onChanged: () => {},
		});
		services.push(before);
		before.start();
		providers = [quotaConfig()];
		expect((await before.refresh("relay-test"))?.status).toBe("supported");
		await persistence.flush();
		before.stop();

		providers = [];
		const restarted = create();
		providers = [quotaConfig()];
		const restored = restarted.peek("relay-test");
		expect(restored).toMatchObject({ status: "supported", sourceId: "test-quota/relay" });
		expect(restored?.data?.amounts[0]?.remaining).toBe(12);
		expect(restored).not.toHaveProperty("cursor");
		expect(readFileSync(getNarraforkPath(file), "utf8")).not.toContain("test-secret-key");

		providers = [];
		const otherAccount = create();
		providers = [quotaConfig({ apiKey: "other-key" })];
		expect(otherAccount.peek("relay-test")).toMatchObject({ status: "pending", data: null });
	});

	test("rejects persisted supported entries without source identity or normalized data", () => {
		expect(
			parsePersistedProviderQuota({
				status: "supported",
				data: null,
				fetchedAt: 1,
				attemptedAt: 1,
			}),
		).toBeNull();
		expect(
			parsePersistedProviderQuota({
				sourceId: "test/relay",
				sourceRevision: "v1",
				status: "supported",
				data: null,
				fetchedAt: 1,
				attemptedAt: 1,
			}),
		).toBeNull();
	});
});
