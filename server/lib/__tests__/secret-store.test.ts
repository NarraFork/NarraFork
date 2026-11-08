import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexManager } from "../codex-manager";
import { getNarraforkHome } from "../narrafork-home";
import {
	changeSecretEncryption,
	isSecretEncryptionEnabled,
	onSecretEncryptionChange,
	readSecretJSON,
	resetSecretStoreForTests,
	SecretStoreError,
	writeSecretJSON,
} from "../secret-store";
import { saveSettings, settings } from "../settings";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "narrafork-secret-store-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	rmSync(join(getNarraforkHome(), "secret.key"), { force: true });
	resetSecretStoreForTests();
});

describe("secret store", () => {
	test("writes an encrypted envelope by default and reads it back", () => {
		const path = join(tempDir(), "creds.json");
		writeSecretJSON(path, [{ refreshToken: "rt-secret" }]);
		const raw = readFileSync(path, "utf8");
		expect(raw).not.toContain("rt-secret");
		expect(JSON.parse(raw).format).toBe("narrafork.secret.v1");
		expect(readSecretJSON(path)).toEqual([{ refreshToken: "rt-secret" }]);
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(statSync(join(getNarraforkHome(), "secret.key")).mode & 0o777).toBe(0o600);
		}
	});

	test("plain JSON reads as is, and missing files read as undefined", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "plain.json"), JSON.stringify({ a: 1 }));
		expect(readSecretJSON(join(dir, "plain.json"))).toEqual({ a: 1 });
		expect(readSecretJSON(join(dir, "absent.json"))).toBeUndefined();
	});

	test("turning encryption off rewrites registered files as plain JSON, and back", () => {
		const path = join(tempDir(), "creds.json");
		writeSecretJSON(path, { k: "v" });
		const stop = onSecretEncryptionChange(() => writeSecretJSON(path, readSecretJSON(path)));
		try {
			changeSecretEncryption(false);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ k: "v" });
			changeSecretEncryption(true);
			expect(readFileSync(path, "utf8")).not.toContain('"v"');
			expect(readSecretJSON(path)).toEqual({ k: "v" });
		} finally {
			stop();
		}
	});

	test("an encrypted file without its key throws instead of reading as empty", () => {
		const path = join(tempDir(), "creds.json");
		writeSecretJSON(path, { k: "v" });
		rmSync(join(getNarraforkHome(), "secret.key"));
		resetSecretStoreForTests();
		expect(() => readSecretJSON(path)).toThrow(SecretStoreError);
	});

	test("CodexManager never overwrites a credential file it could not decrypt", () => {
		const home = tempDir();
		const path = join(home, ".narrafork", "codex-credentials.json");
		mkdirSync(join(home, ".narrafork"), { recursive: true });
		writeSecretJSON(path, [
			{
				id: "a",
				refreshToken: "rt-a",
				accessToken: "at-a",
				expiresAt: Date.now() + 60_000,
				priority: 0,
				disabled: false,
			},
		]);
		const before = readFileSync(path, "utf8");
		rmSync(join(getNarraforkHome(), "secret.key"));
		resetSecretStoreForTests();

		const manager = new CodexManager({ homeDir: home, registerProcessHooks: false });
		expect(manager.snapshot().entries).toEqual([]);
		expect(() => manager.updateCredential("a", { displayName: "x" })).toThrow();
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(existsSync(path)).toBe(true);
	});

	test("follows settings.secrets.encrypt", () => {
		const saved = settings.secrets;
		try {
			saveSettings({ ...settings, secrets: { encrypt: false } });
			expect(isSecretEncryptionEnabled()).toBe(false);
			saveSettings({ ...settings, secrets: {} });
			expect(isSecretEncryptionEnabled()).toBe(true);
		} finally {
			saveSettings({ ...settings, secrets: saved });
		}
	});
});
