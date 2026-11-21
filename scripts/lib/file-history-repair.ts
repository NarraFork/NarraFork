import { createHash, randomUUID } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	linkSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	openSync,
	readlinkSync,
	readSync,
	realpathSync,
	rmdirSync,
	statfsSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	type InstanceProcessDomain,
	type InstanceProcessIdentity,
	instanceProcessEndReason,
	isInstanceProcessIdentity,
	sameInstanceProcessDomain,
} from "../../server/lib/instance-process-identity";

export type RepairMode = "check" | "apply" | "verify";
export type RepairCommitState = "not_committed" | "committed" | "unknown";
export interface RepairArguments {
	mode: RepairMode;
	dataDir: string;
	database: string;
	confirmAutoRestartDisabled: boolean;
	minFreeBytes: bigint;
	timeoutMs: number;
}
export class FileHistoryRepairSafetyError extends Error {
	constructor(
		readonly code: string,
		readonly commitState: RepairCommitState = "not_committed",
	) {
		super(code);
		this.name = "FileHistoryRepairSafetyError";
	}
}
function fail(code: string): never {
	throw new FileHistoryRepairSafetyError(code);
}
const MAX_REPORT_BYTES = 8 * 1024;
const MAX_PROC_PIDS = 32_768;
const MAX_PROC_FDS = 262_144;
const PROC_SCAN_MS = 15_000;
const NOFOLLOW = constants.O_NOFOLLOW;

export const FILE_HISTORY_REPAIR_HELP = `离线文件历史维护（Linux；不停止或启动服务）
--data-dir /absolute/existing/directory --database /absolute/existing/narrafork.db
--confirm-auto-restart-disabled  管理员确认已停用全部自动拉起机制（所有模式必需）
[--check | --verify | --apply --confirm-discard-file-history]
[--min-free-bytes 1073741824] [--timeout-ms 1800000]
默认 --check；只写私有锁和不超过 8KiB 的摘要报告。不创建数据库，不复制数据库或 WAL。
--apply 提交后旧文件预览、树快照及 Git 基线不可恢复；blob 实物保留并继续占盘。`;

export function parseFileHistoryRepairArguments(args: readonly string[]): RepairArguments {
	let mode: RepairMode = "check";
	let selectedMode = false;
	let dataDir = "";
	let database = "";
	let discarded = false;
	let confirmAutoRestartDisabled = false;
	let minFreeBytes = 1_073_741_824n;
	let timeoutMs = 1_800_000;
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const name = args[index];
		if (!name || seen.has(name)) fail("invalid_or_duplicate_argument");
		seen.add(name);
		if (name === "--check" || name === "--apply" || name === "--verify") {
			if (selectedMode) fail("conflicting_modes");
			selectedMode = true;
			mode = name.slice(2) as RepairMode;
		} else if (name === "--confirm-discard-file-history") discarded = true;
		else if (name === "--confirm-auto-restart-disabled") confirmAutoRestartDisabled = true;
		else if (
			name === "--data-dir" ||
			name === "--database" ||
			name === "--min-free-bytes" ||
			name === "--timeout-ms"
		) {
			const value = args[++index];
			if (!value || value.startsWith("--")) fail("missing_argument_value");
			if (name === "--data-dir") dataDir = value;
			else if (name === "--database") database = value;
			else {
				if (!/^\d{1,16}$/.test(value)) fail("invalid_resource_limit");
				if (name === "--min-free-bytes") {
					minFreeBytes = BigInt(value);
					if (minFreeBytes < 16_777_216n) fail("free_space_limit_too_small");
				} else {
					timeoutMs = Number(value);
					if (timeoutMs < 1_000 || timeoutMs > 86_400_000) fail("invalid_timeout");
				}
			}
		} else fail("unknown_argument");
	}
	if (!isAbsolute(dataDir) || !isAbsolute(database)) fail("explicit_absolute_paths_required");
	if (dataDir !== resolve(dataDir) || database !== resolve(database))
		fail("canonical_paths_required");
	if (!confirmAutoRestartDisabled) fail("auto_restart_confirmation_required");
	if (mode === "apply" && !discarded) fail("discard_confirmation_required");
	if (mode !== "apply" && discarded) fail("discard_confirmation_requires_apply");
	return { mode, dataDir, database, confirmAutoRestartDisabled, minFreeBytes, timeoutMs };
}

function objectIdentity(info: BigIntStats): string {
	return `${info.dev}:${info.ino}:${info.birthtimeNs > 0n ? info.birthtimeNs : 0n}`;
}
function sameObject(left: BigIntStats, right: BigIntStats): boolean {
	return objectIdentity(left) === objectIdentity(right);
}
function privateEntry(path: string, directory: boolean): BigIntStats {
	const info = lstatSync(path, { bigint: true });
	if (
		info.isSymbolicLink() ||
		(directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n) ||
		info.uid !== BigInt(process.geteuid?.() ?? -1) ||
		(info.mode & 0o077n) !== 0n ||
		(directory && (info.mode & 0o700n) !== 0o700n) ||
		(!directory && (info.mode & 0o600n) !== 0o600n)
	)
		fail("unsafe_private_entry");
	return info;
}
function validateAncestors(path: string): void {
	if (realpathSync(path) !== path) fail("noncanonical_or_symlink_path");
	const entries: { path: string; info: BigIntStats }[] = [];
	for (let cursor = path; ; cursor = dirname(cursor)) {
		if (entries.length >= 128) fail("ancestor_limit");
		entries.push({ path: cursor, info: lstatSync(cursor, { bigint: true }) });
		if (cursor === dirname(cursor)) break;
	}
	let privateAncestor = false;
	for (const { info } of entries.reverse()) {
		if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe_ancestor_type");
		if (info.uid !== 0n && info.uid !== BigInt(process.geteuid?.() ?? -1))
			fail("unsafe_ancestor_owner");
		if (!privateAncestor && (info.mode & 0o022n) !== 0n && (info.mode & 0o1000n) === 0n)
			fail("unsafe_ancestor_permissions");
		if (info.uid === BigInt(process.geteuid?.() ?? -1) && (info.mode & 0o011n) === 0n)
			privateAncestor = true;
	}
}
function readBounded(path: string, limit: number, privateFile = false): Buffer {
	const before = privateFile ? privateEntry(path, false) : undefined;
	const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
	try {
		const info = fstatSync(fd, { bigint: true });
		if (before && (!sameObject(before, info) || info.size > BigInt(limit)))
			fail("metadata_identity_changed");
		const bytes = Buffer.alloc(limit + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (count === 0) break;
			offset += count;
		}
		if (offset > limit) fail("metadata_size_limit");
		if (before) {
			const after = privateEntry(path, false);
			const final = fstatSync(fd, { bigint: true });
			if (
				!sameObject(before, after) ||
				!sameObject(before, final) ||
				before.size !== final.size ||
				before.mtimeNs !== final.mtimeNs ||
				before.ctimeNs !== final.ctimeNs ||
				after.size !== final.size ||
				after.mtimeNs !== final.mtimeNs ||
				after.ctimeNs !== final.ctimeNs
			)
				fail("metadata_identity_changed");
		}
		return bytes.subarray(0, offset);
	} finally {
		closeSync(fd);
	}
}
function boundedDirectory(path: string, limit: number): string[] {
	const directory = opendirSync(path);
	const names: string[] = [];
	try {
		for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
			if (names.length >= limit) fail("directory_observation_limit");
			names.push(entry.name);
		}
		return names;
	} finally {
		directory.closeSync();
	}
}
function requireLocalFilesystem(path: string): void {
	const type = statfsSync(path, { bigint: true }).type;
	const supported = [
		0xef53n,
		0x58465342n,
		0x9123683en,
		0x794c7630n,
		0x01021994n,
		0x2fc12fc1n,
		0xf2f52010n,
	];
	if (!supported.includes(type)) fail("unsupported_filesystem");
}
function absent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function procBirth(pid: number): string {
	const raw = readBounded(`/proc/${pid}/stat`, 64 * 1024).toString("utf8");
	if (!raw.startsWith(`${pid} (`)) fail("process_identity_unknown");
	const value = raw
		.slice(raw.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/)[19];
	if (!value || !/^\d{1,24}$/.test(value) || value === "0") fail("process_identity_unknown");
	return value;
}
export function readRepairProcessIdentity(pid = process.pid): InstanceProcessIdentity {
	const domain: InstanceProcessDomain = {
		platform: "linux",
		machine: readBounded("/etc/machine-id", 128).toString("utf8").trim().toLowerCase(),
		boot: readBounded("/proc/sys/kernel/random/boot_id", 128).toString("utf8").trim().toLowerCase(),
		pidNamespace: readlinkSync("/proc/self/ns/pid"),
		timeNamespace: readlinkSync("/proc/self/ns/time"),
	};
	const identity = { version: 1 as const, domain, pid, birth: procBirth(pid) };
	if (!isInstanceProcessIdentity(identity)) fail("process_identity_unknown");
	// /proc must describe this process, not a procfs mounted from another PID namespace.
	const self = readBounded("/proc/self/stat", 64 * 1024).toString("utf8");
	if (!self.startsWith(`${process.pid} (`)) fail("foreign_procfs");
	return identity;
}
function assertProcVisibility(): void {
	const mounts = readBounded("/proc/self/mountinfo", 512 * 1024).toString("utf8");
	const proc = mounts.split("\n").find((line) => line.split(" ")[4] === "/proc");
	if (!proc?.includes(" - proc ") || /(?:hidepid|subset)=/.test(proc))
		fail("proc_visibility_unknown");
	// Without root, ptrace policy and cross-user descriptors cannot establish global absence.
	if (process.geteuid?.() !== 0) fail("root_proc_visibility_required");
}

interface OwnedFile {
	path: string;
	info: BigIntStats;
	bytes: Buffer;
}
function verifyOwned(file: OwnedFile): void {
	const info = privateEntry(file.path, false);
	if (!sameObject(file.info, info) || !readBounded(file.path, 64 * 1024, true).equals(file.bytes))
		fail("lock_identity_changed");
}
function removeOwned(file: OwnedFile): void {
	verifyOwned(file);
	unlinkSync(file.path);
}
function writeAll(fd: number, bytes: Buffer): void {
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
		if (written <= 0) fail("short_metadata_write");
		offset += written;
	}
}
function syncDirectory(path: string): void {
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function publishLock(path: string, payload: Record<string, unknown>): OwnedFile {
	const temporary = join(dirname(path), `.file-history-lock-${randomUUID()}.tmp`);
	const bytes = Buffer.from(`${JSON.stringify(payload)}\n`);
	const fd = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
		0o600,
	);
	let published = false;
	try {
		fchmodSync(fd, 0o600);
		writeAll(fd, bytes);
		fsyncSync(fd);
		// Hard-link publication is atomic and never overwrites another instance's lock.
		linkSync(temporary, path);
		published = true;
	} finally {
		closeSync(fd);
		unlinkSync(temporary);
	}
	if (!published) fail("instance_lock_contended");
	syncDirectory(dirname(path));
	const result = { path, bytes, info: privateEntry(path, false) };
	verifyOwned(result);
	return result;
}

export interface RepairSafetyContext {
	readonly namespaceKey: string;
	readonly reportPath: string;
	readonly processIdentity: InstanceProcessIdentity;
	guard(phase: string, exhaustive?: boolean): void;
	writeReport(summary: Record<string, unknown>): void;
	close(finalReport?: Record<string, unknown>): void;
}
export interface RepairSafetyOptions {
	/** Tests inject only a free-space result, never bypass the production CLI's offline checks. */
	availableBytes?: () => bigint;
	parentIdentity?: InstanceProcessIdentity;
}

/** No application DB, settings, startup or runtime module is imported by this boundary. */
export function prepareFileHistoryRepair(
	args: RepairArguments,
	options: RepairSafetyOptions = {},
): RepairSafetyContext {
	if (process.platform !== "linux") fail("linux_required");
	if (!args.confirmAutoRestartDisabled) fail("auto_restart_confirmation_required");
	if (process.env.NARRAFORK_ALLOW_MULTIPLE || process.env.NARRAFORK_FORCE_UNLOCK)
		fail("instance_override_forbidden");
	if (
		dirname(args.database) !== args.dataDir ||
		args.database !== join(args.dataDir, "narrafork.db")
	)
		fail("database_data_directory_pair_mismatch");
	validateAncestors(args.dataDir);
	const sourcePath = join(args.dataDir, "file-change-source.json");
	const blobRoot = join(args.dataDir, "file-change-blobs");
	const dataInfo = privateEntry(args.dataDir, true);
	const blobInfo = privateEntry(blobRoot, true);
	if (realpathSync(blobRoot) !== blobRoot) fail("noncanonical_blob_root");
	const dbInfo = privateEntry(args.database, false);
	if (dbInfo.size < 100n) fail("invalid_existing_database");
	for (const path of [args.dataDir, blobRoot, args.database, sourcePath])
		requireLocalFilesystem(path);
	const sourceInfo = privateEntry(sourcePath, false);
	const sourceBytes = readBounded(sourcePath, 512, true);
	let source: { version?: unknown; id?: unknown };
	try {
		source = JSON.parse(sourceBytes.toString("utf8"));
	} catch {
		return fail("invalid_source_identity");
	}
	if (source.version !== 1 || typeof source.id !== "string" || !/^[a-f0-9-]{36}$/.test(source.id))
		fail("invalid_source_identity");
	// Identical to file-change-runtime.identityHasher and localObjectIdentity (bigint, ns).
	const digest = createHash("sha256");
	for (const part of [source.id, blobRoot, objectIdentity(blobInfo)])
		digest.update(`${Buffer.byteLength(part)}:`).update(part);
	const namespaceKey = digest.digest("hex");
	assertProcVisibility();
	const self = readRepairProcessIdentity();
	const deadline = Date.now() + args.timeoutMs;
	const watched = [
		args.database,
		`${args.database}-wal`,
		`${args.database}-shm`,
		`${args.database}-journal`,
		sourcePath,
	];
	const held: number[] = [];
	let instance: OwnedFile | undefined;
	let mutex: OwnedFile | undefined;
	let mutexInfo: BigIntStats | undefined;
	let reportFd: number | undefined;
	let reportInfo: BigIntStats | undefined;
	let reportDirectoryInfo: BigIntStats | undefined;
	let closed = false;
	let lastIdentityCheck = 0;
	const mutexPath = join(args.dataDir, ".file-history-repair.lock");
	const reportDirectory = join(args.dataDir, "file-history-maintenance");
	const reportPath = join(
		reportDirectory,
		`repair-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
	);
	const instancePath = join(args.dataDir, "narrafork.lock");
	function checkTime(): void {
		if (Date.now() > deadline) fail("maintenance_deadline_exceeded");
	}
	function checkIdentity(): void {
		checkTime();
		if (!sameInstanceProcessDomain(self.domain, readRepairProcessIdentity().domain))
			fail("process_domain_changed");
		if (options.parentIdentity) {
			const parent = readRepairProcessIdentity(options.parentIdentity.pid);
			if (
				process.ppid !== parent.pid ||
				parent.birth !== options.parentIdentity.birth ||
				!sameInstanceProcessDomain(parent.domain, options.parentIdentity.domain)
			)
				fail("supervisor_identity_changed");
		}
		validateAncestors(args.dataDir);
		if (
			!sameObject(dataInfo, privateEntry(args.dataDir, true)) ||
			!sameObject(blobInfo, privateEntry(blobRoot, true)) ||
			!sameObject(dbInfo, privateEntry(args.database, false)) ||
			!sameObject(sourceInfo, privateEntry(sourcePath, false)) ||
			!readBounded(sourcePath, 512, true).equals(sourceBytes)
		)
			fail("storage_identity_changed");
		for (const path of watched.slice(1, 4)) {
			try {
				privateEntry(path, false);
			} catch (error) {
				if (!absent(error)) throw error;
			}
		}
		if (instance) verifyOwned(instance);
		if (mutex) {
			if (!mutexInfo || !sameObject(mutexInfo, privateEntry(mutexPath, true)))
				fail("tool_lock_identity_changed");
			verifyOwned(mutex);
		}
		const available =
			options.availableBytes?.() ??
			(() => {
				const fs = statfsSync(args.dataDir, { bigint: true });
				return fs.bavail * fs.bsize;
			})();
		if (available < args.minFreeBytes) fail("insufficient_transaction_space");
		lastIdentityCheck = Date.now();
	}
	function scanHolders(): Set<number> {
		checkIdentity();
		assertProcVisibility();
		const scanDeadline = Math.min(deadline, Date.now() + PROC_SCAN_MS);
		const protectedInodes = new Set([dbInfo.ino, sourceInfo.ino, blobInfo.ino]);
		for (const path of watched.slice(1, 4)) {
			try {
				protectedInodes.add(privateEntry(path, false).ino);
			} catch (error) {
				if (!absent(error)) throw error;
			}
		}
		const pids = boundedDirectory("/proc", MAX_PROC_PIDS + 1024).filter((name) =>
			/^\d+$/.test(name),
		);
		if (pids.length > MAX_PROC_PIDS) fail("process_observation_limit");
		let descriptorCount = 0;
		const observed = new Set<number>([process.pid]);
		for (const entry of pids) {
			if (Date.now() > scanDeadline) fail("process_observation_timeout");
			const pid = Number(entry);
			if (pid === process.pid) continue;
			try {
				const birth = procBirth(pid);
				observed.add(pid);
				const fds = boundedDirectory(`/proc/${pid}/fd`, 16_384);
				descriptorCount += fds.length;
				if (fds.length > 16_384 || descriptorCount > MAX_PROC_FDS)
					fail("descriptor_observation_limit");
				for (const fd of fds) {
					let target: string;
					try {
						target = readlinkSync(`/proc/${pid}/fd/${fd}`).replace(/ \(deleted\)$/, "");
					} catch (error) {
						if (absent(error)) continue; // Descriptor closed, not a hidden process.
						throw error;
					}
					if (watched.includes(target) || target === blobRoot || target.startsWith(`${blobRoot}/`))
						fail("other_storage_holder");
					if (target.startsWith("/")) {
						try {
							// Read procfs metadata only: never open/stat an unrelated fd's referent.
							const metadata = readBounded(`/proc/${pid}/fdinfo/${fd}`, 4096).toString("utf8");
							const inode = /^ino:\s+(\d+)$/m.exec(metadata)?.[1];
							if (!inode) fail("proc_descriptor_unknown");
							// Conservatively refuse inode collisions across mounts as possible aliases.
							if (protectedInodes.has(BigInt(inode))) fail("possible_storage_alias_holder");
						} catch (error) {
							if (!absent(error)) throw error;
						}
					}
				}
				const maps = readBounded(`/proc/${pid}/maps`, 2 * 1024 * 1024).toString("utf8");
				for (const line of maps.split("\n")) {
					const mapping = /^\S+\s+\S+\s+\S+\s+(\S+)\s+(\d+)(?:\s+(.*))?$/.exec(line);
					if (!mapping) {
						if (line) fail("proc_maps_unknown");
						continue;
					}
					const path = mapping[3]?.replace(/ \(deleted\)$/, "") ?? "";
					if (
						watched.includes(path) ||
						path === blobRoot ||
						path.startsWith(`${blobRoot}/`) ||
						protectedInodes.has(BigInt(mapping[2]))
					)
						fail("other_storage_mapping");
				}
				if (birth !== procBirth(pid)) fail("process_changed_during_observation");
			} catch (error) {
				if (absent(error) && !boundedDirectory("/proc", MAX_PROC_PIDS + 1024).includes(entry))
					continue;
				if (error instanceof FileHistoryRepairSafetyError) throw error;
				fail("process_observation_incomplete");
			}
		}
		checkIdentity();
		return observed;
	}
	function proveDead(identity: InstanceProcessIdentity): void {
		// A positive matching process rejects immediately. Never infer self-absence from
		// skipping this worker's descriptors during the global holder scan.
		try {
			const current = readRepairProcessIdentity(identity.pid);
			if (
				sameInstanceProcessDomain(identity.domain, current.domain) &&
				identity.birth === current.birth
			)
				fail("live_or_unknown_lock_holder");
		} catch (error) {
			if (!absent(error)) throw error;
		}
		const present = scanHolders();
		const observation = present.has(identity.pid)
			? { kind: "present" as const, identity: readRepairProcessIdentity(identity.pid) }
			: { kind: "absent" as const, domain: self.domain };
		if (!instanceProcessEndReason(identity, observation)) fail("live_or_unknown_lock_holder");
	}
	function reclaimKnown(path: string): void {
		let bytes: Buffer;
		let info: BigIntStats;
		try {
			info = privateEntry(path, false);
			bytes = readBounded(path, 64 * 1024, true);
		} catch (error) {
			if (absent(error)) return;
			throw error;
		}
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(bytes.toString("utf8"));
		} catch {
			fail("unknown_existing_lock");
		}
		if (
			value.version !== 2 ||
			value.dbPath !== args.database ||
			value.maintenanceQualified !== true ||
			!isInstanceProcessIdentity(value.maintenanceIdentity) ||
			value.pid !== value.maintenanceIdentity.pid ||
			typeof value.token !== "string" ||
			!value.token ||
			value.uid !== process.geteuid?.()
		)
			fail("unknown_existing_lock");
		proveDead(value.maintenanceIdentity);
		removeOwned({ path, info, bytes });
	}
	const payload = () => ({
		version: 2,
		pid: process.pid,
		token: randomUUID(),
		dbPath: args.database,
		startedAt: new Date().toISOString(),
		argv: ["file-history-offline-maintenance"],
		bootId: self.domain.boot,
		procStartTicks: Number(self.birth),
		execPath: process.execPath,
		hostname: "offline-maintenance",
		uid: process.geteuid?.(),
		maintenanceIdentity: self,
		maintenanceQualified: true,
	});
	function writeReport(summary: Record<string, unknown>): void {
		if (reportFd === undefined || !reportInfo || !reportDirectoryInfo) fail("report_not_open");
		if (
			!sameObject(reportInfo, privateEntry(reportPath, false)) ||
			!sameObject(reportDirectoryInfo, privateEntry(reportDirectory, true))
		)
			fail("report_identity_changed");
		const bytes = Buffer.from(`${JSON.stringify({ version: 1, mode: args.mode, ...summary })}\n`);
		if (bytes.length > MAX_REPORT_BYTES) fail("report_size_limit");
		ftruncateSync(reportFd, 0);
		writeAll(reportFd, bytes);
		fsyncSync(reportFd);
		const written = fstatSync(reportFd, { bigint: true });
		if (
			written.size !== BigInt(bytes.length) ||
			!sameObject(reportInfo, written) ||
			!sameObject(reportInfo, privateEntry(reportPath, false)) ||
			!sameObject(reportDirectoryInfo, privateEntry(reportDirectory, true))
		)
			fail("report_identity_changed");
	}
	function close(finalReport?: Record<string, unknown>): void {
		if (closed) return;
		closed = true;
		for (const fd of held) closeSync(fd);
		let cleanupError: unknown;
		try {
			if (instance) removeOwned(instance);
		} catch (error) {
			cleanupError = error;
		}
		try {
			if (mutex && mutexInfo) {
				if (!sameObject(mutexInfo, privateEntry(mutexPath, true)))
					fail("tool_lock_identity_changed");
				removeOwned(mutex);
				rmdirSync(mutexPath);
			}
		} catch (error) {
			cleanupError ??= error;
		}
		try {
			if (finalReport) {
				writeReport(
					cleanupError
						? {
								...finalReport,
								status: "failed",
								code: "maintenance_lock_release_failed",
								startupAllowed: false,
							}
						: finalReport,
				);
			}
		} finally {
			if (reportFd !== undefined) closeSync(reportFd);
		}
		if (cleanupError) throw cleanupError;
	}
	try {
		for (const path of [args.dataDir, blobRoot, args.database, sourcePath])
			held.push(openSync(path, constants.O_RDONLY | NOFOLLOW));
		scanHolders();
		try {
			mkdirSync(mutexPath, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			privateEntry(mutexPath, true);
			try {
				privateEntry(join(mutexPath, "owner.json"), false);
			} catch {
				fail("unknown_existing_tool_lock");
			}
			reclaimKnown(join(mutexPath, "owner.json"));
			// Unknown/empty directories are never an acquisition path.
			if (boundedDirectory(mutexPath, 2).length !== 0) fail("tool_lock_contended");
			rmdirSync(mutexPath);
			mkdirSync(mutexPath, { mode: 0o700 });
		}
		mutexInfo = privateEntry(mutexPath, true);
		mutex = publishLock(join(mutexPath, "owner.json"), payload());
		reclaimKnown(instancePath);
		instance = publishLock(instancePath, payload());
		scanHolders();
		try {
			mkdirSync(reportDirectory, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		reportDirectoryInfo = privateEntry(reportDirectory, true);
		reportFd = openSync(
			reportPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
			0o600,
		);
		fchmodSync(reportFd, 0o600);
		reportInfo = privateEntry(reportPath, false);
		writeReport({ phase: "preflight", commitState: "not_committed", status: "in_progress" });
		syncDirectory(reportDirectory);
		return {
			namespaceKey,
			reportPath,
			processIdentity: self,
			guard(phase, exhaustive = false) {
				checkTime();
				if (exhaustive || /^(?:before|after)_(?:transaction|commit)$/.test(phase)) {
					scanHolders();
					return;
				}
				// SQL/schema queries can be numerous; check the deadline on every query,
				// but never throttle batch boundaries, transaction edges or caller checks.
				if (
					/^(?:sql|schema_table|schema_contract)$/.test(phase) &&
					Date.now() - lastIdentityCheck < 250
				)
					return;
				checkIdentity();
			},
			writeReport,
			close,
		};
	} catch (error) {
		try {
			close();
		} catch {
			// A lost owner is retained for inspection; never delete another process's lock.
		}
		throw error;
	}
}
