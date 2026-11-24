import { afterAll, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { CREDENTIALS_FILE, type CredentialsFile } from "../credential-store";
import { getNarraforkHome } from "../narrafork-home";
import { resetProviderKeyStoreForTests } from "../provider-keys";
import { defaultRequestSourceId } from "../request-source";
import { readSecretJSON, writeSecretJSON } from "../secret-store";
import { settings } from "../settings";
import { hydrateProviderKeys } from "../settings/provider-keys-projection";

/**
 * Requests are billed to the same credential ids before and after the migration: what the
 * real adapters report (the direct adapter its connection id, the pool the chosen key's id)
 * is compared with the migrated credentials. Upstream calls are stubbed.
 */
class StubProvider {
	formatTools() {
		return [];
	}
	prepareForModel() {}
	async *chat() {}
	async generateWithMeta() {
		return { text: "ok" };
	}
}
const realOpenai = { ...(await import("../agent/openai-provider")) };
const realNug = { ...(await import("../agent/nug-provider")) };
mock.module("../agent/openai-provider", () => ({ ...realOpenai, OpenAIProvider: StubProvider }));
mock.module("../agent/nug-provider", () => ({ ...realNug, NugProvider: StubProvider }));
afterAll(() => {
	mock.module("../agent/openai-provider", () => realOpenai);
	mock.module("../agent/nug-provider", () => realNug);
	mock.restore();
});
const { resolveProviderAndModel } = await import("../agent/provider");
const { migrateCredentialFiles } = await import("../credential-migration");

const connection = (id: string) => ({
	id,
	name: id,
	prefix: `p-${id}`,
	apiKey: "",
	baseUrl: "https://api.example.com/v1",
	defaultModel: "m",
	protocol: "completions-compatible" as const,
});
const key = (providerId: string, id: string, apiKey: string, extra: object = {}) => ({
	id,
	providerId,
	apiKey,
	priority: 0,
	createdAt: 1,
	...extra,
});
const CONNECTIONS = ["multi", "solo", "net", "taken", "firstoff"];

async function billedIds(): Promise<Record<string, string | undefined>> {
	resetProviderKeyStoreForTests();
	hydrateProviderKeys(settings);
	const out: Record<string, string | undefined> = {};
	for (const prefix of [...CONNECTIONS.map((id) => `p-${id}`), "gw"]) {
		const { adapter } = resolveProviderAndModel(`${prefix}:m`);
		const result = (await adapter.generateWithMeta("hi", "m")) as { credentialId?: string };
		out[prefix] = result.credentialId;
	}
	return out;
}

describe("billing ids across the credential migration", () => {
	test("every connection reports the same credential before and after", async () => {
		writeSecretJSON(resolve(getNarraforkHome(), "provider-keys.json"), [
			key("multi", "multi", "sk-m1"),
			key("multi", "taken", "sk-m2", { priority: 1 }),
			key("solo", "solo-2", "sk-solo", { priority: 1 }),
			key("net", "net-1", "sk-net", { network: { userAgentMode: "claude-code" } }),
			key("taken", "taken-1", "sk-taken"),
			key("firstoff", "firstoff", "sk-f1", { disabled: true, disabledReason: "manual" }),
			key("firstoff", "f-2", "sk-f2", { priority: 1 }),
			key("nug:gw", "nug:gw", "nug-key"),
		]);
		settings.customApiProviders = CONNECTIONS.map(connection);
		settings.nugProviders = [
			{
				id: "gw",
				name: "gw",
				prefix: "gw",
				apiKey: "",
				baseUrl: "http://nug.example",
				defaultModel: "m",
			},
		];

		const before = await billedIds();
		expect(before).toEqual({
			"p-multi": "multi",
			"p-solo": "solo",
			"p-net": "net-1",
			"p-taken": "taken",
			"p-firstoff": "f-2",
			gw: "gw",
		});

		expect(migrateCredentialFiles()).toBe("migrated");
		expect(await billedIds()).toEqual(before);
		// Each billed id is a credential in the new file, in the connection's group.
		const file = readSecretJSON(resolve(getNarraforkHome(), CREDENTIALS_FILE)) as CredentialsFile;
		const groupOf = new Map(file.credentials.map((c) => [c.id, c.target.groupId]));
		for (const [prefix, id] of Object.entries(before)) {
			if (prefix === "p-taken") continue;
			expect(groupOf.get(id as string)).toBe(prefix.replace(/^p-/, ""));
		}
		// Its connection id already belongs to another key, so its key kept its own id (§15.3).
		expect(groupOf.get("taken-1")).toBe("taken");
		// The direct path still bills by prefix lookup where no adapter named a credential.
		expect(defaultRequestSourceId("p-solo")).toBe("solo");
	});
});
