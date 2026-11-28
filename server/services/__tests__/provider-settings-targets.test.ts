import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__setCodexManagerForTests,
	type CodexCredential,
	CodexManager,
	MAX_CODEX_PROVIDER_SETTINGS_PAGE_SIZE,
	MAX_CODEX_PROVIDER_SETTINGS_SCAN,
} from "@server/lib/codex-manager";
import { resolveCommandCodeToken } from "@server/lib/commandcode-manager";
import { AppError } from "@server/lib/errors";
import { writeSecretJSON } from "@server/lib/secret-store";
import { settings } from "@server/lib/settings";
import type { CustomApiProviderConfig, NUGProviderConfig } from "@server/lib/settings/types";
import {
	PluginProviderRegistry,
	type ProviderRegistryRegistration,
	pluginProviderRegistry,
} from "../plugin-provider-registry";
import {
	codexProviderSettingsTargetId,
	listProviderSettingsTargets,
	MAX_PROVIDER_SETTINGS_TARGETS,
	PROVIDER_SETTINGS_SINGLETON_IDS,
	type ProviderSettingsCodexReader,
	ProviderSettingsTargetDirectory,
	type ProviderSettingsTargetDirectoryOptions,
	resolveProviderSettingsTarget,
} from "../provider-settings-targets";

type SavedSettings = ReturnType<NonNullable<ProviderSettingsTargetDirectoryOptions["getSettings"]>>;

const SECRET = "provider-target-secret-do-not-expose";
const PRIVATE_PROXY = "http://proxy-user:proxy-secret@proxy.invalid:7890";
const PRIVATE_PATH = "/private/provider-keys/credentials.json";
const CALLBACK_URL = "https://private.invalid/oauth/callback?secret=callback-secret";
const managers: CodexManager[] = [];
const temporaryHomes: string[] = [];
let installedTestManager = false;

afterEach(() => {
	mock.restore();
	if (installedTestManager) __setCodexManagerForTests(undefined);
	installedTestManager = false;
	pluginProviderRegistry.removePlugin("com.example.saved");
	for (const manager of managers.splice(0)) manager.dispose();
	for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function custom(overrides: Partial<CustomApiProviderConfig> = {}): CustomApiProviderConfig {
	return {
		id: "custom-1",
		name: "Saved provider",
		prefix: "saved-prefix",
		protocol: "completions-compatible",
		apiKey: SECRET,
		baseUrl: "https://private.invalid/v1",
		defaultModel: "model",
		quotaAccessToken: "private-quota-token",
		proxy: { mode: "custom", url: PRIVATE_PROXY },
		extraHeaders: { authorization: "private-header-token" },
		...overrides,
	};
}

function nug(overrides: Partial<NUGProviderConfig> = {}): NUGProviderConfig {
	return {
		id: "nug-1",
		name: "Saved gateway",
		prefix: "gateway-prefix",
		apiKey: SECRET,
		baseUrl: "https://private.invalid/gateway",
		defaultModel: "anthropic:model",
		oauthClientSecret: "private-oauth-secret",
		oauthCallbackUrl: CALLBACK_URL,
		egressProxyUrl: PRIVATE_PROXY,
		...overrides,
	};
}

const EMPTY_CODEX: ProviderSettingsCodexReader = {
	getProviderSettingsIdentity: () => ({ status: "not-found" }),
	listProviderSettingsIdentities: () => ({ status: "ok", identities: [], nextOffset: null }),
	getProviderSettingsPoolIdentity: () => ({ status: "ok", exists: false, available: false }),
};

function directory(
	saved: SavedSettings = {},
	registry = new PluginProviderRegistry(),
	options: ProviderSettingsTargetDirectoryOptions = {},
): ProviderSettingsTargetDirectory {
	return new ProviderSettingsTargetDirectory({
		getSettings: () => saved,
		listPluginProviders: () => registry.list(),
		getCodexManager: () => EMPTY_CODEX,
		getCommandCodeAuth: () => ({ reason: "not_configured" }),
		...options,
	});
}

function register(
	registry: PluginProviderRegistry,
	overrides: Partial<ProviderRegistryRegistration> = {},
) {
	return registry.register({
		kind: "executable-plugin",
		pluginId: "com.example.saved",
		localId: "provider",
		providerInstanceId: "com.example.saved/provider@generation-1",
		providerPrefix: "plugin-prefix",
		displayName: "Saved provider",
		configSchema: {
			type: "object",
			properties: { apiKey: { type: "string", format: "password", default: SECRET } },
		},
		config: { apiKey: SECRET, path: PRIVATE_PATH, proxy: PRIVATE_PROXY, callback: CALLBACK_URL },
		createAdapter: () => {
			throw new Error("Identity reads must not create adapters");
		},
		...overrides,
	});
}

function credential(id: string, overrides: Partial<CodexCredential> = {}): CodexCredential {
	return {
		id,
		displayName: `Account ${id}`,
		refreshToken: `private-refresh-${id}`,
		accessToken: `private-access-${id}`,
		accountId: `upstream-account-${id}`,
		email: `${id}@private.invalid`,
		priority: 0,
		disabled: false,
		...overrides,
	};
}

function createManager(credentials: CodexCredential[] = []): {
	manager: CodexManager;
	credentialsPath: string;
} {
	const home = mkdtempSync(join(tmpdir(), "nf-provider-settings-targets-"));
	temporaryHomes.push(home);
	mkdirSync(join(home, ".narrafork"), { recursive: true });
	const credentialsPath = join(home, ".narrafork", "codex-credentials.json");
	writeSecretJSON(credentialsPath, credentials);
	const manager = new CodexManager({ homeDir: home, registerProcessHooks: false });
	managers.push(manager);
	return { manager, credentialsPath };
}

function noRead(): never {
	throw new Error(`${SECRET} ${PRIVATE_PATH}: this independent source must not be read`);
}

function assertNoSecrets(value: unknown) {
	const json = JSON.stringify(value);
	for (const secret of [
		SECRET,
		PRIVATE_PROXY,
		PRIVATE_PATH,
		CALLBACK_URL,
		"private-quota-token",
		"private-oauth-secret",
		"private-header-token",
	]) {
		expect(json).not.toContain(secret);
	}
	for (const key of [
		"apiKey",
		"config",
		"configSchema",
		"baseUrl",
		"proxy",
		"callback",
		"createAdapter",
		"refreshToken",
		"accessToken",
		"accountId",
		"network",
		"usageHistory",
	]) {
		expect(json).not.toContain(`"${key}"`);
	}
}

describe("saved provider settings target identities", () => {
	test("uses only canonical Custom API and NUG ids, never names, prefixes or derived protocol aliases", () => {
		const saved = {
			customApiProviders: [custom()],
			nugProviders: [nug()],
			openaiProviders: [custom({ id: "legacy-only", prefix: "legacy-prefix" })],
		};
		const targets = directory(saved);
		expect(targets.resolve("custom-api", "custom-1")).toMatchObject({
			status: "resolved",
			target: { kind: "custom-api", id: "custom-1" },
		});
		expect(targets.resolve("nug", "nug-1")).toMatchObject({
			status: "resolved",
			target: { kind: "nug", id: "nug-1" },
		});
		for (const id of [
			"Saved provider",
			"saved-prefix",
			"legacy-only",
			"legacy-prefix",
			"nug-1",
			"made-up-id",
		]) {
			expect(targets.resolve("custom-api", id)).toEqual({ status: "not-found" });
		}
		saved.customApiProviders = [];
		expect(targets.list("custom-api")).toEqual([]);
		expect(targets.resolve("custom-api", "legacy-only")).toEqual({ status: "not-found" });
	});

	test("a saved id survives prefix/name/protocol/key changes without inheriting another same-name provider", () => {
		const first = custom();
		const second = custom({ id: "custom-2", prefix: "second-prefix" });
		const saved = { customApiProviders: [first, second], nugProviders: [nug()] };
		const targets = directory(saved);
		Object.assign(first, {
			prefix: "renamed-prefix",
			name: "Renamed display",
			protocol: "anthropic-messages",
			apiKey: "rotated-private-key",
		});
		saved.nugProviders[0].prefix = "renamed-gateway";
		expect(targets.resolve("custom-api", "custom-1")).toMatchObject({
			status: "resolved",
			target: { id: "custom-1", name: "Renamed display" },
		});
		expect(targets.resolve("custom-api", "custom-2")).toMatchObject({
			target: { id: "custom-2", name: "Saved provider" },
		});
		expect(targets.resolve("nug", "nug-1")).toMatchObject({ target: { id: "nug-1" } });
		expect(targets.resolve("custom-api", "renamed-prefix")).toEqual({ status: "not-found" });
	});

	test("kind is part of identity even when every id, prefix and display name collides", () => {
		const registry = new PluginProviderRegistry();
		register(registry, { providerInstanceId: "shared-id", providerPrefix: "shared-prefix" });
		const saved = {
			customApiProviders: [custom({ id: "shared-id", prefix: "shared-prefix" })],
			nugProviders: [nug({ id: "shared-id", prefix: "shared-prefix", name: "Saved provider" })],
		};
		const targets = directory(saved, registry);
		for (const kind of ["custom-api", "nug", "executable-plugin"] as const) {
			expect(targets.resolve(kind, "shared-id")).toMatchObject({
				status: "resolved",
				target: { kind, id: "shared-id" },
			});
			expect(targets.resolve(kind, "shared-prefix")).toEqual({ status: "not-found" });
		}
		expect(targets.resolve("platform", "shared-id")).toEqual({ status: "invalid" });
	});

	test("executable providers use exact actual registrations and never the registry prefix/type fallback", () => {
		const registry = new PluginProviderRegistry();
		const entry = register(registry);
		register(registry, {
			localId: "other",
			providerInstanceId: "second-instance",
			providerPrefix: "second-plugin",
		});
		registry.register({
			kind: "builtin",
			providerInstanceId: "builtin-instance",
			providerPrefix: "builtin",
			displayName: "Builtin",
		});
		const get = spyOn(registry, "get").mockImplementation(noRead);
		const getConfig = spyOn(registry, "getConfig").mockImplementation(noRead);
		const targets = directory({}, registry);
		expect(targets.resolve("executable-plugin", entry.providerInstanceId)).toMatchObject({
			status: "resolved",
			target: { id: entry.providerInstanceId },
		});
		for (const id of [
			entry.providerPrefix,
			entry.displayName,
			entry.providerTypeId,
			"builtin-instance",
		]) {
			expect(targets.resolve("executable-plugin", id)).toEqual({ status: "not-found" });
		}
		registry.setProviderPrefix(entry.providerInstanceId, "renamed-plugin");
		expect(targets.resolve("executable-plugin", entry.providerInstanceId)).toMatchObject({
			status: "resolved",
			target: { id: entry.providerInstanceId },
		});
		expect(targets.list("executable-plugin")).toHaveLength(2);
		expect(get).not.toHaveBeenCalled();
		expect(getConfig).not.toHaveBeenCalled();
	});

	test("actual registry conflicts stay conflicts; a removed package generation cannot hit its replacement", () => {
		const registry = new PluginProviderRegistry();
		const original = register(registry);
		expect(() => register(registry, { providerInstanceId: "different-instance" })).toThrow(
			expect.objectContaining({ code: "PROVIDER_CONFLICT" }),
		);
		expect(() => register(registry, { providerPrefix: "different-prefix" })).toThrow(
			expect.objectContaining({ code: "PROVIDER_CONFLICT" }),
		);
		const targets = directory({}, registry);
		registry.removePlugin("com.example.saved");
		register(registry, { providerInstanceId: "com.example.saved/provider@generation-2" });
		expect(targets.resolve("executable-plugin", original.providerInstanceId)).toEqual({
			status: "not-found",
		});
		expect(
			targets.resolve("executable-plugin", "com.example.saved/provider@generation-2"),
		).toMatchObject({ status: "resolved" });
	});

	test("disabled, runtime-unavailable and missing targets are distinct without leaking failure text", () => {
		const registry = new PluginProviderRegistry();
		const entry = register(registry);
		const saved = {
			customApiProviders: [custom({ disabled: true })],
			nugProviders: [nug({ disabled: true })],
			agent: { disabledProviders: [] as string[] },
		};
		const targets = directory(saved, registry);
		for (const [kind, id] of [
			["custom-api", "custom-1"],
			["nug", "nug-1"],
		] as const) {
			expect(targets.resolve(kind, id)).toMatchObject({
				status: "disabled",
				target: { disabled: true, available: false },
			});
			expect(targets.resolve(kind, "missing-id")).toEqual({ status: "not-found" });
		}
		registry.markUnavailable(
			entry.providerInstanceId,
			`${SECRET}: runtime failure at ${PRIVATE_PATH}`,
		);
		const unavailable = targets.resolve("executable-plugin", entry.providerInstanceId);
		expect(unavailable).toMatchObject({
			status: "unavailable",
			target: { disabled: false, available: false },
		});
		assertNoSecrets(unavailable);
		registry.enablePlugin("com.example.saved");
		saved.agent.disabledProviders = [entry.providerPrefix];
		expect(targets.resolve("executable-plugin", entry.providerInstanceId)).toMatchObject({
			status: "disabled",
		});
		saved.agent.disabledProviders = [];
		registry.setPluginState("com.example.saved", { desiredState: "disabled" });
		expect(targets.resolve("executable-plugin", entry.providerInstanceId)).toMatchObject({
			status: "disabled",
		});
		registry.removePlugin("com.example.saved");
		expect(targets.resolve("executable-plugin", entry.providerInstanceId)).toEqual({
			status: "not-found",
		});
	});

	test("duplicates fail closed instead of first/last/name/prefix winning, but unrelated kinds remain independent", () => {
		const saved = {
			customApiProviders: [
				custom({ id: "duplicate", prefix: "one" }),
				custom({ id: "duplicate", prefix: "two", disabled: true }),
				custom({ id: "unique" }),
			],
			nugProviders: [nug({ id: "duplicate" })],
		};
		const targets = directory(saved);
		expect(targets.resolve("custom-api", "duplicate")).toEqual({ status: "ambiguous" });
		expect(targets.list("custom-api").map((target) => target.id)).toEqual(["unique"]);
		expect(targets.resolve("nug", "duplicate")).toMatchObject({
			status: "resolved",
			target: { kind: "nug" },
		});
		const registry = new PluginProviderRegistry();
		const entry = register(registry);
		const duplicatedRegistration = directory({}, registry, {
			listPluginProviders: () => [entry, entry],
		});
		expect(duplicatedRegistration.resolve("executable-plugin", entry.providerInstanceId)).toEqual({
			status: "ambiguous",
		});
		expect(duplicatedRegistration.list("executable-plugin")).toEqual([]);
	});

	test("malicious ids, inherited records, accessors and object-valued labels cannot acquire an identity or run callbacks", () => {
		const callback = mock(noRead);
		const spoof = Object.create({ id: "inherited-id", name: SECRET, prefix: "spoofed-prefix" });
		const accessor = Object.defineProperty({}, "id", { get: callback });
		const saved = {
			customApiProviders: [
				custom(),
				spoof,
				accessor,
				custom({ id: "object-name", name: { toJSON: callback } as never }),
				custom({ id: "unsafe-disabled", disabled: "false" as never }),
			],
		};
		const targets = directory(saved);
		for (const id of [
			undefined,
			null,
			{},
			[],
			true,
			{ toString: callback },
			"",
			" custom-1",
			"custom-1 ",
			"__proto__",
			"constructor",
			"prototype",
			"a\u0000b",
			"a".repeat(129),
		]) {
			expect(targets.resolve("custom-api", id)).toEqual({ status: "invalid" });
		}
		expect(targets.resolve("custom-api", "inherited-id")).toEqual({ status: "not-found" });
		expect(targets.resolve("custom-api", "unsafe-disabled")).toEqual({
			status: "source-unavailable",
		});
		expect(targets.resolve("custom-api", "object-name")).toMatchObject({
			target: { name: "object-name" },
		});
		assertNoSecrets(targets.list("custom-api"));
		expect(callback).not.toHaveBeenCalled();
	});

	test("invalid input performs zero source reads and source errors never become empty or missing success", () => {
		const read = mock(noRead);
		const targets = directory({}, undefined, {
			getSettings: read,
			listPluginProviders: read,
			getCodexManager: read,
			getCommandCodeAuth: read,
		});
		expect(targets.resolve("unknown-kind", "custom-1")).toEqual({ status: "invalid" });
		expect(targets.resolve("platform", "CommandCode")).toEqual({ status: "invalid" });
		expect(targets.resolve("executable-plugin", { id: "fake" })).toEqual({ status: "invalid" });
		expect(read).not.toHaveBeenCalled();
		expect(targets.resolve("custom-api", "custom-1")).toEqual({ status: "source-unavailable" });
		try {
			targets.list("custom-api");
			throw new Error("failed source was accepted");
		} catch (error) {
			expect(error).toBeInstanceOf(AppError);
			expect(error).toMatchObject({ code: "PROVIDER_TARGET_SOURCE_UNAVAILABLE", statusCode: 503 });
			expect(String(error)).not.toContain(SECRET);
			expect(String(error)).not.toContain(PRIVATE_PATH);
		}
	});

	test("each target kind reads only its authoritative source, even when another saved kind is corrupt", () => {
		const saved = { customApiProviders: [custom()], nugProviders: [nug()] };
		const targets = directory(saved, undefined, {
			listPluginProviders: noRead,
			getCodexManager: noRead,
			getCommandCodeAuth: noRead,
		});
		expect(targets.resolve("custom-api", "custom-1")).toMatchObject({ status: "resolved" });
		expect(targets.resolve("nug", "nug-1")).toMatchObject({ status: "resolved" });
		expect(targets.list("custom-api")).toHaveLength(1);
		const corruptCustom = directory({
			customApiProviders: "corrupt" as never,
			nugProviders: [nug()],
		});
		expect(corruptCustom.resolve("nug", "nug-1")).toMatchObject({ status: "resolved" });
		expect(corruptCustom.resolve("custom-api", "custom-1")).toEqual({
			status: "source-unavailable",
		});
	});

	test("the DTO is a frozen primitive allowlist and serialized JSON contains no credentials/config/paths/proxies/callbacks", () => {
		const registry = new PluginProviderRegistry();
		const entry = register(registry);
		const targets = directory({ customApiProviders: [custom()], nugProviders: [nug()] }, registry);
		for (const kind of ["custom-api", "nug", "executable-plugin"] as const) {
			const list = targets.list(kind);
			expect(Object.isFrozen(list)).toBe(true);
			for (const dto of list) {
				expect(Object.keys(dto).sort()).toEqual(["available", "disabled", "id", "kind", "name"]);
				expect(Object.isFrozen(dto)).toBe(true);
			}
			assertNoSecrets(list);
		}
		assertNoSecrets(targets.resolve("executable-plugin", entry.providerInstanceId));
	});

	test("over-budget sources are rejected before truncation could hide a later duplicate", () => {
		const saved = {
			customApiProviders: Array.from({ length: MAX_PROVIDER_SETTINGS_TARGETS + 1 }, (_, index) =>
				custom({ id: index === MAX_PROVIDER_SETTINGS_TARGETS ? "custom-0" : `custom-${index}` }),
			),
		};
		const targets = directory(saved);
		expect(targets.resolve("custom-api", "custom-0")).toEqual({ status: "limit-exceeded" });
		expect(() => targets.list("custom-api")).toThrow(
			expect.objectContaining({ code: "PROVIDER_TARGET_LIMIT_EXCEEDED" }),
		);
	});
});

describe("target output budgets", () => {
	test("bounded labels cannot smuggle serialized configs and over-budget UTF-8 output fails explicitly", () => {
		const serialized = JSON.stringify({ apiKey: SECRET, path: PRIVATE_PATH });
		const registry = new PluginProviderRegistry();
		register(registry, { displayName: serialized });
		const targets = directory(
			{
				customApiProviders: [
					custom({ name: serialized }),
					custom({ id: "long-name", name: "长".repeat(100_000) }),
				],
			},
			registry,
		);
		assertNoSecrets(targets.list("custom-api"));
		assertNoSecrets(targets.list("executable-plugin"));
		expect(targets.resolve("custom-api", "long-name")).toMatchObject({
			target: { name: "长".repeat(160) },
		});
		const large = directory({
			customApiProviders: Array.from({ length: MAX_PROVIDER_SETTINGS_TARGETS }, (_, index) =>
				custom({ id: `id-${index}`, name: "长".repeat(160) }),
			),
		});
		expect(large.resolve("custom-api", "id-0")).toMatchObject({ status: "resolved" });
		expect(() => large.list("custom-api")).toThrow(
			expect.objectContaining({ code: "PROVIDER_TARGET_LIMIT_EXCEEDED" }),
		);
	});
});

describe("real platform settings slots", () => {
	test("unsaved/default/cleared platform connections are absent, not invented by fixed model prefixes", () => {
		const targets = directory({
			commandCode: {},
			tokendance: { apiKey: "", disabled: false, generation: 7 },
		});
		expect(targets.list("platform")).toEqual([]);
		for (const id of Object.values(PROVIDER_SETTINGS_SINGLETON_IDS)) {
			expect(targets.resolve("platform", id)).toEqual({ status: "not-found" });
		}
		expect(targets.resolve("platform", codexProviderSettingsTargetId("missing-account"))).toEqual({
			status: "not-found",
		});
	});

	test("Command Code settings and CLI are explicit aliases of one stable singleton, never userName/userId/prefix identities", () => {
		const saved = { commandCode: { apiKey: "", disabled: false } };
		let auth = {
			credential: {
				token: SECRET,
				source: "cli" as "cli" | "settings",
				userName: "Same display",
				userId: "private-user-id",
			},
		};
		const targets = directory(saved, undefined, { getCommandCodeAuth: () => auth });
		expect(targets.resolve("platform", PROVIDER_SETTINGS_SINGLETON_IDS.commandcode)).toMatchObject({
			status: "resolved",
			target: { id: "commandcode:singleton" },
		});
		saved.commandCode.apiKey = "rotated-private-key";
		auth = {
			credential: {
				token: "rotated-private-key",
				source: "settings",
				userName: "Different display",
				userId: "different-user-id",
			},
		};
		expect(targets.list("platform").map((target) => target.id)).toEqual(["commandcode:singleton"]);
		for (const id of [
			"CommandCode",
			"commandcode",
			"Same display",
			"private-user-id",
			"CommandCode:singleton",
		]) {
			expect(targets.resolve("platform", id)).toEqual({ status: "invalid" });
		}
		assertNoSecrets(targets.list("platform"));
	});

	test("actual Command Code token resolver uses saved credentials without starting a host or reading CLI auth", () => {
		const targets = directory({ commandCode: { apiKey: SECRET, disabled: true } }, undefined, {
			getCommandCodeAuth: resolveCommandCodeToken,
		});
		const result = targets.resolve("platform", PROVIDER_SETTINGS_SINGLETON_IDS.commandcode);
		expect(result).toMatchObject({
			status: "disabled",
			target: { disabled: true, available: false },
		});
		assertNoSecrets(result);
	});

	test("TokenDance key/generation rotation does not change singleton identity and other platform readers are independent", () => {
		const saved = { tokendance: { apiKey: SECRET, disabled: false, generation: 1 } };
		const targets = directory(saved, undefined, {
			getCodexManager: noRead,
			getCommandCodeAuth: noRead,
		});
		expect(targets.resolve("platform", PROVIDER_SETTINGS_SINGLETON_IDS.tokendance)).toMatchObject({
			status: "resolved",
		});
		Object.assign(saved.tokendance, { apiKey: "new-private-key", generation: 500, disabled: true });
		const disabled = targets.resolve("platform", PROVIDER_SETTINGS_SINGLETON_IDS.tokendance);
		expect(disabled).toMatchObject({ status: "disabled", target: { id: "tokendance:singleton" } });
		assertNoSecrets(disabled);
		saved.tokendance.apiKey = "";
		expect(targets.resolve("platform", PROVIDER_SETTINGS_SINGLETON_IDS.tokendance)).toEqual({
			status: "not-found",
		});
		expect(() => targets.list("platform")).toThrow(
			expect.objectContaining({ code: "PROVIDER_TARGET_SOURCE_UNAVAILABLE" }),
		);
	});

	test("a failed CLI auth read is source-unavailable, not an invented target or a missing success", () => {
		const targets = directory({}, undefined, {
			getCommandCodeAuth: () => ({ reason: "read_failed" }),
		});
		expect(targets.resolve("platform", PROVIDER_SETTINGS_SINGLETON_IDS.commandcode)).toEqual({
			status: "source-unavailable",
		});
		expect(() => targets.list("platform")).toThrow(
			expect.objectContaining({ code: "PROVIDER_TARGET_SOURCE_UNAVAILABLE" }),
		);
	});
});

describe("Codex saved identity projections", () => {
	test("real persisted credential ids and the default pool have distinct stable identities, even for account id 'pool'", () => {
		const { manager } = createManager([
			credential("pool"),
			credential("second", { displayName: "Account pool" }),
		]);
		const targets = directory({}, undefined, { getCodexManager: () => manager });
		const pool = targets.resolve("platform", PROVIDER_SETTINGS_SINGLETON_IDS.codex);
		const account = targets.resolve("platform", codexProviderSettingsTargetId("pool"));
		expect(pool).toMatchObject({ status: "resolved", target: { id: "codex:pool" } });
		expect(account).toMatchObject({ status: "resolved", target: { id: "codex:credential:pool" } });
		expect(pool).not.toEqual(account);
		manager.updateCredential("pool", { displayName: "Renamed account" });
		expect(targets.resolve("platform", "codex:credential:pool")).toMatchObject({
			target: { id: "codex:credential:pool", name: "Renamed account" },
		});
		for (const id of [
			"pool",
			"upstream-account-pool",
			"pool@private.invalid",
			"Renamed account",
			"codex:pool-old",
			"codex:credential:fake-id",
		]) {
			const result = targets.resolve("platform", id);
			expect(result.status === "invalid" || result.status === "not-found").toBe(true);
		}
	});

	test("runtime-only legacy account ids are not saved targets until an explicit successful credential save", () => {
		const { manager, credentialsPath } = createManager([
			credential("legacy", { id: undefined as never }),
		]);
		const before = readFileSync(credentialsPath);
		const runtimeId = (manager as unknown as { entries: CodexCredential[] }).entries[0].id;
		const targets = directory({}, undefined, { getCodexManager: () => manager });
		expect(targets.resolve("platform", codexProviderSettingsTargetId(runtimeId))).toEqual({
			status: "not-found",
		});
		expect(targets.resolve("platform", "codex:pool")).toMatchObject({ status: "resolved" });
		expect(() => targets.list("platform")).toThrow(
			expect.objectContaining({ code: "PROVIDER_TARGET_SOURCE_UNAVAILABLE" }),
		);
		expect(readFileSync(credentialsPath)).toEqual(before);
		manager.updateCredential(runtimeId, { displayName: "Saved identity" });
		expect(targets.resolve("platform", codexProviderSettingsTargetId(runtimeId))).toMatchObject({
			status: "resolved",
			target: { name: "Saved identity" },
		});
	});

	test("unsaved new accounts are not invented by a failed credential write", () => {
		const { manager } = createManager();
		(manager as unknown as { credentialsUnreadable: boolean }).credentialsUnreadable = true;
		manager.importCredentials([{ accessToken: "unsaved-access-token" }]);
		const runtimeId = (manager as unknown as { entries: CodexCredential[] }).entries[0].id;
		const targets = directory({}, undefined, { getCodexManager: () => manager });
		expect(targets.resolve("platform", codexProviderSettingsTargetId(runtimeId))).toEqual({
			status: "not-found",
		});
		expect(targets.resolve("platform", "codex:pool")).toEqual({ status: "source-unavailable" });
	});

	test("exact credential lookup never enumerates, refreshes, self-heals, snapshots, exports or fetches", () => {
		const { manager, credentialsPath } = createManager([
			credential("saved-a", {
				disabled: true,
				disabledReason: "quota_exhausted",
				quotaResetsAt: Date.now() - 10_000,
			}),
			credential("saved-b"),
		]);
		const originalBytes = readFileSync(credentialsPath);
		const snapshot = spyOn(manager, "snapshot").mockImplementation(noRead);
		const exporting = spyOn(manager, "exportForTransfer").mockImplementation(noRead);
		const enumerate = spyOn(manager, "listProviderSettingsIdentities").mockImplementation(noRead);
		const acquire = spyOn(manager, "acquireContext").mockImplementation(noRead);
		const fetch = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(() => noRead(), { preconnect: noRead }),
		);
		const targets = directory({}, undefined, { getCodexManager: () => manager });
		expect(targets.resolve("platform", codexProviderSettingsTargetId("saved-a"))).toMatchObject({
			status: "disabled",
			target: { disabled: true },
		});
		expect(targets.resolve("platform", codexProviderSettingsTargetId("saved-b"))).toMatchObject({
			status: "resolved",
		});
		expect(manager.getProviderSettingsIdentity("saved-a")).toMatchObject({
			status: "found",
			identity: { disabled: true },
		});
		expect(readFileSync(credentialsPath)).toEqual(originalBytes);
		for (const spy of [snapshot, exporting, enumerate, acquire, fetch])
			expect(spy).not.toHaveBeenCalled();
	});

	test("identity pages are bounded, immutable and credential-free; archived/disabled identities remain distinguishable", () => {
		const { manager } = createManager([
			credential("first"),
			credential("second", { disabled: true }),
			credential("third", { archivedAt: 123 }),
		]);
		const first = manager.listProviderSettingsIdentities({ limit: 2 });
		expect(first).toMatchObject({ status: "ok", nextOffset: 2 });
		if (first.status !== "ok") throw new Error("missing first identity page");
		expect(first.identities.map((identity) => identity.id)).toEqual(["first", "second"]);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.identities)).toBe(true);
		for (const identity of first.identities) expect(Object.isFrozen(identity)).toBe(true);
		const second = manager.listProviderSettingsIdentities({
			offset: first.nextOffset ?? 0,
			limit: 2,
		});
		expect(second).toMatchObject({
			status: "ok",
			nextOffset: null,
			identities: [{ id: "third", archivedAt: 123 }],
		});
		assertNoSecrets([first, second]);
		for (const options of [
			{ limit: 0 },
			{ limit: MAX_CODEX_PROVIDER_SETTINGS_PAGE_SIZE + 1 },
			{ offset: -1 },
			{ offset: Number.NaN },
		]) {
			expect(manager.listProviderSettingsIdentities(options)).toEqual({ status: "invalid" });
		}
		const targets = directory({}, undefined, { getCodexManager: () => manager });
		expect(targets.resolve("platform", "codex:credential:second")).toMatchObject({
			status: "disabled",
		});
		expect(targets.resolve("platform", "codex:credential:third")).toMatchObject({
			status: "unavailable",
			target: { disabled: false, available: false },
		});
		expect(targets.resolve("platform", "codex:credential:missing")).toEqual({
			status: "not-found",
		});
		assertNoSecrets(targets.list("platform"));
	});

	test("identity reads do not touch token/history/network fields and reject malformed saved lifecycle state", () => {
		const { manager } = createManager([
			credential("guarded", { displayName: JSON.stringify({ apiKey: SECRET }) }),
		]);
		const raw = (manager as unknown as { entries: CodexCredential[] }).entries[0];
		const readSecretOrLargeField = mock(noRead);
		for (const key of [
			"refreshToken",
			"accessToken",
			"agentPrivateKey",
			"network",
			"usage",
			"usageHistory",
		]) {
			Object.defineProperty(raw, key, { get: readSecretOrLargeField, configurable: true });
		}
		assertNoSecrets(manager.getProviderSettingsIdentity("guarded"));
		assertNoSecrets(manager.listProviderSettingsIdentities());
		expect(manager.getProviderSettingsPoolIdentity()).toMatchObject({ status: "ok", exists: true });
		expect(readSecretOrLargeField).not.toHaveBeenCalled();
		const malformed = createManager([
			credential("bad-archive", { archivedAt: -1 }),
			credential("bad-flag", { disabled: "false" as never }),
		]).manager;
		expect(malformed.getProviderSettingsIdentity("bad-archive")).toEqual({ status: "invalid" });
		expect(malformed.getProviderSettingsIdentity("bad-flag")).toEqual({ status: "invalid" });
		expect(malformed.getProviderSettingsPoolIdentity()).toEqual({ status: "invalid" });
		expect(
			directory({}, undefined, { getCodexManager: () => malformed }).resolve(
				"platform",
				"codex:credential:bad-archive",
			),
		).toEqual({ status: "source-unavailable" });
	});

	test("actual identity listing consumes bounded pages while exact lookup remains independent of enumeration", () => {
		const { manager } = createManager(
			Array.from({ length: 401 }, (_, index) => credential(`account-${index}`)),
		);
		const enumerate = spyOn(manager, "listProviderSettingsIdentities");
		const targets = directory({}, undefined, { getCodexManager: () => manager });
		const list = targets.list("platform");
		expect(list).toHaveLength(402);
		expect(enumerate).toHaveBeenCalledTimes(3);
		for (const [options] of enumerate.mock.calls)
			expect(options?.limit).toBeLessThanOrEqual(MAX_CODEX_PROVIDER_SETTINGS_PAGE_SIZE);
		expect(targets.resolve("platform", "codex:credential:account-400")).toMatchObject({
			status: "resolved",
		});
		expect(enumerate).toHaveBeenCalledTimes(3);
		assertNoSecrets(list);
	});

	test("duplicate persisted Codex ids fail closed instead of selecting the current/first account", () => {
		const { manager } = createManager([
			credential("duplicate", {
				refreshToken: "refresh-one",
				accessToken: "access-one",
				accountId: "upstream-one",
				email: "one@private.invalid",
			}),
			credential("duplicate", {
				refreshToken: "refresh-two",
				accessToken: "access-two",
				accountId: "upstream-two",
				email: "two@private.invalid",
			}),
		]);
		expect(manager.getProviderSettingsIdentity("duplicate")).toEqual({ status: "ambiguous" });
		expect(manager.getProviderSettingsPoolIdentity()).toEqual({ status: "ambiguous" });
		const targets = directory({}, undefined, { getCodexManager: () => manager });
		expect(targets.resolve("platform", "codex:credential:duplicate")).toEqual({
			status: "ambiguous",
		});
		expect(targets.resolve("platform", "codex:pool")).toEqual({ status: "ambiguous" });
		expect(targets.list("platform")).toEqual([]);
	});

	test("pool lifecycle is not a credential alias and an archived-only store has no default pool target", () => {
		const { manager } = createManager([credential("retired", { archivedAt: 123 })]);
		const saved = { agent: { disabledProviders: [] as string[] } };
		const targets = directory(saved, undefined, { getCodexManager: () => manager });
		expect(targets.resolve("platform", "codex:pool")).toEqual({ status: "not-found" });
		expect(targets.resolve("platform", "codex:credential:retired")).toMatchObject({
			status: "unavailable",
		});
		manager.unarchiveCredential("retired");
		expect(targets.resolve("platform", "codex:pool")).toMatchObject({ status: "resolved" });
		saved.agent.disabledProviders = ["codex"];
		expect(targets.resolve("platform", "codex:pool")).toMatchObject({ status: "disabled" });
		expect(targets.resolve("platform", "codex:credential:retired")).toMatchObject({
			status: "disabled",
		});
	});

	test("a compromised reader cannot return another account or advance a page past hidden identities", () => {
		const wrongIdentity: ProviderSettingsCodexReader = {
			...EMPTY_CODEX,
			getProviderSettingsIdentity: () => ({
				status: "found",
				identity: { id: "wrong-account", disabled: false },
			}),
		};
		const targets = directory({}, undefined, { getCodexManager: () => wrongIdentity });
		expect(targets.resolve("platform", "codex:credential:requested")).toEqual({
			status: "source-unavailable",
		});
		const badCursor: ProviderSettingsCodexReader = {
			...EMPTY_CODEX,
			listProviderSettingsIdentities: () => ({
				status: "ok",
				identities: [{ id: "first", disabled: false }],
				nextOffset: 100,
			}),
		};
		expect(() =>
			directory({}, undefined, { getCodexManager: () => badCursor }).list("platform"),
		).toThrow(expect.objectContaining({ code: "PROVIDER_TARGET_SOURCE_UNAVAILABLE" }));
	});

	test("scan and output budgets fail explicitly, never falling back to snapshot/export or truncating duplicates", () => {
		const { manager } = createManager();
		// Explicit test injection into the same real manager; production has no bypass or fallback.
		(manager as unknown as { entries: CodexCredential[] }).entries = Array.from(
			{ length: MAX_CODEX_PROVIDER_SETTINGS_SCAN + 1 },
			(_, index) => credential(`id-${index}`),
		);
		expect(manager.getProviderSettingsIdentity("id-0")).toEqual({ status: "limit-exceeded" });
		expect(manager.listProviderSettingsIdentities()).toEqual({ status: "limit-exceeded" });
		expect(manager.getProviderSettingsPoolIdentity()).toEqual({ status: "limit-exceeded" });
		const targets = directory({ customApiProviders: [custom()] }, undefined, {
			getCodexManager: () => manager,
		});
		expect(targets.resolve("platform", "codex:credential:id-0")).toEqual({
			status: "limit-exceeded",
		});
		expect(targets.resolve("custom-api", "custom-1")).toMatchObject({ status: "resolved" });
		expect(() => targets.list("platform")).toThrow(
			expect.objectContaining({ code: "PROVIDER_TARGET_LIMIT_EXCEEDED" }),
		);
	});

	test("default exported resolver reads actual isolated settings, actual registry registrations and the injected real manager", () => {
		const { manager } = createManager([credential("host-account")]);
		__setCodexManagerForTests(manager);
		installedTestManager = true;
		settings.customApiProviders = [custom({ id: "host-custom" })];
		settings.nugProviders = [nug({ id: "host-nug" })];
		settings.commandCode = { apiKey: SECRET, disabled: false };
		settings.tokendance = { apiKey: SECRET, disabled: false, generation: 12 };
		settings.agent.disabledProviders = [];
		const plugin = register(pluginProviderRegistry);
		expect(
			resolveProviderSettingsTarget("executable-plugin", plugin.providerInstanceId),
		).toMatchObject({
			status: "resolved",
			target: { kind: "executable-plugin", id: plugin.providerInstanceId },
		});
		const result = resolveProviderSettingsTarget("platform", "codex:credential:host-account");
		expect(result).toMatchObject({
			status: "resolved",
			target: { kind: "platform", id: "codex:credential:host-account" },
		});
		expect(resolveProviderSettingsTarget("custom-api", "host-custom")).toMatchObject({
			status: "resolved",
		});
		expect(resolveProviderSettingsTarget("nug", "host-nug")).toMatchObject({ status: "resolved" });
		expect(listProviderSettingsTargets("platform").map((target) => target.id)).toEqual([
			"codex:pool",
			"codex:credential:host-account",
			"commandcode:singleton",
			"tokendance:singleton",
		]);
		assertNoSecrets(listProviderSettingsTargets("platform"));
	});
});
