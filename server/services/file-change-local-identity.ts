import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";

/** Shared by read-only workers and guarded writers; no application initialization. */
export class LocalFileValidationError extends Error {
	constructor(
		message: string,
		readonly toolOutput?: string,
	) {
		super(message);
		this.name = "LocalFileValidationError";
	}
}

/**
 * The VOLUME cannot identify objects at all (e.g. FAT/exFAT or some network shares
 * on Windows), as opposed to one object failing validation. Callers that only need
 * evidence as an optional extra can tell "nothing is recordable here" from a real
 * mismatch by this type. `name` stays "LocalFileValidationError": diagnostics
 * whitelist error names, and every existing handler treats it as that class.
 */
export class LocalObjectIdentityUnavailableError extends LocalFileValidationError {}

export function localObjectIdentity(stat: BigIntStats): string {
	if (stat.ino === 0n && stat.dev === 0n)
		throw new LocalObjectIdentityUnavailableError(
			"Local filesystem does not expose an object identity",
		);
	// Without a creation timestamp, recycled dev/ino values cannot distinguish
	// workspace incarnations. Do not invent continuity from mtime/ctime instead.
	if (stat.birthtimeNs <= 0n)
		throw new LocalObjectIdentityUnavailableError(
			"Local filesystem does not expose a valid creation time",
		);
	return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

export async function localDirectoryIdentity(path: string): Promise<string> {
	const stat = await lstat(path, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new LocalFileValidationError("Canonical workspace root is not a directory");
	return localObjectIdentity(stat);
}
