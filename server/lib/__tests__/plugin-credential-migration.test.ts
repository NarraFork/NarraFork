import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CREDENTIAL_BACKUPS_DIR,
	migrateCredentialFiles,
	PLUGIN_SECRETS_FILE,
} from "../credential-migration";
import {
	CREDENTIALS_FILE,
	type CredentialsFile,
	getCredentialStore,
	resetCredentialStoresForTests,
} from "../credential-store";
import { savePluginProviderSecrets } from "../plugin-credentials";
import { readSecretJSON, writeSecretJSON } from "../secret-store";

const dirs: string[] = [];
afterEach(() => {
	resetCredentialStoresForTests();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VAULT = {
	version: 1,
	secrets: {
		"com.example.a": {
			"provider.demo.apiKey": "sk-a",
			"provider.demo.region": "eu",
			"session.token": "t-a",
		},
		"com.example.b": { "provider.x.v2.apiKey": "sk-b" },
	},
};

function home(options: { unified?: boolean; vault?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "nf-plugin-migration-"));
	dirs.push(dir);
	mkdirSync(join(dir, "plugins"));
	writeFileSync(join(dir, PLUGIN_SECRETS_FILE), options.vault ?? JSON.stringify(VAULT), {
		mode: 0o600,
	});
	if (options.unified !== false) {
		getCredentialStore(dir).create({ version: 1, credentials: [], groupSecrets: {} });
	}
	return {
		dir,
		vault: () => readFileSync(join(dir, PLUGIN_SECRETS_FILE), "utf8"),
		credentials: () => readFileSync(join(dir, CREDENTIALS_FILE), "utf8"),
		plugins: () =>
			Object.fromEntries(
				(readSecretJSON(join(dir, CREDENTIALS_FILE)) as CredentialsFile).credentials
					.filter((c) => c.auth.kind === "opaque")
					.map((c) => [c.id, c.auth.kind === "opaque" ? c.auth.fields : null]),
			),
		backups: () =>
			existsSync(join(dir, CREDENTIAL_BACKUPS_DIR))
				? readdirSync(join(dir, CREDENTIAL_BACKUPS_DIR))
				: [],
		restart: () => resetCredentialStoresForTests(),
	};
}

const MOVED = {
	"plugin:com.example.a:demo": { apiKey: "sk-a", region: "eu" },
	"plugin:com.example.b:x.v2": { apiKey: "sk-b" },
};
const VAULT_AFTER = {
	version: 1,
	secrets: { "com.example.a": { "session.token": "t-a" }, "com.example.b": {} },
};

describe("plugin provider secrets move to credentials.json", () => {
	test("field by field, after an owner-only backup of the vault; other secrets stay", () => {
		const h = home();
		expect(migrateCredentialFiles(h.dir)).toBe("unified");
		expect(h.plugins()).toEqual(MOVED);
		expect(JSON.parse(h.vault())).toEqual(VAULT_AFTER);
		expect(statSync(join(h.dir, PLUGIN_SECRETS_FILE)).mode & 0o777).toBe(0o600);

		const [backup] = h.backups();
		expect(backup).toMatch(/^pre-plugin-credentials-/);
		const backupDir = join(h.dir, CREDENTIAL_BACKUPS_DIR, backup as string);
		expect(readdirSync(backupDir)).toEqual(["secrets.json"]);
		expect(JSON.parse(readFileSync(join(backupDir, "secrets.json"), "utf8"))).toEqual(VAULT);
		expect(statSync(backupDir).mode & 0o777).toBe(0o700);
		expect(statSync(join(backupDir, "secrets.json")).mode & 0o777).toBe(0o600);
	});

	test("runs once: a later start changes nothing", () => {
		const h = home();
		migrateCredentialFiles(h.dir);
		const [credentials, vault, backups] = [h.credentials(), h.vault(), h.backups()];
		h.restart();
		expect(migrateCredentialFiles(h.dir)).toBe("unified");
		expect([h.credentials(), h.vault(), h.backups()]).toEqual([credentials, vault, backups]);
	});

	test("a crash before the vault is cleaned: the next start finishes, credentials.json wins", () => {
		const h = home();
		// As if an earlier start wrote this credential, then a later edit changed it.
		savePluginProviderSecrets(getCredentialStore(h.dir), [
			{ pluginId: "com.example.a", contributionId: "demo", fields: { apiKey: "sk-new" } },
		]);
		h.restart();
		migrateCredentialFiles(h.dir);
		expect(h.plugins()).toEqual({ ...MOVED, "plugin:com.example.a:demo": { apiKey: "sk-new" } });
		expect(JSON.parse(h.vault())).toEqual(VAULT_AFTER);
	});

	test("an unreadable vault: nothing is written", () => {
		const h = home({ vault: "{not json" });
		const credentials = h.credentials();
		expect(migrateCredentialFiles(h.dir)).toBe("unified");
		expect(h.credentials()).toBe(credentials);
		expect(h.vault()).toBe("{not json");
		expect(h.backups()).toEqual([]);
	});

	test("an unreadable credentials.json: the vault is left alone", () => {
		const h = home();
		h.restart();
		writeFileSync(join(h.dir, CREDENTIALS_FILE), "{not json");
		migrateCredentialFiles(h.dir);
		expect(JSON.parse(h.vault())).toEqual(VAULT);
		expect(h.backups()).toEqual([]);
	});

	test("an instance without credentials.json keeps its vault; one migrating now moves it too", () => {
		const legacy = home({ unified: false });
		expect(migrateCredentialFiles(legacy.dir)).toBe("nothing");
		expect(JSON.parse(legacy.vault())).toEqual(VAULT);

		writeSecretJSON(join(legacy.dir, "provider-keys.json"), [
			{ id: "conn", providerId: "conn", apiKey: "sk-conn", priority: 0, createdAt: 1 },
		]);
		expect(migrateCredentialFiles(legacy.dir)).toBe("migrated");
		expect(legacy.plugins()).toEqual(MOVED);
		expect(JSON.parse(legacy.vault())).toEqual(VAULT_AFTER);
		expect(legacy.backups().map((name) => name.replace(/-\d.*/, ""))).toEqual(
			expect.arrayContaining(["pre-sourcing", "pre-plugin-credentials"]),
		);
	});
});
