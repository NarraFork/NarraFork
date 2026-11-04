/**
 * Credential export bundle: a JSON file sealed with a passphrase the admin chooses at
 * export time. The instance key (`secret.key`) never leaves the server, so a bundle
 * opens on any NarraFork that is given the passphrase, and on nothing that is not.
 *
 * scrypt (N=2^16, r=8, p=1, ~64 MiB) derives an AES-256-GCM key; the async scrypt runs
 * on the libuv thread pool, so sealing and opening do not block the event loop.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

export const BUNDLE_FORMAT = "narrafork.credentials.v1";
export const MIN_PASSPHRASE_LENGTH = 10;
/** Bundles hold a few hundred credentials at most; anything larger is not ours. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

const KDF = { name: "scrypt", N: 2 ** 16, r: 8, p: 1 } as const;

export interface BundleItem {
	/** Credential family, e.g. "codex". */
	kind: string;
	/** Id on the exporting instance; informational. */
	id: string;
	label: string;
	data: unknown;
}

export interface BundleContents {
	exportedAt: number;
	items: BundleItem[];
}

interface SealedBundle {
	format: typeof BUNDLE_FORMAT;
	exportedAt: number;
	count: number;
	kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
	cipher: "aes-256-gcm";
	iv: string;
	tag: string;
	data: string;
}

export class BundleError extends Error {
	constructor(
		readonly code: "BUNDLE_INVALID" | "BUNDLE_PASSPHRASE" | "BUNDLE_TOO_LARGE",
		message: string,
	) {
		super(message);
	}
}

function deriveKey(passphrase: string, salt: Buffer, kdf: { N: number; r: number; p: number }) {
	return new Promise<Buffer>((resolve, reject) =>
		scrypt(
			passphrase.normalize("NFKC"),
			salt,
			32,
			{ N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r },
			(error, key) => (error ? reject(error) : resolve(key)),
		),
	);
}

export async function sealBundle(contents: BundleContents, passphrase: string): Promise<string> {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const key = await deriveKey(passphrase, salt, KDF);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const data = Buffer.concat([cipher.update(JSON.stringify(contents), "utf8"), cipher.final()]);
	const sealed: SealedBundle = {
		format: BUNDLE_FORMAT,
		exportedAt: contents.exportedAt,
		count: contents.items.length,
		kdf: { ...KDF, salt: salt.toString("base64") },
		cipher: "aes-256-gcm",
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		data: data.toString("base64"),
	};
	return JSON.stringify(sealed, null, 2);
}

function parseSealed(text: string): SealedBundle {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new BundleError("BUNDLE_INVALID", "Not a NarraFork credential bundle");
	}
	const v = value as Partial<SealedBundle> | null;
	const kdf = v?.kdf;
	if (
		v?.format !== BUNDLE_FORMAT ||
		v.cipher !== "aes-256-gcm" ||
		kdf?.name !== "scrypt" ||
		![kdf.N, kdf.r, kdf.p].every(Number.isInteger) ||
		// Refuse parameters that would let a crafted file pin the thread pool or memory.
		kdf.N > 2 ** 17 ||
		kdf.r > 8 ||
		kdf.p > 2 ||
		typeof kdf.salt !== "string" ||
		typeof v.iv !== "string" ||
		typeof v.tag !== "string" ||
		typeof v.data !== "string"
	) {
		throw new BundleError("BUNDLE_INVALID", "Not a NarraFork credential bundle");
	}
	return v as SealedBundle;
}

export async function openBundle(text: string, passphrase: string): Promise<BundleContents> {
	if (Buffer.byteLength(text) > MAX_BUNDLE_BYTES) {
		throw new BundleError("BUNDLE_TOO_LARGE", "The file is too large to be a credential bundle");
	}
	const sealed = parseSealed(text);
	const key = await deriveKey(passphrase, Buffer.from(sealed.kdf.salt, "base64"), sealed.kdf);
	let plain: string;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
		decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
		plain = Buffer.concat([
			decipher.update(Buffer.from(sealed.data, "base64")),
			decipher.final(),
		]).toString("utf8");
	} catch {
		throw new BundleError("BUNDLE_PASSPHRASE", "Wrong passphrase, or the file was altered");
	}
	const contents = JSON.parse(plain) as Partial<BundleContents>;
	if (!Array.isArray(contents.items)) {
		throw new BundleError("BUNDLE_INVALID", "Not a NarraFork credential bundle");
	}
	return {
		exportedAt: Number(contents.exportedAt) || sealed.exportedAt,
		items: contents.items.filter(
			(item): item is BundleItem =>
				!!item && typeof item.kind === "string" && typeof item.id === "string",
		),
	};
}
