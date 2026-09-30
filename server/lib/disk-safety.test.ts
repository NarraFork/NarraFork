import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, type realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileChangeLocalIo } from "../services/file-change-local-io";
import { localBackend } from "./agent/execution/local-backend";
import {
	canWriteOptionalDiskData,
	DiskSpaceError,
	DiskSpaceMonitor,
	diskLevel,
	diskSafetySettings,
	diskSpaceMonitor,
	isDiskFullError,
	resolveDiskVolume,
} from "./disk-safety";
import { DEFAULT_DISK_SAFETY } from "./disk-safety-config";
import { settings } from "./settings";
import { diskSafetySettingsSchema } from "./validators/settings";

const MB = 1024 * 1024;
const config = { ...DEFAULT_DISK_SAFETY };
const originalSettings = settings.diskSafety;
const originalAssess = diskSpaceMonitor.assess;
const originalGuard = diskSpaceMonitor.guardWrite;
afterEach(() => {
	settings.diskSafety = originalSettings;
	diskSpaceMonitor.assess = originalAssess;
	diskSpaceMonitor.guardWrite = originalGuard;
});

function probe(freeMb = 2048) {
	let clock = 1000;
	const resolveVolume = mock(async (path: string) => ({
		key: path.startsWith("/other") ? "other" : "root",
		mountPath: path.startsWith("/other") ? "/other" : "/",
	}));
	const statVolume = mock(async () => ({ freeBytes: freeMb * MB, totalBytes: 10000 * MB }));
	return {
		monitor: new DiskSpaceMonitor({ resolveVolume, statVolume, now: () => clock }),
		resolveVolume,
		statVolume,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("disk monitor", () => {
	test("many paths and concurrent tools on the same disk share one space query", async () => {
		const p = probe();
		await Promise.all(
			["/home", "/workspace", "/file"].map((path) => p.monitor.assess(path, config)),
		);
		expect(p.statVolume).toHaveBeenCalledTimes(1);
		await p.monitor.assess("/home", config);
		expect(p.resolveVolume).toHaveBeenCalledTimes(3);
		await p.monitor.assess("/other/file", config);
		expect(p.statVolume).toHaveBeenCalledTimes(2);
		p.advance(config.checkIntervalMs);
		await p.monitor.assess("/workspace", config);
		expect(p.statVolume).toHaveBeenCalledTimes(3);
		expect(p.resolveVolume).toHaveBeenCalledTimes(4);
		p.advance(config.pathCacheTtlMs);
		await p.monitor.assess("/home", config);
		expect(p.resolveVolume).toHaveBeenCalledTimes(5);
	});

	test("failed statfs is unknown and failures are throttled", async () => {
		const stats = mock(async () => {
			throw new Error("unsupported");
		});
		const monitor = new DiskSpaceMonitor({
			resolveVolume: async () => ({ key: "disk", mountPath: "/" }),
			statVolume: stats,
			now: () => 1000,
		});
		expect((await monitor.assess("/a", config)).level).toBe("unknown");
		expect((await monitor.assess("/b", config)).level).toBe("unknown");
		expect(stats).toHaveBeenCalledTimes(1);
	});

	test("deadline and in-flight cap bound a hung network filesystem without repeated probes", async () => {
		const resolver = mock(() => new Promise<never>(() => {}));
		const monitor = new DiskSpaceMonitor({
			resolveVolume: resolver,
			statVolume: mock(async () => ({ freeBytes: 0, totalBytes: 1 })),
			now: Date.now,
		});
		const short = { ...config, probeTimeoutMs: 5 };
		const start = Date.now();
		const results = await Promise.all(
			Array.from({ length: 40 }, (_, i) => monitor.assess(`/hang/${i}`, short)),
		);
		expect(results.every((r) => r.level === "unknown")).toBe(true);
		expect(resolver).toHaveBeenCalledTimes(16);
		await monitor.assess("/hang/0", short);
		expect(resolver).toHaveBeenCalledTimes(16);
		expect(Date.now() - start).toBeLessThan(500);
	});

	test("charges concurrent writes until the next refresh, including the WAL reserve", async () => {
		const p = probe(400);
		await p.monitor.guardWrite("/a", 100 * MB, config);
		const writes = await Promise.allSettled([
			p.monitor.guardWrite("/b", 100 * MB, config),
			p.monitor.guardWrite("/c", 100 * MB, config),
		]);
		expect(writes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(writes.filter((r) => r.status === "rejected")).toHaveLength(1);
		p.advance(config.checkIntervalMs);
		await expect(p.monitor.guardWrite("/a", 380 * MB, config)).rejects.toBeInstanceOf(
			DiskSpaceError,
		);
		expect(p.statVolume).toHaveBeenCalledTimes(2);
	});

	test("actual ENOSPC invalidates a healthy cache until the next refresh", async () => {
		const p = probe();
		await p.monitor.assess("/a", config);
		p.monitor.noteDiskFull("/a");
		expect((await p.monitor.assess("/b", config)).level).toBe("critical");
		await expect(p.monitor.guardWrite("/b", 1, config)).rejects.toBeInstanceOf(DiskSpaceError);
		p.advance(config.checkIntervalMs);
		expect((await p.monitor.assess("/a", config)).level).toBe("ok");
	});

	test("warn/off overrides do not reject and off does not call the OS", async () => {
		const p = probe(0);
		await p.monitor.guardWrite("/a", MB, { ...config, mode: "warn" });
		await p.monitor.assess("/a", { ...config, mode: "off" });
		expect(p.resolveVolume).not.toHaveBeenCalled();
	});

	test("warning/block/critical boundaries and percentage warning are distinct", () => {
		const disk = { key: "d", mountPath: "/", totalBytes: 10000 * MB, checkedAt: 1, freeBytes: 0 };
		for (const [freeMb, level] of [
			[64, "critical"],
			[256, "blocked"],
			[1024, "warning"],
			[2000, "ok"],
		] as const)
			expect(diskLevel({ ...disk, freeBytes: freeMb * MB }, config)).toBe(level);
		expect(diskLevel({ ...disk, totalBytes: 100000 * MB, freeBytes: 2000 * MB }, config)).toBe(
			"warning",
		);
		expect(diskLevel(null, config)).toBe("unknown");
	});
});

describe("filesystem identity and last-mile protection", () => {
	test("symlinks and nonexistent write targets use their real existing partition", async () => {
		const root = await mkdtemp(join(tmpdir(), "nf-disk-safety-"));
		try {
			await writeFile(join(root, "existing"), "before");
			await symlink(root, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
			const existing = await resolveDiskVolume(join(root, "existing"));
			const missing = await resolveDiskVolume(join(root, "alias", "new", "file"));
			expect(missing.key).toBe(existing.key);
			expect(missing.mountPath).toBe(existing.mountPath);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("Windows drive/mounted-volume boundaries group by volume identity, not path strings", async () => {
		const fs = {
			realpath: mock(async (path: string) => path) as unknown as typeof realpath,
			stat: mock(async (path: string) => ({
				dev: path.startsWith("C:\\mounted") ? 22 : 11,
				isDirectory: () => true,
			})) as unknown as typeof stat,
		};
		expect(await resolveDiskVolume("C:\\mounted\\work", "win32", fs)).toEqual({
			key: "win32:22",
			mountPath: "C:\\mounted",
		});
		expect(await resolveDiskVolume("C:\\normal", "win32", fs)).toEqual({
			key: "win32:11",
			mountPath: "C:\\",
		});
	});

	test("legacy writer refuses before truncating an existing file", async () => {
		const root = await mkdtemp(join(tmpdir(), "nf-disk-write-"));
		const file = join(root, "file");
		try {
			await writeFile(file, "preserve me");
			diskSpaceMonitor.guardWrite = mock(async (path) => {
				throw new DiskSpaceError(path);
			});
			await expect(localBackend.writeFileBytes(file, new Uint8Array([1]))).rejects.toBeInstanceOf(
				DiskSpaceError,
			);
			expect(await readFile(file, "utf8")).toBe("preserve me");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("evidence writer rejects before create or truncate and leaves dispatch unclaimed", async () => {
		const root = await mkdtemp(join(tmpdir(), "nf-disk-io-"));
		try {
			for (const initial of ["original", null]) {
				const file = join(root, initial ? "existing" : "new-dir/new-file");
				if (initial) await writeFile(file, initial);
				const before = await fileChangeLocalIo.read(file);
				diskSpaceMonitor.guardWrite = mock(async (path) => {
					throw new DiskSpaceError(path);
				});
				const dispatch = mock(() => {});
				const result = await fileChangeLocalIo.apply({
					backend: localBackend,
					lexicalPath: file,
					canonicalPath: file,
					before,
					nextBytes: Buffer.from("replacement"),
					signal: new AbortController().signal,
					assertTarget: async () => {},
					onDispatch: dispatch,
				});
				expect(result).toMatchObject({ kind: "not_applied", error: expect.any(DiskSpaceError) });
				expect(dispatch).not.toHaveBeenCalled();
				if (initial) expect(await readFile(file, "utf8")).toBe(initial);
				else await expect(stat(join(root, "new-dir"))).rejects.toMatchObject({ code: "ENOENT" });
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("optional snapshots/dumps shed byte-pressure but not percentage-only warnings", async () => {
		settings.diskSafety = { ...config };
		diskSpaceMonitor.assess = mock(async (path) => ({
			path,
			level: "warning" as const,
			space: {
				key: "d",
				mountPath: "/",
				freeBytes: 500 * MB,
				totalBytes: 10000 * MB,
				checkedAt: 1,
			},
		}));
		expect(await canWriteOptionalDiskData("/snapshot")).toBe(false);
		diskSpaceMonitor.assess = mock(async (path) => ({
			path,
			level: "warning" as const,
			space: {
				key: "d",
				mountPath: "/",
				freeBytes: 2000 * MB,
				totalBytes: 100000 * MB,
				checkedAt: 1,
			},
		}));
		expect(await canWriteOptionalDiskData("/snapshot")).toBe(true);
		settings.diskSafety.mode = "warn";
		expect(await canWriteOptionalDiskData("/snapshot")).toBe(true);
	});
});

describe("disk errors and settings", () => {
	test("recognizes native/quota/SQLite/caused errors, not inotify or arbitrary I/O failures", () => {
		for (const code of ["ENOSPC", "EDQUOT", "SQLITE_FULL"])
			expect(isDiskFullError({ code })).toBe(true);
		expect(isDiskFullError(new Error("outer", { cause: { code: "ENOSPC" } }))).toBe(true);
		expect(isDiskFullError("error: database or disk is full")).toBe(true);
		expect(
			isDiskFullError({
				code: "ENOSPC",
				message: "System limit for number of file watchers reached",
			}),
		).toBe(false);
		expect(isDiskFullError({ code: "EACCES" })).toBe(false);
		expect(new DiskSpaceError("/disk", null, undefined, true).describe("zh-CN")).toContain(
			"可能已部分写入",
		);
	});

	test("settings defaults are backward compatible and malformed waits are bounded", () => {
		settings.diskSafety = undefined;
		expect(diskSafetySettings()).toEqual(config);
		settings.diskSafety = { ...config, probeTimeoutMs: 99999999, checkIntervalMs: -1 };
		expect(diskSafetySettings().probeTimeoutMs).toBe(2000);
		expect(diskSafetySettings().checkIntervalMs).toBe(config.checkIntervalMs);
		expect(diskSafetySettingsSchema.safeParse({ probeTimeoutMs: 5000 }).success).toBe(false);
		expect(diskSafetySettingsSchema.safeParse({ mode: "warn" }).success).toBe(true);
	});
});
