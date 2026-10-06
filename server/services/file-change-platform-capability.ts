import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { getNarraforkHome } from "../lib/narrafork-home";
import { localObjectIdentity } from "./file-change-local-io";

/**
 * Verified file rollback relies on stable per-object identity (dev:ino:birthtime)
 * and accurate link counts. POSIX filesystems provide both. On Windows they come
 * from NTFS FileIndex/NumberOfLinks through libuv, but FAT/exFAT and many network
 * shares report 0 or synthetic values. Probe the real data volume once instead of
 * letting every rollback fail halfway through a multi-file transaction.
 *
 * This is an admission check only. Every restore still re-measures identities and
 * refuses on mismatch; a passed probe never weakens those per-file checks.
 */
export type FileChangePlatformCapability =
	| { supported: true; platform: NodeJS.Platform }
	| { supported: false; platform: NodeJS.Platform; reason: string };

/** Injectable FS surface so the Windows branch can be exercised on any host. */
export interface PlatformProbeFs {
	mkdir(path: string, options: { recursive: true }): Promise<unknown>;
	mkdtemp(prefix: string): Promise<string>;
	writeFile(path: string, data: string): Promise<void>;
	lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
	open(
		path: string,
		flags: string,
	): Promise<{
		stat(options: { bigint: true }): Promise<BigIntStats>;
		close(): Promise<void>;
	}>;
	link(existing: string, created: string): Promise<void>;
	rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

export interface PlatformProbeOptions {
	platform?: NodeJS.Platform;
	root?: string;
	fs?: PlatformProbeFs;
}

let cached: Promise<FileChangePlatformCapability> | undefined;
let probe: () => Promise<FileChangePlatformCapability> = () => probeFileChangePlatform();

/** POSIX needs no probe: identity and nlink semantics are part of the contract. */
export function probeFileChangePlatform(
	options: PlatformProbeOptions = {},
): Promise<FileChangePlatformCapability> {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return Promise.resolve({ supported: true, platform });
	return runProbe(platform, options.root ?? getNarraforkHome(), options.fs ?? fs);
}

/**
 * Process-wide cached admission. Only a VERDICT is cached (supported, or a volume
 * property that will not change). A probe that threw — EBUSY from an antivirus
 * scan, a full disk — says nothing about the volume, so it is reported for this
 * call and probed again next time instead of disabling rollback until restart.
 */
export function fileChangePlatformCapability(): Promise<FileChangePlatformCapability> {
	if (cached) return cached;
	const attempt = probe().catch((error: unknown): FileChangePlatformCapability => {
		if (cached === attempt) cached = undefined;
		return {
			supported: false,
			platform: process.platform,
			reason: `probe_failed:${(error as NodeJS.ErrnoException)?.code ?? "unknown"}`,
		};
	});
	cached = attempt;
	return attempt;
}

/** Test-only: reset the cache, optionally replacing the probe (null restores it). */
export function resetFileChangePlatformCapabilityForTests(
	replacement?: (() => Promise<FileChangePlatformCapability>) | null,
): void {
	cached = undefined;
	probe = replacement ?? (() => probeFileChangePlatform());
}

async function runProbe(
	platform: NodeJS.Platform,
	root: string,
	io: PlatformProbeFs,
): Promise<FileChangePlatformCapability> {
	const unsupported = (reason: string): FileChangePlatformCapability => ({
		supported: false,
		platform,
		reason,
	});
	await io.mkdir(root, { recursive: true }).catch(() => {});
	const directory = await io.mkdtemp(join(root, ".file-change-probe-"));
	try {
		const first = join(directory, "a");
		const second = join(directory, "b");
		await io.writeFile(first, "probe");
		const entry = await io.lstat(first, { bigint: true });
		let identity: string;
		try {
			identity = localObjectIdentity(entry);
		} catch {
			return unsupported("object_identity_unavailable");
		}
		if (!entry.isFile() || entry.nlink !== 1n) return unsupported("link_count_unreliable");
		const handle = await io.open(first, "r");
		try {
			const opened = await handle.stat({ bigint: true });
			let openedIdentity: string;
			try {
				openedIdentity = localObjectIdentity(opened);
			} catch {
				return unsupported("object_identity_unavailable");
			}
			if (openedIdentity !== identity) return unsupported("descriptor_identity_mismatch");
		} finally {
			await handle.close();
		}
		try {
			await io.link(first, second);
		} catch {
			return unsupported("hard_links_unavailable");
		}
		const linked = await io.lstat(first, { bigint: true });
		const alias = await io.lstat(second, { bigint: true });
		// nlink must be real: a constant 1 would let multiply-linked files pass `regular()`.
		if (linked.nlink !== 2n || alias.nlink !== 2n) return unsupported("link_count_unreliable");
		try {
			if (localObjectIdentity(alias) !== identity) return unsupported("object_identity_unstable");
		} catch {
			return unsupported("object_identity_unavailable");
		}
		return { supported: true, platform };
	} finally {
		await io.rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}
