import { createHash, type KeyObject, verify as verifySignature } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export interface PluginFileDigest {
	path: string;
	sha256: string;
}

export interface PluginSignature {
	algorithm: "ed25519";
	keyId: string;
	signature: string;
	signedAt?: string;
	publisherId?: string;
	pluginId: string;
	version: string;
	packageDigest: string;
	files?: readonly PluginFileDigest[];
}

export interface TrustedPluginKey {
	keyId: string;
	publicKey: string | KeyObject;
	pluginIds?: readonly string[];
	revokedAt?: string;
}

export function parsePluginSignature(value: unknown): PluginSignature {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("signature.json must be a JSON object");
	}
	const object = value as Record<string, unknown>;
	if (object.algorithm !== "ed25519") throw new Error("signature.json algorithm is unsupported");
	for (const field of ["keyId", "signature", "pluginId", "version", "packageDigest"]) {
		if (typeof object[field] !== "string" || !object[field]) {
			throw new Error(`signature.json ${field} is required`);
		}
	}
	const packageDigest = (object.packageDigest as string).replace(/^sha256:/, "");
	if (!/^[a-f0-9]{64}$/.test(packageDigest)) {
		throw new Error("signature.json packageDigest is invalid");
	}
	if (object.signedAt !== undefined && typeof object.signedAt !== "string") {
		throw new Error("signature.json signedAt is invalid");
	}
	if (object.publisherId !== undefined && typeof object.publisherId !== "string") {
		throw new Error("signature.json publisherId is invalid");
	}
	let files: PluginFileDigest[] | undefined;
	if (object.files !== undefined) {
		if (!Array.isArray(object.files)) throw new Error("signature.json files is invalid");
		files = object.files.map((entry, index) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new Error(`signature.json file ${index} is invalid`);
			}
			const item = entry as Record<string, unknown>;
			if (typeof item.path !== "string" || typeof item.sha256 !== "string") {
				throw new Error(`signature.json file ${index} is invalid`);
			}
			if (!/^[a-f0-9]{64}$/.test(item.sha256)) {
				throw new Error(`signature.json file ${index} digest is invalid`);
			}
			return { path: item.path, sha256: item.sha256 };
		});
	}
	return {
		algorithm: "ed25519",
		keyId: object.keyId as string,
		signature: object.signature as string,
		pluginId: object.pluginId as string,
		version: object.version as string,
		packageDigest,
		signedAt: object.signedAt as string | undefined,
		publisherId: object.publisherId as string | undefined,
		files,
	};
}

export interface SignatureVerificationResult {
	valid: boolean;
	trusted: boolean;
	keyId?: string;
	packageDigest: string;
	reason?: string;
}

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
		.join(",")}}`;
}

function decodeSignature(value: string): Buffer {
	try {
		return Buffer.from(value, /^[A-Za-z0-9_-]+$/.test(value) ? "base64url" : "base64");
	} catch {
		return Buffer.alloc(0);
	}
}

export function createPluginSignaturePayload(
	input: Omit<PluginSignature, "signature" | "signedAt">,
): Buffer {
	return Buffer.from(
		canonicalize({
			algorithm: input.algorithm,
			keyId: input.keyId,
			pluginId: input.pluginId,
			version: input.version,
			packageDigest: input.packageDigest,
			files: input.files ?? [],
		}),
		"utf8",
	);
}

export class PluginTrustKeyring {
	private readonly keys = new Map<string, TrustedPluginKey>();
	constructor(keys: readonly TrustedPluginKey[] = []) {
		for (const key of keys) this.add(key);
	}
	add(key: TrustedPluginKey): void {
		if (!key.keyId || this.keys.has(key.keyId))
			throw new Error(`Duplicate plugin trust key: ${key.keyId}`);
		this.keys.set(key.keyId, key);
	}
	get(keyId: string): TrustedPluginKey | undefined {
		return this.keys.get(keyId);
	}
	isTrusted(keyId: string, pluginId?: string): boolean {
		const key = this.keys.get(keyId);
		return Boolean(
			key && !key.revokedAt && (!pluginId || !key.pluginIds || key.pluginIds.includes(pluginId)),
		);
	}
}

export function verifyPluginSignature(
	signature: PluginSignature,
	keyring: PluginTrustKeyring,
): SignatureVerificationResult {
	const key = keyring.get(signature.keyId);
	if (signature.algorithm !== "ed25519")
		return {
			valid: false,
			trusted: false,
			keyId: signature.keyId,
			packageDigest: signature.packageDigest,
			reason: "UNSUPPORTED_ALGORITHM",
		};
	if (!key || key.revokedAt)
		return {
			valid: false,
			trusted: false,
			keyId: signature.keyId,
			packageDigest: signature.packageDigest,
			reason: "UNKNOWN_OR_REVOKED_KEY",
		};
	if (key.pluginIds && !key.pluginIds.includes(signature.pluginId))
		return {
			valid: false,
			trusted: false,
			keyId: signature.keyId,
			packageDigest: signature.packageDigest,
			reason: "KEY_PLUGIN_MISMATCH",
		};
	let valid = false;
	try {
		valid = verifySignature(
			null,
			createPluginSignaturePayload(signature),
			key.publicKey,
			decodeSignature(signature.signature),
		);
	} catch {
		valid = false;
	}
	return {
		valid,
		trusted: valid && keyring.isTrusted(signature.keyId, signature.pluginId),
		keyId: signature.keyId,
		packageDigest: signature.packageDigest,
		reason: valid ? undefined : "INVALID_SIGNATURE",
	};
}

export async function digestPluginDirectory(
	root: string,
): Promise<{ packageDigest: string; files: PluginFileDigest[] }> {
	const files: PluginFileDigest[] = [];
	const walk = async (directory: string): Promise<void> => {
		const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			const path = join(directory, entry.name);
			const relativePath = relative(root, path).split("\\").join("/");
			// The signature envelope cannot sign its own bytes. Keep the existing
			// package format while binding every other package file to the signature.
			if (relativePath === "signature.json") continue;
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) {
				const hash = createHash("sha256");
				const stream = createReadStream(path);
				for await (const chunk of stream) hash.update(chunk);
				files.push({
					path: relative(root, path).split("\\").join("/"),
					sha256: hash.digest("hex"),
				});
			}
		}
	};
	await walk(root);
	files.sort((a, b) => a.path.localeCompare(b.path));
	return { files, packageDigest: createHash("sha256").update(canonicalize(files)).digest("hex") };
}

export async function verifyPluginDigest(root: string, expectedDigest: string): Promise<boolean> {
	const result = await digestPluginDirectory(root);
	return result.packageDigest === expectedDigest.replace(/^sha256:/, "");
}

export async function verifyPluginPackageSignature(
	root: string,
	signature: PluginSignature,
	keyring: PluginTrustKeyring,
): Promise<SignatureVerificationResult> {
	const digest = await digestPluginDirectory(root);
	const expected = signature.packageDigest.replace(/^sha256:/, "");
	if (digest.packageDigest !== expected)
		return {
			valid: false,
			trusted: false,
			keyId: signature.keyId,
			packageDigest: digest.packageDigest,
			reason: "DIGEST_MISMATCH",
		};
	return verifyPluginSignature(
		{ ...signature, packageDigest: digest.packageDigest, files: digest.files },
		keyring,
	);
}
