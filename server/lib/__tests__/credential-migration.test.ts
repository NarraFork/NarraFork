import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	cpSync,
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
import { Hono } from "hono";
import { settingsRoutes } from "../../routes/settings";
import { CodexManager } from "../codex-manager";
import {
	CREDENTIAL_BACKUPS_DIR,
	getCredentialMigrationConflicts,
	migrateCredentialFiles,
} from "../credential-migration";
import {
	CREDENTIALS_FILE,
	type CredentialsFile,
	resetCredentialStoresForTests,
} from "../credential-store";
import {
	nugKeyOwner,
	ProviderKeyStore,
	quotaKeyOwner,
	searchKeyOwner,
	TOKENDANCE_KEY_OWNER,
} from "../provider-keys";
import * as secretStore from "../secret-store";
import { readSecretJSON, writeSecretJSON } from "../secret-store";

const dirs: string[] = [];
const managers: CodexManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	resetCredentialStoresForTests();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = (providerId: string, id: string, apiKey: string, extra: object = {}) => ({
	id,
	providerId,
	apiKey,
	priority: 0,
	createdAt: 1,
	...extra,
});

/** An instance from before credentials.json: every kind of model credential there is. */
const LEGACY_KEYS = [
	// Several keys: billed per key.
	key("multi", "multi", "sk-m1"),
	key("multi", "taken", "sk-m2", { priority: 1 }),
	// Its first key was deleted: the remaining one is billed to the connection.
	key("solo", "solo-2", "sk-solo", { priority: 1 }),
	// One key with its own network identity: pooled, billed per key.
	key("net", "net-1", "sk-net", { network: { userAgentMode: "claude-code" } }),
	// Billed to the connection, but another key already has the connection id.
	key("taken", "taken-1", "sk-taken"),
	// First key off, second on: the pool serves, billed per key.
	key("firstoff", "firstoff", "sk-f1", { disabled: true, disabledReason: "manual" }),
	key("firstoff", "f-2", "sk-f2", { priority: 1 }),
	key("nug:gw", "nug:gw", "nug-key"),
	key("nug-oauth:gw", "nug-oauth:gw", "oauth-secret"),
	key("quota:multi", "quota:multi", "site-token"),
	key("builtin:tokendance", "builtin:tokendance", "td-key"),
	key("builtin:CommandCode", "builtin:CommandCode", "cc-key"),
	key("search:web", "search:web", "search-key"),
];

const LEGACY_ACCOUNTS = [
	{
		id: "acc-1",
		refreshToken: "rt-1",
		accessToken: "at-1",
		accountId: "a1",
		email: "one@example.com",
		sub: "s1",
		displayName: "One",
		priority: 0,
		disabled: false,
		usage: { plan_type: "plus" },
	},
	{
		id: "acc-2",
		authMode: "personal_access_token",
		accessToken: "at-pat",
		accountId: "a2",
		email: "two@example.com",
		priority: 1,
		disabled: true,
		disabledReason: "quota_exhausted",
		quotaResetsAt: 999,
	},
];

function legacyHome(options: { accounts?: object[]; keys?: object[] } = {}): {
	homeDir: string;
	dir: string;
} {
	const homeDir = mkdtempSync(join(tmpdir(), "narrafork-credential-migration-"));
	dirs.push(homeDir);
	const dir = join(homeDir, ".narrafork");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ server: { port: 1 } }));
	writeFileSync(
		join(dir, "codex-stats.json"),
		JSON.stringify({ "acc-1": { successCount: 3, failureCount: 0 } }),
	);
	writeSecretJSON(join(dir, "codex-credentials.json"), options.accounts ?? LEGACY_ACCOUNTS);
	writeSecretJSON(join(dir, "provider-keys.json"), options.keys ?? LEGACY_KEYS);
	return { homeDir, dir };
}

/** Every file under the home with its bytes: "nothing was written" compares two of these. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of readdirSync(dir, { recursive: true }) as string[]) {
		const path = join(dir, name);
		if (statSync(path).isFile()) out[name] = readFileSync(path, "utf8");
	}
	return out;
}

const credentialsOf = (dir: string) =>
	readSecretJSON(join(dir, CREDENTIALS_FILE)) as CredentialsFile;

const UNDECRYPTABLE = JSON.stringify({
	format: "narrafork.secret.v1",
	cipher: "aes-256-gcm",
	iv: "AAAAAAAAAAAAAAAA",
	tag: "AAAAAAAAAAAAAAAAAAAAAA==",
	data: "AAAA",
});

describe("credential migration", () => {
	test("each kind gets the id its requests are billed to", () => {
		const { dir } = legacyHome();
		expect(migrateCredentialFiles(dir)).toBe("migrated");
		const file = credentialsOf(dir);
		expect(file.credentials.map((c) => [c.id, c.target.groupId])).toEqual([
			["acc-1", "codex"],
			["acc-2", "codex"],
			["multi", "multi"],
			["taken", "multi"],
			["solo", "solo"],
			["net-1", "net"],
			["taken-1", "taken"],
			["firstoff", "firstoff"],
			["f-2", "firstoff"],
			["gw", "gw"],
			["tokendance", "tokendance"],
			["CommandCode", "CommandCode"],
		]);
		expect(file.groupSecrets).toEqual({
			multi: { quotaAccessToken: "site-token" },
			gw: { oauthClientSecret: "oauth-secret" },
		});
		expect(file.credentials.find((c) => c.id === "acc-1")).toMatchObject({
			label: "One",
			auth: { kind: "oauth", refreshToken: "rt-1", accessToken: "at-1" },
			account: { accountId: "a1", email: "one@example.com", sub: "s1" },
		});
		expect(file.credentials.find((c) => c.id === "acc-2")).toMatchObject({
			auth: { kind: "pat", accessToken: "at-pat" },
		});
		// A system block is runtime state: it moved to credential-state.json.
		expect(file.credentials.find((c) => c.id === "acc-2")).not.toHaveProperty("disabled");
		const state = JSON.parse(readFileSync(join(dir, "credential-state.json"), "utf8"));
		expect(state["acc-1"].usage).toEqual({ plan_type: "plus" });
		expect(state["acc-2"].blocked).toEqual({ reason: "quota_exhausted", resetsAt: 999 });

		// Old files: only the search key is left; the Codex file is gone.
		expect(readSecretJSON(join(dir, "provider-keys.json"))).toEqual([LEGACY_KEYS.at(-1)]);
		expect(existsSync(join(dir, "codex-credentials.json"))).toBe(false);
	});

	test("both owners load the migrated credentials as they were", () => {
		const { homeDir, dir } = legacyHome();
		const before = new ProviderKeyStore(join(dir, "provider-keys.json"));
		const owners = ["multi", "solo", "net", "taken", "firstoff"];
		const apiKeys = (s: ProviderKeyStore) => owners.map((o) => s.list(o).map((k) => k.apiKey));
		const expected = apiKeys(before);
		resetCredentialStoresForTests();
		migrateCredentialFiles(dir);
		resetCredentialStoresForTests();

		const keys = new ProviderKeyStore(join(dir, "provider-keys.json"));
		expect(apiKeys(keys)).toEqual(expected);
		expect(keys.firstKey(nugKeyOwner("gw"))).toBe("nug-key");
		expect(keys.firstKey(quotaKeyOwner("multi"))).toBe("site-token");
		expect(keys.firstKey(TOKENDANCE_KEY_OWNER)).toBe("td-key");
		expect(keys.firstKey(searchKeyOwner("web"))).toBe("search-key");
		expect(keys.list("firstoff")[0]).toMatchObject({ disabled: true, disabledReason: "manual" });

		const manager = new CodexManager({ homeDir, registerProcessHooks: false });
		managers.push(manager);
		expect(manager.exportForTransfer().map((c) => c.id)).toEqual(["acc-1", "acc-2"]);
		// acc-2 is still blocked until its quota resets; counts moved from codex-stats.json.
		expect(manager.availableCount).toBe(1);
		expect(manager.snapshot().entries.find((c) => c.id === "acc-1")?.successCount).toBe(3);
		expect(existsSync(join(dir, "codex-stats.json"))).toBe(false);
	});

	test("backs up the files it reads or changes, owner-only", () => {
		const { dir } = legacyHome();
		const original = snapshot(dir);
		migrateCredentialFiles(dir);
		const [backup] = readdirSync(join(dir, CREDENTIAL_BACKUPS_DIR));
		expect(backup).toMatch(/^pre-sourcing-\d{4}-\d{2}-\d{2}T/);
		const backupDir = join(dir, CREDENTIAL_BACKUPS_DIR, backup as string);
		const copied = snapshot(backupDir);
		expect(copied).toEqual({
			"settings.json": original["settings.json"],
			"codex-credentials.json": original["codex-credentials.json"],
			"provider-keys.json": original["provider-keys.json"],
			"codex-stats.json": original["codex-stats.json"],
		});
		if (process.platform !== "win32") {
			expect(statSync(join(dir, CREDENTIAL_BACKUPS_DIR)).mode & 0o777).toBe(0o700);
			expect(statSync(backupDir).mode & 0o777).toBe(0o700);
			for (const name of Object.keys(copied)) {
				expect(statSync(join(backupDir, name)).mode & 0o777).toBe(0o600);
			}
		}
	});

	test("runs once: later starts change nothing", () => {
		const { dir } = legacyHome();
		migrateCredentialFiles(dir);
		const after = snapshot(dir);
		resetCredentialStoresForTests();
		expect(migrateCredentialFiles(dir)).toBe("unified");
		expect(snapshot(dir)).toEqual(after);
	});

	test("nothing to move: no credentials.json, search keys untouched", () => {
		const { dir } = legacyHome({ accounts: [], keys: [LEGACY_KEYS.at(-1) as object] });
		const before = snapshot(dir);
		expect(migrateCredentialFiles(dir)).toBe("nothing");
		expect(snapshot(dir)).toEqual(before);
	});

	test("an unreadable file stops it before any write; the old files stay usable", () => {
		const { homeDir, dir } = legacyHome();
		writeFileSync(join(dir, "codex-credentials.json"), UNDECRYPTABLE);
		const before = snapshot(dir);
		expect(migrateCredentialFiles(dir)).toBe("unreadable");
		expect(snapshot(dir)).toEqual(before);

		resetCredentialStoresForTests();
		const keys = new ProviderKeyStore(join(dir, "provider-keys.json"));
		keys.add("multi", { apiKey: "sk-m3" });
		expect(readSecretJSON(join(dir, "provider-keys.json"))).toContainEqual(
			expect.objectContaining({ providerId: "multi", apiKey: "sk-m3" }),
		);
		const manager = new CodexManager({ homeDir, registerProcessHooks: false });
		managers.push(manager);
		expect(manager.exportForTransfer()).toEqual([]);
		expect(existsSync(join(dir, CREDENTIALS_FILE))).toBe(false);
	});

	test("an id conflict stops it before any write, is shown in settings, and clears once fixed", async () => {
		const accounts = [{ ...LEGACY_ACCOUNTS[0], id: "gw" }];
		const { dir } = legacyHome({ accounts });
		const before = snapshot(dir);
		expect(migrateCredentialFiles(dir)).toBe("conflict");
		expect(snapshot(dir)).toEqual(before);
		const conflicts = [
			{ id: "gw", sources: [{ groupId: "codex", label: "One" }, { groupId: "gw" }] },
		];
		expect(getCredentialMigrationConflicts()).toEqual(conflicts);

		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("user", { sub: "admin", role: "admin", iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await next();
		});
		app.route("/api/settings", settingsRoutes);
		const response = await app.request("/api/settings");
		expect((await response.json()).credentialMigrationConflicts).toEqual(conflicts);

		// The old files stay editable: removing one side lets the next start migrate.
		resetCredentialStoresForTests();
		new ProviderKeyStore(join(dir, "provider-keys.json")).removeProvider(nugKeyOwner("gw"));
		resetCredentialStoresForTests();
		expect(migrateCredentialFiles(dir)).toBe("migrated");
		expect(getCredentialMigrationConflicts()).toEqual([]);
	});

	test("a crash before credentials.json is written: the next start migrates again", () => {
		const { dir } = legacyHome();
		const write = spyOn(secretStore, "writeSecretJSON").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		try {
			expect(migrateCredentialFiles(dir)).toBe("failed");
		} finally {
			write.mockRestore();
		}
		expect(existsSync(join(dir, CREDENTIALS_FILE))).toBe(false);
		expect(existsSync(join(dir, "codex-credentials.json"))).toBe(true);
		expect(readSecretJSON(join(dir, "provider-keys.json"))).toEqual(LEGACY_KEYS);

		resetCredentialStoresForTests();
		expect(migrateCredentialFiles(dir)).toBe("migrated");
		expect(credentialsOf(dir).credentials).toHaveLength(12);
		expect(readdirSync(join(dir, CREDENTIAL_BACKUPS_DIR))).toHaveLength(2);
	});

	test("a crash after credentials.json is written: the next start finishes the clean-up", () => {
		const { dir } = legacyHome();
		migrateCredentialFiles(dir);
		const migrated = credentialsOf(dir);
		// As if the process died before the old files were emptied.
		const [backup] = readdirSync(join(dir, CREDENTIAL_BACKUPS_DIR));
		for (const name of ["codex-credentials.json", "provider-keys.json"]) {
			cpSync(join(dir, CREDENTIAL_BACKUPS_DIR, backup as string, name), join(dir, name));
		}
		resetCredentialStoresForTests();

		// Owners already use credentials.json and ignore what was left behind.
		const keys = new ProviderKeyStore(join(dir, "provider-keys.json"));
		expect(keys.list("multi").map((k) => k.id)).toEqual(["multi", "taken"]);
		expect(keys.list("solo").map((k) => k.id)).toEqual(["solo"]);

		resetCredentialStoresForTests();
		expect(migrateCredentialFiles(dir)).toBe("unified");
		expect(credentialsOf(dir)).toEqual(migrated);
		expect(readSecretJSON(join(dir, "provider-keys.json"))).toEqual([LEGACY_KEYS.at(-1)]);
		expect(existsSync(join(dir, "codex-credentials.json"))).toBe(false);
	});
});
