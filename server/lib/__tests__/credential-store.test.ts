import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CodexCredential,
	CodexManager,
	codexFromCredential,
	codexToCredential,
} from "../codex-manager";
import {
	CREDENTIALS_FILE,
	type CredentialsFile,
	getCredentialStore,
	resetCredentialStoresForTests,
} from "../credential-store";
import { pluginProviderSecrets, savePluginProviderSecrets } from "../plugin-credentials";
import {
	COMMAND_CODE_KEY_OWNER,
	nugKeyOwner,
	nugOAuthKeyOwner,
	ProviderKeyStore,
	quotaKeyOwner,
	searchKeyOwner,
	TOKENDANCE_KEY_OWNER,
} from "../provider-keys";
import * as secretStore from "../secret-store";
import { changeSecretEncryption, readSecretJSON, SecretStoreError } from "../secret-store";

const dirs: string[] = [];
const managers: CodexManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	resetCredentialStoresForTests();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A NarraFork home already on credentials.json. CodexManager takes `homeDir`. */
function unifiedHome() {
	const homeDir = mkdtempSync(join(tmpdir(), "narrafork-credentials-"));
	dirs.push(homeDir);
	const dir = join(homeDir, ".narrafork");
	mkdirSync(dir, { recursive: true });
	getCredentialStore(dir).create({ version: 1, credentials: [], groupSecrets: {} });
	return {
		homeDir,
		dir,
		file: () => readSecretJSON(join(dir, CREDENTIALS_FILE)) as CredentialsFile,
		keys: () => new ProviderKeyStore(join(dir, "provider-keys.json")),
		codex: () => {
			const manager = new CodexManager({ homeDir, registerProcessHooks: false });
			managers.push(manager);
			return manager;
		},
		/** As after a restart: owners read the files again. */
		restart: () => {
			for (const manager of managers.splice(0)) manager.dispose();
			resetCredentialStoresForTests();
		},
	};
}

const account = (id: string, extra: Partial<CodexCredential> = {}) => ({
	id,
	refreshToken: `rt-${id}`,
	accessToken: `at-${id}`,
	accountId: `acc-${id}`,
	email: `${id}@example.com`,
	...extra,
});

describe("Codex accounts in credentials.json", () => {
	const oauth: CodexCredential = {
		id: "oauth-1",
		displayName: "Work",
		refreshToken: "rt-1",
		accessToken: "at-1",
		expiresAt: 1_800_000_000_000,
		accountId: "acc-1",
		email: "work@example.com",
		sub: "user-1",
		priority: 0,
		useCreditQuota: true,
		disabled: true,
		disabledReason: "manual",
		archivedAt: 1_700_000_000_000,
		network: {
			proxy: { mode: "custom", url: "http://127.0.0.1:8080" },
			userAgentMode: "codex",
			extraHeaders: { "x-team": "a" },
			deviceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
		},
		createdAt: 1_600_000_000_000,
	};
	const pat: CodexCredential = {
		id: "pat-1",
		authMode: "personal_access_token",
		accessToken: "at-pat",
		accountId: "acc-2",
		email: "pat@example.com",
		fedramp: true,
		priority: 1,
		disabled: true,
		disabledReason: "banned",
		createdAt: 1_600_000_000_001,
	};
	const agent: CodexCredential = {
		id: "agent-1",
		displayName: "Agent",
		authMode: "agent_identity",
		agentRuntimeId: "runtime-1",
		agentPrivateKey: "private-key",
		taskId: "task-1",
		accountId: "acc-3",
		sub: "user-3",
		fedramp: false,
		priority: 2,
		useCreditQuota: false,
		disabled: false,
		createdAt: 1_600_000_000_002,
	};

	test("every stored field of each sign-in kind survives the round trip", () => {
		for (const credential of [oauth, pat, agent]) {
			expect(codexFromCredential(codexToCredential(credential))).toEqual(credential);
		}
		expect(codexToCredential(oauth)).toEqual({
			id: "oauth-1",
			target: { groupId: "codex" },
			ownerUserId: null,
			label: "Work",
			priority: 0,
			createdAt: 1_600_000_000_000,
			archivedAt: 1_700_000_000_000,
			disabled: true,
			disabledReason: "manual",
			network: oauth.network,
			auth: {
				kind: "oauth",
				refreshToken: "rt-1",
				accessToken: "at-1",
				expiresAt: 1_800_000_000_000,
			},
			account: { accountId: "acc-1", email: "work@example.com", sub: "user-1" },
			options: { useCreditQuota: true },
		});
		expect(codexToCredential(pat).auth).toEqual({ kind: "pat", accessToken: "at-pat" });
		expect(codexToCredential(agent).auth).toEqual({
			kind: "agent_identity",
			agentRuntimeId: "runtime-1",
			agentPrivateKey: "private-key",
			taskId: "task-1",
		});
	});

	test("runtime state stays out; an account without createdAt gets the given time", () => {
		const credential = codexToCredential(
			{
				...account("busy"),
				priority: 0,
				disabled: true,
				disabledReason: "quota_exhausted",
				quotaResetsAt: 5,
				usage: { plan_type: "plus" } as CodexCredential["usage"],
				usageHistory: [],
			},
			42,
		);
		expect(credential).not.toHaveProperty("disabled");
		expect(credential).not.toHaveProperty("disabledReason");
		expect(JSON.stringify(credential)).not.toMatch(/usage|quotaResetsAt|plan_type/);
		expect(credential.createdAt).toBe(42);
	});

	test("a manager on credentials.json writes nothing else and reloads the same accounts", () => {
		const home = unifiedHome();
		const manager = home.codex();
		manager.importFromTransfer([account("a"), account("b")], () => "add");
		manager.setDisabled("b", true);
		const before = manager.exportForTransfer();
		expect(existsSync(join(home.dir, "codex-credentials.json"))).toBe(false);
		expect(home.file().credentials.map((c) => [c.id, c.target.groupId])).toEqual([
			["a", "codex"],
			["b", "codex"],
		]);
		const createdAt = home.file().credentials[0]?.createdAt;
		manager.setPriority("a", 3);
		// Set once, then kept: later saves do not move it.
		expect(home.file().credentials[0]?.createdAt).toBe(createdAt as number);

		home.restart();
		const reloaded = home.codex().exportForTransfer();
		expect(reloaded).toEqual(
			before.map((c) => ({ ...c, priority: c.id === "a" ? 3 : c.priority, createdAt })),
		);
	});
});

describe("model keys in credentials.json", () => {
	test("every owner kind is filed under its group, and loads back the same", () => {
		const home = unifiedHome();
		const store = home.keys();
		store.syncFirstKeys(
			[
				{ id: "conn", apiKey: "sk-1" },
				{ id: quotaKeyOwner("conn"), apiKey: "site-token" },
				{ id: nugKeyOwner("gw"), apiKey: "nug-key" },
				{ id: nugOAuthKeyOwner("gw"), apiKey: "oauth-secret" },
				{ id: TOKENDANCE_KEY_OWNER, apiKey: "td-key" },
				{ id: COMMAND_CODE_KEY_OWNER, apiKey: "cc-key" },
				{ id: searchKeyOwner("web"), apiKey: "search-key" },
			],
			{ clearOnEmpty: false },
		);
		const second = store.add("conn", {
			apiKey: "sk-2",
			label: "backup",
			network: { userAgentMode: "claude-code" },
		});
		store.update(second.id, { disabled: true, disabledReason: "invalid" });

		const file = home.file();
		expect(file.credentials.map((c) => [c.id, c.target.groupId, c.auth])).toEqual([
			["conn", "conn", { kind: "api_key", apiKey: "sk-1" }],
			["gw", "gw", { kind: "api_key", apiKey: "nug-key" }],
			["tokendance", "tokendance", { kind: "api_key", apiKey: "td-key" }],
			["CommandCode", "CommandCode", { kind: "api_key", apiKey: "cc-key" }],
			[second.id, "conn", { kind: "api_key", apiKey: "sk-2" }],
		]);
		expect(file.credentials.at(-1)).toMatchObject({
			label: "backup",
			priority: 1,
			disabled: true,
			disabledReason: "invalid",
			network: { userAgentMode: "claude-code" },
			ownerUserId: null,
		});
		expect(file.groupSecrets).toEqual({
			conn: { quotaAccessToken: "site-token" },
			gw: { oauthClientSecret: "oauth-secret" },
		});
		// The old owner namespaces stay in the facade; search keys stay in provider-keys.json.
		expect(JSON.stringify(file)).not.toMatch(/nug:|nug-oauth:|builtin:|quota:|search/);
		expect(readSecretJSON(join(home.dir, "provider-keys.json"))).toEqual([
			expect.objectContaining({ providerId: "search:web", apiKey: "search-key" }),
		]);

		const owners = [
			"conn",
			quotaKeyOwner("conn"),
			nugKeyOwner("gw"),
			nugOAuthKeyOwner("gw"),
			TOKENDANCE_KEY_OWNER,
			COMMAND_CODE_KEY_OWNER,
			searchKeyOwner("web"),
		];
		const view = (s: ProviderKeyStore) =>
			owners.map((owner) =>
				s.list(owner).map(({ id, apiKey, label, priority, disabled, disabledReason, network }) => ({
					id,
					apiKey,
					label,
					priority,
					disabled,
					disabledReason,
					network,
				})),
			);
		const before = view(store);
		home.restart();
		const reloaded = home.keys();
		expect(view(reloaded)).toEqual(before);
		expect(reloaded.firstKey(nugKeyOwner("gw"))).toBe("nug-key");
		expect(reloaded.firstKey(quotaKeyOwner("conn"))).toBe("site-token");

		reloaded.removeProvider(quotaKeyOwner("conn"));
		reloaded.removeProvider(searchKeyOwner("web"));
		expect(home.file().groupSecrets).toEqual({ gw: { oauthClientSecret: "oauth-secret" } });
		expect(existsSync(join(home.dir, "provider-keys.json"))).toBe(false);
	});

	test("Codex and key saves interleave without losing either; Codex never wakes key listeners", () => {
		const home = unifiedHome();
		const manager = home.codex();
		const keys = home.keys();
		let changes = 0;
		keys.onChange(() => changes++);

		manager.importFromTransfer([account("a")], () => "add");
		keys.add("conn", { apiKey: "sk-1" });
		manager.setDisabled("a", true);
		const second = keys.add("conn", { apiKey: "sk-2" });
		manager.importFromTransfer([account("b")], () => "add");
		keys.update(second.id, { label: "two" });

		expect(changes).toBe(3);
		expect(home.file().credentials.map((c) => c.id)).toEqual([
			"a",
			"b",
			expect.any(String),
			second.id,
		]);
		expect(home.file().credentials.find((c) => c.id === "a")?.disabled).toBe(true);
		home.restart();
		expect(
			home
				.keys()
				.list("conn")
				.map((k) => k.apiKey),
		).toEqual(["sk-1", "sk-2"]);
		expect(
			home
				.codex()
				.exportForTransfer()
				.map((c) => c.id),
		).toEqual(["a", "b"]);
	});

	test("plugin, Codex and key saves interleave without losing any; plugins never wake key listeners", () => {
		const home = unifiedHome();
		const manager = home.codex();
		const keys = home.keys();
		const store = getCredentialStore(home.dir);
		let changes = 0;
		keys.onChange(() => changes++);
		const plugin = (contributionId: string, apiKey: string) => ({
			pluginId: "com.example.p",
			contributionId,
			fields: { apiKey },
		});

		savePluginProviderSecrets(store, [plugin("one", "p-1")]);
		manager.importFromTransfer([account("a")], () => "add");
		keys.add("conn", { apiKey: "sk-1" });
		savePluginProviderSecrets(store, [plugin("two", "p-2")]);
		manager.setDisabled("a", true);
		keys.add("conn", { apiKey: "sk-2" });
		savePluginProviderSecrets(store, [plugin("one", "p-1b")]);

		expect(changes).toBe(2);
		const file = home.file();
		expect(file.credentials.map((c) => [c.id, c.auth.kind])).toEqual([
			["a", "oauth"],
			[expect.any(String), "api_key"],
			[expect.any(String), "api_key"],
			["plugin:com.example.p:one", "opaque"],
			["plugin:com.example.p:two", "opaque"],
		]);
		expect(file.credentials.at(-2)).toMatchObject({
			target: { pluginContributionId: "com.example.p/one" },
			ownerUserId: null,
			auth: { kind: "opaque", fields: { apiKey: "p-1b" } },
		});
		expect(store.hasId("plugin:com.example.p:two")).toBe(true);

		home.restart();
		const reloaded = getCredentialStore(home.dir);
		expect(Object.fromEntries(pluginProviderSecrets(reloaded, "com.example.p"))).toEqual({
			one: { apiKey: "p-1b" },
			two: { apiKey: "p-2" },
		});
		expect(
			home
				.keys()
				.list("conn")
				.map((k) => k.apiKey),
		).toEqual(["sk-1", "sk-2"]);
		expect(
			home
				.codex()
				.exportForTransfer()
				.map((c) => c.id),
		).toEqual(["a"]);
	});

	test("a failed save changes neither memory nor disk, and is not persisted by a later save", () => {
		const home = unifiedHome();
		const store = getCredentialStore(home.dir);
		const keys = home.keys();
		savePluginProviderSecrets(store, [
			{ pluginId: "p", contributionId: "demo", fields: { apiKey: "sk-1" } },
		]);
		const write = spyOn(secretStore, "writeSecretJSON").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		try {
			expect(() =>
				savePluginProviderSecrets(store, [
					{ pluginId: "p", contributionId: "demo", fields: { apiKey: "sk-rejected" } },
				]),
			).toThrow("disk full");
		} finally {
			write.mockRestore();
		}
		// The rejected edit is gone, and another owner's successful save does not commit it.
		keys.add("conn", { apiKey: "sk-conn" });
		expect(Object.fromEntries(pluginProviderSecrets(store, "p"))).toEqual({
			demo: { apiKey: "sk-1" },
		});
		expect(home.file().credentials.find((c) => c.id === "plugin:p:demo")?.auth).toEqual({
			kind: "opaque",
			fields: { apiKey: "sk-1" },
		});
	});

	test("ids are unique across Codex accounts and keys", () => {
		const home = unifiedHome();
		const manager = home.codex();
		const keys = home.keys();
		manager.importFromTransfer([account("shared")], () => "add");
		// An imported key that asks for an id a Codex account has gets a new one, and so does
		// a connection whose own id an account holds.
		expect(keys.add("conn", { apiKey: "sk-1", id: "shared" }).id).not.toBe("shared");
		keys.syncFirstKeys([{ id: "shared", apiKey: "sk-x" }], { clearOnEmpty: false });
		expect(keys.list("shared")[0]?.id).not.toBe("shared");

		const key = keys.add("conn", { apiKey: "sk-2", id: "key-id" });
		expect(key.id).toBe("key-id");
		manager.importFromTransfer([account("key-id")], () => "add");
		const ids = home.file().credentials.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(manager.exportForTransfer().map((c) => c.id)).not.toContain("key-id");
	});

	test("an unreadable credentials.json is never written", () => {
		const home = unifiedHome();
		home.restart();
		const path = join(home.dir, CREDENTIALS_FILE);
		const garbage = JSON.stringify({
			format: "narrafork.secret.v1",
			cipher: "aes-256-gcm",
			iv: "AAAAAAAAAAAAAAAA",
			tag: "AAAAAAAAAAAAAAAAAAAAAA==",
			data: "AAAA",
		});
		writeFileSync(path, garbage);
		const keys = home.keys();
		expect(keys.readable).toBe(false);
		expect(() => keys.add("conn", { apiKey: "sk-1" })).toThrow(SecretStoreError);
		expect(() => home.codex().importFromTransfer([account("a")], () => "add")).toThrow();
		expect(readFileSync(path, "utf8")).toBe(garbage);
	});

	test("switching encryption rewrites credentials.json once, and search keys in their own file", () => {
		const home = unifiedHome();
		const keys = home.keys();
		keys.syncFirstKeys(
			[
				{ id: "conn", apiKey: "sk-1" },
				{ id: searchKeyOwner("web"), apiKey: "search-key" },
			],
			{ clearOnEmpty: false },
		);
		try {
			changeSecretEncryption(false);
			const plain = JSON.parse(readFileSync(join(home.dir, CREDENTIALS_FILE), "utf8"));
			expect(plain.credentials[0].auth.apiKey).toBe("sk-1");
			keys.rewrite();
			expect(readFileSync(join(home.dir, "provider-keys.json"), "utf8")).toContain("search-key");
		} finally {
			changeSecretEncryption(true);
		}
		expect(readFileSync(join(home.dir, CREDENTIALS_FILE), "utf8")).not.toContain("sk-1");
	});
});
