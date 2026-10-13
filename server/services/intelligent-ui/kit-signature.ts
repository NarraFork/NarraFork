import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getNarraforkPath } from "@server/lib/narrafork-home";

/**
 * Proof that a component kit bundle is one the host built.
 *
 * Everything under the workspace, `kit.meta.json` included, can be written by the agent.
 * The key that signs the metadata lives in the NarraFork home instead, which the agent's
 * file tools do not reach, so a bundle is served only when the host itself recorded it.
 * The signature also names the workspace, so a copy into another workspace does not verify.
 */
const KEY_FILE = "intelligent-ui-kit-signing.key";
const KEY_BYTES = 32;
const SIGNATURE = /^[0-9a-f]{64}$/;

/** The signed fields of `kit.meta.json`, plus digests of the files it names. */
export interface KitSignedFields {
	version: 1;
	/** `workspaceKey` of the workspace this build was approved for. */
	workspace: string;
	fingerprint: string;
	hash: string;
	builtAt: string;
	components: string[];
	hasSetup: boolean;
	js: string;
	css: string | null;
	generation: number;
	/** Hex sha256 of the JS file's bytes. */
	jsSha256: string;
	/** Hex sha256 of the CSS file's bytes; "" when there is no CSS. */
	cssSha256: string;
}

let cached: { path: string; key: Promise<Buffer> } | undefined;

function errorCode(error: unknown): unknown {
	return error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
}

async function readKey(path: string): Promise<Buffer> {
	// Another process may have created the file and not written it yet.
	for (let attempt = 0; ; attempt++) {
		const key = await readFile(path);
		if (key.length === KEY_BYTES) return key;
		if (attempt >= 5) throw new Error("Intelligent UI kit signing key is corrupt");
		await Bun.sleep(20);
	}
}

async function loadKey(path: string): Promise<Buffer> {
	try {
		return await readKey(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const key = randomBytes(KEY_BYTES);
	try {
		await writeFile(path, key, { flag: "wx", mode: 0o600 });
		return key;
	} catch (error) {
		// Lost the race to create it: the winner's key is the key.
		if (errorCode(error) !== "EEXIST") throw error;
		return readKey(path);
	}
}

function signingKey(): Promise<Buffer> {
	const path = getNarraforkPath(KEY_FILE);
	if (cached?.path !== path) {
		const key = loadKey(path);
		cached = { path, key };
		const entry = cached;
		// A failure is not remembered: the next sign or verify tries again.
		key.catch(() => {
			if (cached === entry) cached = undefined;
		});
	}
	return cached.key;
}

/** Hex sha256 of a file's bytes, as recorded in the signed fields. */
export function kitFileSha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The exact text that is signed: fixed key order, nothing that is not listed. */
export function canonicalKitBody(fields: KitSignedFields): string {
	return JSON.stringify({
		version: 1,
		workspace: fields.workspace,
		fingerprint: fields.fingerprint,
		hash: fields.hash,
		builtAt: fields.builtAt,
		components: fields.components,
		hasSetup: fields.hasSetup,
		js: fields.js,
		css: fields.css,
		generation: fields.generation,
		jsSha256: fields.jsSha256,
		cssSha256: fields.cssSha256,
	});
}

function mac(key: Buffer, fields: KitSignedFields): Buffer {
	return createHmac("sha256", key).update(canonicalKitBody(fields)).digest();
}

/** Hex HMAC-SHA256 of the canonical body under the host's key. */
export async function signKitFields(fields: KitSignedFields): Promise<string> {
	return mac(await signingKey(), fields).toString("hex");
}

/** False for anything but this host's signature over exactly these fields. Never throws. */
export async function verifyKitFields(
	fields: KitSignedFields,
	signature: unknown,
): Promise<boolean> {
	if (typeof signature !== "string" || !SIGNATURE.test(signature)) return false;
	let key: Buffer;
	try {
		key = await signingKey();
	} catch {
		return false;
	}
	const expected = mac(key, fields);
	const given = Buffer.from(signature, "hex");
	return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Test seam: forget the cached key. The key file itself is left alone. */
export function resetKitSigningKeyForTest(): void {
	cached = undefined;
}
