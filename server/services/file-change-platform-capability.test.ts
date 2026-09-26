import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { testEnvironment } from "../../tests/preload";
import {
	type FileChangePlatformCapability,
	fileChangePlatformCapability,
	type PlatformProbeFs,
	probeFileChangePlatform,
	resetFileChangePlatformCapabilityForTests,
} from "./file-change-platform-capability";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(join(testEnvironment.isolatedHome, "platform-probe-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** Real FS with stat results rewritten, to model Windows volumes on any host. */
function patchedFs(rewrite: (stat: BigIntStats, path: string) => BigIntStats): PlatformProbeFs {
	return {
		mkdir: (path, options) => fs.mkdir(path, options),
		mkdtemp: (prefix) => fs.mkdtemp(prefix),
		writeFile: (path, data) => fs.writeFile(path, data),
		lstat: async (path, options) => rewrite(await fs.lstat(path, options), path),
		open: async (path, flags) => {
			const handle = await fs.open(path, flags);
			return {
				stat: async (options) => rewrite(await handle.stat(options), path),
				close: () => handle.close(),
			};
		},
		link: (existing, created) => fs.link(existing, created),
		rm: (path, options) => fs.rm(path, options),
	};
}
function withStat(stat: BigIntStats, overrides: Partial<Record<keyof BigIntStats, bigint>>) {
	return new Proxy(stat, {
		get(target, key, receiver) {
			if (typeof key === "string" && key in overrides)
				return overrides[key as keyof typeof overrides];
			const value = Reflect.get(target, key, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("file-change platform capability", () => {
	test("non-Windows platforms are supported without touching the filesystem", async () => {
		const result = await probeFileChangePlatform({
			platform: "linux",
			root: join(root, "never-created"),
		});
		expect(result).toEqual({ supported: true, platform: "linux" });
		expect(await fs.readdir(root)).toEqual([]);
	});

	test("a Windows volume with real identities and link counts is supported", async () => {
		const result = await probeFileChangePlatform({ platform: "win32", root });
		expect(result).toEqual({ supported: true, platform: "win32" });
		// The probe cleans up after itself.
		expect(await fs.readdir(root)).toEqual([]);
	});

	test("zero dev/ino (FAT/exFAT, some SMB shares) is refused", async () => {
		const result = await probeFileChangePlatform({
			platform: "win32",
			root,
			fs: patchedFs((stat) => withStat(stat, { dev: 0n, ino: 0n })),
		});
		expect(result).toMatchObject({ supported: false, reason: "object_identity_unavailable" });
		expect(await fs.readdir(root)).toEqual([]);
	});

	test("a missing creation time is refused", async () => {
		const result = await probeFileChangePlatform({
			platform: "win32",
			root,
			fs: patchedFs((stat) => withStat(stat, { birthtimeNs: 0n })),
		});
		expect(result).toMatchObject({ supported: false, reason: "object_identity_unavailable" });
	});

	test("a constant link count cannot pass as a single-link guarantee", async () => {
		const result = await probeFileChangePlatform({
			platform: "win32",
			root,
			fs: patchedFs((stat) => withStat(stat, { nlink: 1n })),
		});
		expect(result).toMatchObject({ supported: false, reason: "link_count_unreliable" });
	});

	test("a descriptor that reports another object identity is refused", async () => {
		let calls = 0;
		const base = patchedFs((stat) => stat);
		const io: PlatformProbeFs = {
			...base,
			open: async (path, flags) => {
				const handle = await base.open(path, flags);
				return {
					stat: async (options) =>
						withStat(await handle.stat(options), { ino: BigInt(++calls) + 10_000_000n }),
					close: () => handle.close(),
				};
			},
		};
		const result = await probeFileChangePlatform({ platform: "win32", root, fs: io });
		expect(result).toMatchObject({ supported: false, reason: "descriptor_identity_mismatch" });
	});

	test("a volume without hard links is refused", async () => {
		const base = patchedFs((stat) => stat);
		const result = await probeFileChangePlatform({
			platform: "win32",
			root,
			fs: {
				...base,
				link: async () => {
					throw Object.assign(new Error("not supported"), { code: "EPERM" });
				},
			},
		});
		expect(result).toMatchObject({ supported: false, reason: "hard_links_unavailable" });
		expect(await fs.readdir(root)).toEqual([]);
	});

	test("the probe creates a missing root through the injected filesystem", async () => {
		const created: string[] = [];
		const base = patchedFs((stat) => stat);
		const nested = join(root, "missing", "home");
		const result = await probeFileChangePlatform({
			platform: "win32",
			root: nested,
			fs: {
				...base,
				mkdir: async (path, options) => {
					created.push(path);
					return base.mkdir(path, options);
				},
			},
		});
		expect(result).toEqual({ supported: true, platform: "win32" });
		expect(created).toEqual([nested]);
	});
});

describe("cached platform admission", () => {
	afterEach(() => resetFileChangePlatformCapabilityForTests(null));

	const counting = (outcome: () => Promise<FileChangePlatformCapability>) => {
		const calls = { count: 0 };
		resetFileChangePlatformCapabilityForTests(() => {
			calls.count++;
			return outcome();
		});
		return calls;
	};

	test("a verdict is cached for the process", async () => {
		const unsupported = {
			supported: false as const,
			platform: "win32" as const,
			reason: "object_identity_unavailable",
		};
		const calls = counting(async () => unsupported);
		expect(await fileChangePlatformCapability()).toEqual(unsupported);
		expect(await fileChangePlatformCapability()).toEqual(unsupported);
		expect(calls.count).toBe(1);
	});

	test("a probe that threw is reported but re-probed on the next call", async () => {
		let fail = true;
		const calls = counting(async () => {
			if (fail) throw Object.assign(new Error("busy"), { code: "EBUSY" });
			return { supported: true, platform: "win32" };
		});
		expect(await fileChangePlatformCapability()).toMatchObject({
			supported: false,
			reason: "probe_failed:EBUSY",
		});
		fail = false;
		expect(await fileChangePlatformCapability()).toEqual({ supported: true, platform: "win32" });
		expect(await fileChangePlatformCapability()).toEqual({ supported: true, platform: "win32" });
		expect(calls.count).toBe(2);
	});

	test("concurrent callers share one in-flight probe", async () => {
		let release: (value: FileChangePlatformCapability) => void = () => {};
		const calls = counting(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const first = fileChangePlatformCapability();
		const second = fileChangePlatformCapability();
		release({ supported: true, platform: "win32" });
		expect(await first).toEqual(await second);
		expect(calls.count).toBe(1);
	});
});
