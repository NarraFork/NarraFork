import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { requireApplicationDataDirectory } from "@server/lib/data-directory-security";
import type { BackupManifest, BackupState } from "./contract";

const KEY_FILE = "attestation-v1.key";
const DOMAIN = "narrafork-narrator-attestation-v1";

/** Worker-only private application key. Never placed in an archive or returned to HTTP.
 * Verification never initializes a missing key: losing it invalidates old offline proofs.
 * Atomic no-clobber publication prevents competing exports from rotating the key.
 */
export async function backupAttestationKey(
	directory: string,
	initialize: boolean,
	check: () => void,
): Promise<Buffer | undefined> {
	if (!isAbsolute(directory)) throw new Error("Backup proof directory must be absolute");
	check();
	if (initialize) await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		await requireApplicationDataDirectory(directory);
	} catch (error) {
		if (!initialize && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const path = join(directory, KEY_FILE);
	const read = async () => {
		check();
		const before = await lstat(path);
		if (!before.isFile() || before.isSymbolicLink()) throw new Error("Unsafe backup proof key");
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await file.stat();
			if (
				!stat.isFile() ||
				stat.dev !== before.dev ||
				stat.ino !== before.ino ||
				stat.size !== 32 ||
				(process.platform !== "win32" &&
					(stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0))
			)
				throw new Error("Unsafe backup proof key");
			const bytes = Buffer.alloc(33);
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			check();
			if (bytesRead !== 32) throw new Error("Invalid backup proof key");
			return bytes.subarray(0, 32);
		} finally {
			await file.close();
		}
	};
	try {
		return await read();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (!initialize) return undefined;
	}
	const staging = join(directory, `${randomUUID()}.key-staging`);
	const file = await open(
		staging,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
		0o600,
	);
	try {
		await file.writeFile(randomBytes(32));
		await file.sync();
		check();
		try {
			await link(staging, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (process.platform !== "win32") {
			const parent = await open(directory, constants.O_RDONLY);
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		}
	} finally {
		await file.close();
		await unlink(staging);
	}
	return read();
}

function canonical(value: unknown, depth = 0): string {
	if (depth > 128) throw new Error("Backup proof nesting limit exceeded");
	if (Array.isArray(value))
		return `[${value.map((entry) => canonical(entry, depth + 1)).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, depth + 1)}`)
			.join(",")}}`;
	const text = JSON.stringify(value);
	if (text === undefined) throw new Error("Invalid backup proof value");
	return text;
}

/** Length-framed canonical manifest + every state row; manifest object digests are
 * checked against actual bytes by artifact.ts BEFORE this proof is trusted. No whole
 * file checksum self-reference, SQLite layout dependence, or unbounded proof catalog.
 */
export function signBackupPayload(
	key: Buffer,
	manifest: BackupManifest,
	state: BackupState,
	check: () => void,
): string {
	const hmac = createHmac("sha256", key);
	const frame = (text: string) => hmac.update(`${Buffer.byteLength(text)}:`).update(text);
	frame(DOMAIN);
	const { attestation: _attestation, ...unsigned } = manifest;
	frame(canonical(unsigned));
	for (const table of Object.keys(state.rows).sort()) {
		frame(table);
		const rows = [...(state.rows[table as keyof BackupState["rows"]] ?? [])].sort((a, b) =>
			String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0,
		);
		frame(String(rows.length));
		for (const row of rows) {
			check();
			frame(canonical(row));
		}
	}
	return hmac.digest("hex");
}

export function verifyBackupPayload(
	key: Buffer | undefined,
	manifest: BackupManifest,
	state: BackupState,
	check: () => void,
): boolean {
	const proof = manifest.attestation;
	if (
		!key ||
		!proof ||
		proof.algorithm !== "hmac-sha256-v1" ||
		typeof proof.signature !== "string" ||
		!/^[a-f0-9]{64}$/.test(proof.signature)
	)
		return false;
	return timingSafeEqual(
		Buffer.from(proof.signature, "hex"),
		Buffer.from(signBackupPayload(key, manifest, state, check), "hex"),
	);
}
