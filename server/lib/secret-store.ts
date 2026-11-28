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
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	writeFileSync,
} from "node:fs";
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

/** Atomically write an owner-only (0600) file. */
export function writePrivate(path: string, contents: string): void {
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

function loadKey(create: boolean, fresh = false): Buffer | undefined {
	const home = getNarraforkHome();
	if (!fresh && cachedKey?.home === home) return cachedKey.key;
	const path = keyPath();
	const read = (): Buffer | undefined => {
		let fd: number;
		try {
			fd = openSync(path, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new SecretStoreError("Secret key is unavailable");
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > 256) throw new SecretStoreError("Invalid secret key");
			const bytes = Buffer.alloc(257);
			let size = 0;
			while (size < bytes.length) {
				const count = readSync(fd, bytes, size, bytes.length - size, null);
				if (!count) break;
				size += count;
			}
			if (size > 256) throw new SecretStoreError("Invalid secret key");
			const encoded = bytes.subarray(0, size).toString("utf8").trim();
			const key = Buffer.from(encoded, "base64");
			if (key.length !== 32 || key.toString("base64") !== encoded)
				throw new SecretStoreError("Invalid secret key");
			return key;
		} finally {
			closeSync(fd);
		}
	};
	let key = read();
	if (!key && create) {
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const generated = randomBytes(32);
		let fd: number;
		try {
			fd = openSync(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST")
				throw new SecretStoreError("Secret key could not be created");
			const concurrent = read();
			if (!concurrent) throw new SecretStoreError("Secret key is unavailable");
			cachedKey = { home, key: concurrent };
			return concurrent;
		}
		try {
			writeFileSync(fd, `${generated.toString("base64")}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		key = generated;
	}
	if (!key) {
		if (fresh) cachedKey = undefined;
		return undefined;
	}
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

/** Separate database-record format. Always encrypted, independent from the legacy file toggle. */
const RECORD_FORMAT = "narrafork.secret.record.v1";
export const SECRET_RECORD_LIMITS = Object.freeze({
	plaintextBytes: 32 * 1024,
	envelopeBytes: 48 * 1024,
	bindingBytes: 2048,
});
interface SecretRecordEnvelope {
	format: typeof RECORD_FORMAT;
	cipher: "aes-256-gcm";
	keyId: string;
	iv: string;
	tag: string;
	data: string;
}
export class SecretRecordError extends SecretStoreError {
	constructor(
		readonly code:
			| "SECRET_RECORD_INVALID"
			| "SECRET_RECORD_KEY_UNAVAILABLE"
			| "SECRET_RECORD_KEY_MISMATCH"
			| "SECRET_RECORD_AUTH_FAILED",
	) {
		super("Protected plugin record is unavailable");
		this.name = "SecretRecordError";
	}
}
function invalidRecord(): never {
	throw new SecretRecordError("SECRET_RECORD_INVALID");
}
function recordBinding(value: string): Buffer {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > SECRET_RECORD_LIMITS.bindingBytes ||
		Buffer.byteLength(value) > SECRET_RECORD_LIMITS.bindingBytes
	)
		invalidRecord();
	return Buffer.from(value, "utf8");
}
function recordKeyId(key: Buffer): string {
	return createHash("sha256").update("narrafork.secret.record.key.v1\0").update(key).digest("hex");
}
function recordAad(keyId: string, binding: Buffer): Buffer {
	return Buffer.concat([Buffer.from(`${RECORD_FORMAT}\0aes-256-gcm\0${keyId}\0`), binding]);
}
function decodeRecordBase64(value: unknown, limit: number, exact?: number): Buffer {
	if (
		typeof value !== "string" ||
		value.length > Math.ceil(limit / 3) * 4 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	)
		invalidRecord();
	const bytes = Buffer.from(value, "base64");
	if (
		bytes.length > limit ||
		(exact !== undefined && bytes.length !== exact) ||
		bytes.toString("base64") !== value
	)
		invalidRecord();
	return bytes;
}
function parseSecretRecord(encoded: string): SecretRecordEnvelope {
	if (
		typeof encoded !== "string" ||
		encoded.length > SECRET_RECORD_LIMITS.envelopeBytes ||
		Buffer.byteLength(encoded) > SECRET_RECORD_LIMITS.envelopeBytes
	)
		invalidRecord();
	let raw: unknown;
	try {
		raw = JSON.parse(encoded);
	} catch {
		return invalidRecord();
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalidRecord();
	const envelope = raw as SecretRecordEnvelope;
	if (
		Object.keys(envelope).sort().join(",") !== "cipher,data,format,iv,keyId,tag" ||
		envelope.format !== RECORD_FORMAT ||
		envelope.cipher !== "aes-256-gcm" ||
		typeof envelope.keyId !== "string" ||
		!/^[a-f0-9]{64}$/.test(envelope.keyId)
	)
		invalidRecord();
	decodeRecordBase64(envelope.iv, 12, 12);
	decodeRecordBase64(envelope.tag, 16, 16);
	decodeRecordBase64(envelope.data, SECRET_RECORD_LIMITS.plaintextBytes);
	return envelope;
}
function recordKey(create: boolean): Buffer {
	try {
		const key = loadKey(create, true);
		if (key) return key;
	} catch {
		/* Do not expose key paths, format or source values. */
	}
	throw new SecretRecordError("SECRET_RECORD_KEY_UNAVAILABLE");
}
/** Safe untrusted-envelope metadata; does not read or create a key. */
export function secretRecordKeyId(encoded: string): string {
	return parseSecretRecord(encoded).keyId;
}
/** Seal one small record. Callers must never loop bulk migrations on the host thread. */
export function sealSecretRecord(plain: Uint8Array, binding: string): string {
	if (!(plain instanceof Uint8Array) || plain.byteLength > SECRET_RECORD_LIMITS.plaintextBytes)
		invalidRecord();
	const bound = recordBinding(binding);
	const key = recordKey(true),
		keyId = recordKeyId(key),
		iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(recordAad(keyId, bound));
	const data = Buffer.concat([cipher.update(plain), cipher.final()]);
	const envelope: SecretRecordEnvelope = {
		format: RECORD_FORMAT,
		cipher: "aes-256-gcm",
		keyId,
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		data: data.toString("base64"),
	};
	const encoded = JSON.stringify(envelope);
	if (Buffer.byteLength(encoded) > SECRET_RECORD_LIMITS.envelopeBytes) invalidRecord();
	return encoded;
}
/** Fresh key read is mandatory; unknown keys/authentication never become absent/empty data. */
export function openSecretRecord(encoded: string, binding: string): Buffer {
	const envelope = parseSecretRecord(encoded),
		bound = recordBinding(binding),
		key = recordKey(false);
	if (recordKeyId(key) !== envelope.keyId)
		throw new SecretRecordError("SECRET_RECORD_KEY_MISMATCH");
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
		decipher.setAAD(recordAad(envelope.keyId, bound));
		decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
		return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
	} catch {
		throw new SecretRecordError("SECRET_RECORD_AUTH_FAILED");
	}
}
