import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	openSecretRecord,
	readSecretJSON,
	resetSecretStoreForTests,
	SECRET_RECORD_LIMITS,
	SecretRecordError,
	sealSecretRecord,
	secretRecordKeyId,
	setSecretEncryption,
	writeSecretJSON,
} from "../secret-store";
import { safeSpawn } from "../spawn";

const originalHome = process.env.NARRAFORK_HOME;
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "nf-secret-record-test-"));
	process.env.NARRAFORK_HOME = root;
	resetSecretStoreForTests();
});
afterEach(() => {
	process.env.NARRAFORK_HOME = originalHome;
	resetSecretStoreForTests();
	rmSync(root, { recursive: true, force: true });
});
const binding = "com.example.settings/preferences/custom-api/provider-1/token/revision-1";
const plain = Buffer.from('{"token":"fictional-record-token"}');
function code(body: () => unknown, expected: string) {
	try {
		body();
	} catch (error) {
		expect(error).toBeInstanceOf(SecretRecordError);
		expect((error as SecretRecordError).code).toBe(expected);
		expect(String(error)).not.toContain(root);
		expect(String(error)).not.toContain("fictional-record-token");
		return;
	}
	throw new Error(`Expected ${expected}`);
}

describe("bound encrypted plugin records", () => {
	test("uses the existing key, independent nonces and AAD, and never honors the plaintext toggle", () => {
		const path = join(root, "old.json");
		writeSecretJSON(path, { old: "fixture" });
		const key = readFileSync(join(root, "secret.key"));
		const first = sealSecretRecord(plain, binding),
			second = sealSecretRecord(plain, binding);
		expect(first).not.toBe(second);
		expect(first).not.toContain("fictional-record-token");
		expect(first).not.toContain(binding);
		expect(openSecretRecord(first, binding)).toEqual(plain);
		expect(secretRecordKeyId(first)).toMatch(/^[a-f0-9]{64}$/);
		setSecretEncryption(false);
		const encrypted = sealSecretRecord(plain, binding);
		expect(openSecretRecord(encrypted, binding)).toEqual(plain);
		expect(JSON.parse(encrypted).format).toBe("narrafork.secret.record.v1");
		expect(readFileSync(join(root, "secret.key"))).toEqual(key);
		expect(readSecretJSON(path)).toEqual({ old: "fixture" });
		for (const other of [
			`${binding}-other`,
			"com.other.settings/preferences/custom-api/provider-1/token/revision-1",
			"com.example.settings/preferences/custom-api/provider-2/token/revision-1",
		])
			code(() => openSecretRecord(first, other), "SECRET_RECORD_AUTH_FAILED");
	});
	test("fresh reads detect missing, changed, truncated and oversized keys without replacing them", () => {
		const encrypted = sealSecretRecord(plain, binding),
			path = join(root, "secret.key"),
			key = readFileSync(path);
		rmSync(path);
		code(() => openSecretRecord(encrypted, binding), "SECRET_RECORD_KEY_UNAVAILABLE");
		expect(existsSync(path)).toBe(false);
		writeFileSync(path, Buffer.alloc(32, 9).toString("base64"));
		const other = readFileSync(path);
		code(() => openSecretRecord(encrypted, binding), "SECRET_RECORD_KEY_MISMATCH");
		expect(readFileSync(path)).toEqual(other);
		for (const bad of ["truncated", "x".repeat(300)]) {
			writeFileSync(path, bad);
			code(() => openSecretRecord(encrypted, binding), "SECRET_RECORD_KEY_UNAVAILABLE");
			code(() => sealSecretRecord(plain, binding), "SECRET_RECORD_KEY_UNAVAILABLE");
			expect(readFileSync(path, "utf8")).toBe(bad);
		}
		writeFileSync(path, key);
		expect(openSecretRecord(encrypted, binding)).toEqual(plain);
	});
	test("a different HOME cannot decrypt or silently create a replacement key", () => {
		const encrypted = sealSecretRecord(plain, binding),
			path = join(root, "secret.key"),
			key = readFileSync(path);
		const other = join(root, "other-home");
		process.env.NARRAFORK_HOME = other;
		code(() => openSecretRecord(encrypted, binding), "SECRET_RECORD_KEY_UNAVAILABLE");
		expect(existsSync(join(other, "secret.key"))).toBe(false);
		sealSecretRecord(Buffer.from("other"), binding);
		code(() => openSecretRecord(encrypted, binding), "SECRET_RECORD_KEY_MISMATCH");
		process.env.NARRAFORK_HOME = root;
		expect(readFileSync(path)).toEqual(key);
		expect(openSecretRecord(encrypted, binding)).toEqual(plain);
	});
	test("rejects malformed formats, base64, sizes and authentication failures before exposing any plaintext", () => {
		const encrypted = sealSecretRecord(plain, binding),
			envelope = JSON.parse(encrypted);
		for (const patch of [
			{ format: "narrafork.secret.v1" },
			{ cipher: "none" },
			{ keyId: "unknown" },
			{ iv: "x" },
			{ tag: Buffer.alloc(15).toString("base64") },
			{ data: "not base64!" },
			{ data: "AA==ignored" },
			{ extra: "ignored" },
			{ data: Buffer.alloc(SECRET_RECORD_LIMITS.plaintextBytes + 1).toString("base64") },
		])
			code(
				() => openSecretRecord(JSON.stringify({ ...envelope, ...patch }), binding),
				"SECRET_RECORD_INVALID",
			);
		for (const encoded of [
			"{}",
			"null",
			"[]",
			"not-json",
			" ".repeat(SECRET_RECORD_LIMITS.envelopeBytes + 1),
		])
			code(() => openSecretRecord(encoded, binding), "SECRET_RECORD_INVALID");
		code(
			() =>
				openSecretRecord(
					JSON.stringify({ ...envelope, tag: Buffer.alloc(16).toString("base64") }),
					binding,
				),
			"SECRET_RECORD_AUTH_FAILED",
		);
		code(
			() => sealSecretRecord(Buffer.alloc(SECRET_RECORD_LIMITS.plaintextBytes + 1), binding),
			"SECRET_RECORD_INVALID",
		);
		code(
			() => sealSecretRecord(plain, "a".repeat(SECRET_RECORD_LIMITS.bindingBytes + 1)),
			"SECRET_RECORD_INVALID",
		);
		expect(
			openSecretRecord(
				sealSecretRecord(Buffer.alloc(SECRET_RECORD_LIMITS.plaintextBytes), binding),
				binding,
			).length,
		).toBe(SECRET_RECORD_LIMITS.plaintextBytes);
	});
	test("concurrent first creators never replace another process's key", async () => {
		const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../secret-store.ts")).href;
		const script = `import {sealSecretRecord} from ${JSON.stringify(moduleUrl)}; try { console.log(sealSecretRecord(Buffer.from('fixture-child'),'creator')); } catch { process.exitCode=3; }`;
		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				safeSpawn({
					cmd: [process.execPath, "--eval", script],
					cwd: resolve(import.meta.dir, "../../.."),
					env: { ...process.env, NARRAFORK_HOME: root },
					timeout: 15000,
					maxOutputBytes: 4096,
				}),
			),
		);
		const successes = results.filter((r) => r.exitCode === 0);
		expect(successes.length).toBeGreaterThan(0);
		for (const result of results) expect([0, 3]).toContain(result.exitCode);
		for (const result of successes)
			expect(openSecretRecord(result.stdout.trim(), "creator").toString()).toBe("fixture-child");
	}, 20000);
});
