/**
 * JSON files that hold credentials (OAuth refresh tokens, API keys, private keys).
 *
 * By default they are written encrypted with AES-256-GCM under a key kept in
 * `~/.narrafork/secret.key` (0600). That protects a credential file copied on its own:
 * a backup, a synced folder, a file shared by mistake. It does not protect against
 * someone who can read the whole NarraFork home, where the key also lives. Operators
 * can turn encryption off (`settings.secrets.encrypt = false`); files are then plain
 * JSON. Reading accepts both forms, so switching never strands data.
 *
 * A file that exists but cannot be decrypted throws `SecretStoreError`. Owners must
 * treat that as "do not write": overwriting would destroy the only copy.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "./logger";
import { getNarraforkHome } from "./narrafork-home";

const FORMAT = "narrafork.secret.v1";
const KEY_FILE = "secret.key";

export class SecretStoreError extends Error {}

interface Envelope {
	format: typeof FORMAT;
	cipher: "aes-256-gcm";
	iv: string;
	tag: string;
	data: string;
}

function isEnvelope(value: unknown): value is Envelope {
	return (
		!!value &&
		typeof value === "object" &&
		(value as Envelope).format === FORMAT &&
		(value as Envelope).cipher === "aes-256-gcm"
	);
}

function writePrivate(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, contents, { mode: 0o600 });
	if (process.platform !== "win32")
		try {
			chmodSync(tmp, 0o600);
		} catch {
			/* Network filesystems can reject chmod; the content is already written. */
		}
	renameSync(tmp, path);
}

let cachedKey: { home: string; key: Buffer } | undefined;
function keyPath(): string {
	return resolve(getNarraforkHome(), KEY_FILE);
}

/** The instance key; created on first use. `create: false` returns undefined when absent. */
function loadKey(create: boolean): Buffer | undefined {
	const home = getNarraforkHome();
	if (cachedKey?.home === home) return cachedKey.key;
	const path = keyPath();
	if (existsSync(path)) {
		const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
		if (key.length !== 32) throw new SecretStoreError(`${KEY_FILE} is not a 256-bit key`);
		cachedKey = { home, key };
		return key;
	}
	if (!create) return undefined;
	const key = randomBytes(32);
	writePrivate(path, `${key.toString("base64")}\n`);
	cachedKey = { home, key };
	return key;
}

let encryptByDefault = true;
/** Bound to `settings.secrets.encrypt` by the settings module. */
export function setSecretEncryption(enabled: boolean): void {
	encryptByDefault = enabled;
}
export function isSecretEncryptionEnabled(): boolean {
	return encryptByDefault;
}

/** Read a credential file. Absent → undefined; undecryptable → SecretStoreError. */
export function readSecretJSON(path: string): unknown {
	if (!existsSync(path)) return undefined;
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isEnvelope(parsed)) return parsed;
	const key = loadKey(false);
	if (!key)
		throw new SecretStoreError(
			`${path} is encrypted but ${KEY_FILE} is missing; restore the key file to read it`,
		);
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
		decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
		const plain = Buffer.concat([
			decipher.update(Buffer.from(parsed.data, "base64")),
			decipher.final(),
		]);
		return JSON.parse(plain.toString("utf8"));
	} catch {
		throw new SecretStoreError(`${path} could not be decrypted with the current ${KEY_FILE}`);
	}
}

/** Write a credential file, encrypted unless encryption is turned off. */
export function writeSecretJSON(path: string, value: unknown): void {
	const json = JSON.stringify(value, null, 2);
	if (!encryptByDefault) {
		writePrivate(path, json);
		return;
	}
	const key = loadKey(true) as Buffer;
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const data = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
	const envelope: Envelope = {
		format: FORMAT,
		cipher: "aes-256-gcm",
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		data: data.toString("base64"),
	};
	writePrivate(path, JSON.stringify(envelope));
}

/** Owners rewrite their files in the current form when the encryption setting changes. */
const rewriters = new Set<() => void>();
export function onSecretEncryptionChange(rewrite: () => void): () => void {
	rewriters.add(rewrite);
	return () => rewriters.delete(rewrite);
}

/** Apply a new encryption setting and rewrite every registered credential file. */
export function changeSecretEncryption(enabled: boolean): void {
	if (enabled === encryptByDefault) return;
	encryptByDefault = enabled;
	for (const rewrite of rewriters)
		try {
			rewrite();
		} catch (error) {
			logger.error("A credential file was not rewritten after the encryption change", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
}

/** Tests only: forget the cached key so a different NARRAFORK_HOME is honoured. */
export function resetSecretStoreForTests(): void {
	cachedKey = undefined;
	encryptByDefault = true;
}
