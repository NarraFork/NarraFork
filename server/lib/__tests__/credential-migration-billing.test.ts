import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { testEnvironment } from "../../../tests/preload";
import { CREDENTIALS_FILE, type CredentialsFile } from "../credential-store";
import { getNarraforkHome } from "../narrafork-home";
import {
	COMMAND_CODE_KEY_OWNER,
	getProviderKeyStore,
	nugKeyOwner,
	type ProviderKey,
	resetProviderKeyStoreForTests,
	TOKENDANCE_KEY_OWNER,
} from "../provider-keys";
import { defaultRequestSourceId } from "../request-source";
import { readSecretJSON, writeSecretJSON } from "../secret-store";
import { settings } from "../settings";
import { hydrateProviderKeys } from "../settings/provider-keys-projection";
import { registerTokenDanceRuntime } from "../tokendance-runtime";

/**
 * Requests are billed to the same credential ids before and after the migration: what the
 * real adapters report (the direct adapter its connection id, the pool the chosen key's id)
 * is compared with the migrated credentials. Upstream calls are stubbed.
 */
class StubProvider {
	constructor(readonly config?: { apiKey: string }) {}
	formatTools() {
		return [];
	}
	prepareForModel() {}
	async *chat() {}
	async generateWithMeta() {
		return { text: this.config?.apiKey ?? "ok" };
	}
}
class StubTokenDanceProvider extends StubProvider {
	constructor(apiKey?: string) {
		super({ apiKey: apiKey ?? "unexpected-runtime-key" });
	}
}
const realOpenai = { ...(await import("../agent/openai-provider")) };
const realNug = { ...(await import("../agent/nug-provider")) };
const realTokenDance = { ...(await import("../agent/tokendance-provider")) };
const realCommandCodeAuth = { ...(await import("../commandcode-manager")) };
const cliAuth = mock((apiKey?: string) => ({
	credential: { token: apiKey?.trim() || "forbidden-cli-fallback", source: "cli" as const },
}));
mock.module("../agent/tokendance-provider", () => ({
	...realTokenDance,
	TokenDanceProvider: StubTokenDanceProvider,
}));
mock.module("../commandcode-manager", () => ({
	...realCommandCodeAuth,
	resolveCommandCodeToken: cliAuth,
}));
mock.module("../agent/openai-provider", () => ({ ...realOpenai, OpenAIProvider: StubProvider }));
mock.module("../agent/nug-provider", () => ({ ...realNug, NugProvider: StubProvider }));
afterAll(() => {
	mock.module("../agent/openai-provider", () => realOpenai);
	mock.module("../agent/nug-provider", () => realNug);
	mock.module("../agent/tokendance-provider", () => realTokenDance);
	mock.module("../commandcode-manager", () => realCommandCodeAuth);
	mock.restore();
});
const { resolveProviderAndModel } = await import("../agent/provider");
const { PooledProvider, resetProviderKeyRuntimeForTests } = await import(
	"../agent/pooled-provider"
);
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

const MATRIX_NUG = "billing-matrix-nug";
const matrixFamilies = [
	{ name: "TokenDance", owner: TOKENDANCE_KEY_OWNER, group: "tokendance", model: "tokendance:m" },
	{
		name: "Command Code",
		owner: COMMAND_CODE_KEY_OWNER,
		group: "CommandCode",
		model: "CommandCode:gpt-matrix",
	},
	{ name: "NUG", owner: nugKeyOwner(MATRIX_NUG), group: MATRIX_NUG, model: "matrixnug:m" },
] as const;
const matrixCases = [
	"singlePlain",
	"secondDisabled",
	"firstDisabled",
	"singleNetwork",
	"allDisabled",
] as const;

describe("namespaced key billing survives legacy migration and credential-store restart", () => {
	let fixtureHome: string;
	let previousHome: string | undefined;
	let unregisterRuntime: (() => void) | undefined;

	beforeEach(() => {
		previousHome = process.env.NARRAFORK_HOME;
		// Every case owns an empty directory beneath the preload's isolated home.
		// Switching the lazy home resolver avoids deleting/reusing another case's files.
		fixtureHome = mkdtempSync(resolve(testEnvironment.narraforkHome, "billing-matrix-"));
		process.env.NARRAFORK_HOME = fixtureHome;
		resetProviderKeyStoreForTests();
		resetProviderKeyRuntimeForTests();
		cliAuth.mockClear();
		settings.agent.disabledProviders = [];
		settings.customApiProviders = [];
		settings.anthropicProviders = [];
		settings.openaiProviders = [];
		settings.geminiProviders = [];
		settings.tokendance = { apiKey: "", generation: 29, disabled: false };
		settings.commandCode = { apiKey: "", disabled: false };
		settings.nugProviders = [
			{
				id: MATRIX_NUG,
				name: "Migration matrix NUG",
				prefix: "matrixnug",
				apiKey: "",
				baseUrl: "https://matrix-nug.invalid",
				defaultModel: "m",
			},
		];
		unregisterRuntime = registerTokenDanceRuntime({
			getTokenDanceRuntimeConfig: () => ({
				apiKey: settings.tokendance?.apiKey ?? "",
				generation: 29,
				disabled: false,
			}),
			assertTokenDanceConnection: () => {},
			registerTokenDanceRequest: () => () => {},
			getTokenDanceCatalogModels: () => [],
		});
	});

	afterEach(() => {
		unregisterRuntime?.();
		resetProviderKeyRuntimeForTests();
		resetProviderKeyStoreForTests();
		if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
		else process.env.NARRAFORK_HOME = previousHome;
		rmSync(fixtureHome, { recursive: true, force: true });
	});

	for (const family of matrixFamilies) {
		for (const scenario of matrixCases) {
			test(`${family.name}: ${scenario} keeps billing and all stored identities`, async () => {
				const first: ProviderKey = {
					id: family.owner,
					providerId: family.owner,
					apiKey: "matrix-first-key",
					priority: 0,
					createdAt: 1,
					...(scenario === "firstDisabled" || scenario === "allDisabled"
						? { disabled: true, disabledReason: "manual" as const }
						: {}),
					...(scenario === "singleNetwork"
						? {
								network: {
									proxy: { mode: "custom" as const, url: "http://matrix-key.proxy.invalid:8080" },
									userAgentMode: "custom" as const,
									customUserAgent: "matrix-key-agent",
									extraHeaders: { "X-Matrix-Key": "first" },
								},
							}
						: {}),
				};
				const entries = [first];
				if (["secondDisabled", "firstDisabled", "allDisabled"].includes(scenario)) {
					entries.push({
						id: `${family.group}-second`,
						providerId: family.owner,
						apiKey: "matrix-second-key",
						priority: 1,
						createdAt: 2,
						...(scenario !== "firstDisabled"
							? { disabled: true, disabledReason: "manual" as const }
							: {}),
					});
				}
				writeSecretJSON(resolve(fixtureHome, "provider-keys.json"), entries);
				const pooled = scenario !== "singlePlain";
				const selected = scenario === "firstDisabled" ? entries[1] : first;
				if (!selected) throw new Error("missing selected migration matrix key");
				const expectedId = pooled ? selected.id : family.group;

				async function requestAfterRestart() {
					// Discard both stores and pool caches: the next resolution must read
					// the active on-disk format, not retained legacy objects/adapters.
					resetProviderKeyStoreForTests();
					resetProviderKeyRuntimeForTests();
					hydrateProviderKeys(settings);
					const loaded = getProviderKeyStore().list(family.owner);
					expect(loaded).toHaveLength(entries.length);
					expect(loaded.filter((entry) => entry.disabled)).toHaveLength(
						entries.filter((entry) => entry.disabled).length,
					);
					if (scenario === "allDisabled") {
						expect(() => resolveProviderAndModel(family.model)).toThrow("no usable API key");
						expect(cliAuth).not.toHaveBeenCalled();
						return { rejected: true };
					}
					const { adapter, model } = resolveProviderAndModel(family.model);
					expect(adapter instanceof PooledProvider).toBe(pooled);
					const result = await adapter.generateWithMeta("matrix request", model);
					expect(result).toEqual({ text: selected.apiKey, credentialId: expectedId });
					expect(cliAuth).not.toHaveBeenCalled();
					return result;
				}

				const before = await requestAfterRestart();
				expect(migrateCredentialFiles()).toBe("migrated");
				expect(await requestAfterRestart()).toEqual(before);
				const migrated = readSecretJSON(resolve(fixtureHome, CREDENTIALS_FILE)) as CredentialsFile;
				expect(migrated.credentials).toHaveLength(entries.length);
				const ids = migrated.credentials.map((credential) => credential.id);
				expect(new Set(ids).size).toBe(entries.length);
				const expectedIds =
					scenario === "singlePlain" ? [family.group] : entries.map((entry) => entry.id);
				expect(ids.toSorted()).toEqual(expectedIds.toSorted());
				for (const entry of entries) {
					const credential = migrated.credentials.find(
						(candidate) => candidate.id === (scenario === "singlePlain" ? family.group : entry.id),
					);
					expect(credential).toMatchObject({
						target: { groupId: family.group },
						auth: { kind: "api_key", apiKey: entry.apiKey },
						priority: entry.priority,
						createdAt: entry.createdAt,
					});
					expect(credential?.disabled === true).toBe(entry.disabled === true);
					expect(credential?.disabledReason).toBe(entry.disabledReason);
					expect(credential?.network).toEqual(entry.network);
				}
			});
		}
	}
});
