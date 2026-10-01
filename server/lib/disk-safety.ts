import { realpath, stat, statfs } from "node:fs/promises";
import { dirname, resolve, win32 } from "node:path";
import { DEFAULT_DISK_SAFETY, type DiskSafetySettings } from "./disk-safety-config";
import { AppError } from "./errors";
import { settings } from "./settings";

const MB = 1024 * 1024;
const MAX_PATHS = 512;
const MAX_VOLUMES = 128;
const MAX_PENDING = 16;
const MAX_ANCESTORS = 64;

export interface DiskVolume {
	key: string;
	mountPath: string;
}
export interface DiskSpace extends DiskVolume {
	freeBytes: number;
	totalBytes: number;
	checkedAt: number;
}
export type DiskLevel = "ok" | "warning" | "blocked" | "critical" | "unknown";
export interface DiskAssessment {
	path: string;
	level: DiskLevel;
	space: DiskSpace | null;
}
export interface DiskProbe {
	resolveVolume(path: string): Promise<DiskVolume>;
	statVolume(volume: DiskVolume): Promise<{ freeBytes: number; totalBytes: number }>;
	now(): number;
}

/** No listing or recursive scan: resolve an existing ancestor, then walk mount boundaries.
 * stat.dev identifies Unix filesystems and Windows volume serials, including mounted folders.
 * realpath follows symlinks/junctions before attribution. Missing create targets inherit their
 * nearest existing parent. On Windows an unavailable volume identity is UNKNOWN, not drive C:.
 */
export async function resolveDiskVolume(
	input: string,
	platform: NodeJS.Platform = process.platform,
	fs = { realpath, stat },
): Promise<DiskVolume> {
	const pathApi = platform === "win32" ? win32 : { resolve, dirname };
	let path = pathApi.resolve(input);
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		try {
			path = await fs.realpath(path);
			const info = await fs.stat(path);
			if (!info.isDirectory()) path = pathApi.dirname(path);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = pathApi.dirname(path);
			if (parent === path || depth === MAX_ANCESTORS - 1) throw error;
			path = parent;
		}
	}
	const device = (await fs.stat(path)).dev;
	if (platform === "win32" && !device) throw new Error("Windows volume identity unavailable");
	let mountPath = path;
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		const parent = pathApi.dirname(mountPath);
		if (parent === mountPath || (await fs.stat(parent)).dev !== device)
			return { key: `${platform}:${device}`, mountPath };
		mountPath = parent;
	}
	throw new Error("Disk mount ancestor depth exceeded");
}

const nativeProbe: DiskProbe = {
	resolveVolume: resolveDiskVolume,
	async statVolume(volume) {
		const info = await statfs(volume.mountPath, { bigint: true });
		// bavail, not bfree: root-reserved blocks and quotas are not writable headroom.
		return {
			freeBytes: Number(info.bavail * info.bsize),
			totalBytes: Number(info.blocks * info.bsize),
		};
	},
	now: Date.now,
};

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
	map.delete(key);
	map.set(key, value);
	if (map.size > limit) {
		const first = map.keys().next();
		if (!first.done) map.delete(first.value);
	}
}

export function diskLevel(space: DiskSpace | null, config: DiskSafetySettings): DiskLevel {
	if (!space) return "unknown";
	if (space.freeBytes <= config.criticalFreeMb * MB) return "critical";
	if (space.freeBytes <= config.blockFreeMb * MB) return "blocked";
	if (
		space.freeBytes <= config.warningFreeMb * MB ||
		(space.totalBytes > 0 &&
			(space.freeBytes / space.totalBytes) * 100 <= config.warningFreePercent)
	)
		return "warning";
	return "ok";
}

/** Event-driven, process-wide single-flight cache. Native calls are async (never statfsSync).
 * A stuck network filesystem keeps its in-flight slot after the caller times out; calls cannot
 * pile up unboundedly. Failure results are cached as unknown for the same throttle interval.
 */
export class DiskSpaceMonitor {
	private paths = new Map<string, { at: number; volume: DiskVolume | null }>();
	private volumes = new Map<string, { at: number; space: DiskSpace | null; spent: number }>();
	private pendingPaths = new Map<string, Promise<DiskVolume | null>>();
	private pendingVolumes = new Map<string, Promise<DiskSpace | null>>();

	constructor(private readonly probe: DiskProbe = nativeProbe) {}

	async assess(path: string, config: DiskSafetySettings): Promise<DiskAssessment> {
		if (config.mode === "off") return { path, level: "ok", space: null };
		const space = await this.withDeadline(this.lookup(path, config), config.probeTimeoutMs);
		return { path, level: diskLevel(space, config), space };
	}

	private async withDeadline<T>(work: Promise<T | null>, timeoutMs: number): Promise<T | null> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				work,
				new Promise<null>((done) => {
					timer = setTimeout(() => done(null), timeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async lookup(path: string, config: DiskSafetySettings): Promise<DiskSpace | null> {
		let cached = this.paths.get(path);
		if (!cached || this.probe.now() - cached.at >= config.pathCacheTtlMs) {
			let pending = this.pendingPaths.get(path);
			if (!pending) {
				if (this.pendingPaths.size + this.pendingVolumes.size >= MAX_PENDING) return null;
				pending = this.probe
					.resolveVolume(path)
					.catch(() => null)
					.then((volume) => {
						boundedSet(this.paths, path, { at: this.probe.now(), volume }, MAX_PATHS);
						return volume;
					})
					.finally(() => this.pendingPaths.delete(path));
				this.pendingPaths.set(path, pending);
			}
			await pending;
			cached = this.paths.get(path);
		}
		if (!cached?.volume) return null;
		const volume = cached.volume;
		const cachedSpace = this.volumes.get(volume.key);
		if (cachedSpace && this.probe.now() - cachedSpace.at < config.checkIntervalMs)
			return cachedSpace.space
				? {
						...cachedSpace.space,
						freeBytes: Math.max(0, cachedSpace.space.freeBytes - cachedSpace.spent),
					}
				: null;
		let pending = this.pendingVolumes.get(volume.key);
		if (!pending) {
			if (this.pendingPaths.size + this.pendingVolumes.size >= MAX_PENDING) return null;
			pending = this.probe
				.statVolume(volume)
				.then((size) => {
					if (!Number.isFinite(size.freeBytes) || size.freeBytes < 0 || size.totalBytes <= 0)
						throw new Error("Invalid statfs result");
					return { ...volume, ...size, checkedAt: this.probe.now() };
				})
				.catch(() => null)
				.then((space) => {
					boundedSet(
						this.volumes,
						volume.key,
						{ at: this.probe.now(), space, spent: 0 },
						MAX_VOLUMES,
					);
					return space;
				})
				.finally(() => this.pendingVolumes.delete(volume.key));
			this.pendingVolumes.set(volume.key, pending);
		}
		return pending;
	}

	/** An actual ENOSPC outranks an earlier healthy probe. Recheck after the normal TTL. */
	noteDiskFull(path: string): void {
		const volume = this.paths.get(path)?.volume;
		const cached = volume ? this.volumes.get(volume.key) : undefined;
		if (cached?.space) {
			cached.space = { ...cached.space, freeBytes: 0, checkedAt: this.probe.now() };
			cached.at = this.probe.now();
			cached.spent = 0;
		}
	}

	/** Charge attempted bytes until the next OS refresh (even failed writes may consume space).
	 * This is conservative headroom, not a claim to reserve OS blocks against other processes.
	 * All callers resume on one JS thread; the check+charge section has no await.
	 */
	async guardWrite(path: string, bytes: number, config: DiskSafetySettings): Promise<void> {
		if (config.mode !== "enforce") return;
		const assessment = await this.assess(path, config);
		const cached = assessment.space ? this.volumes.get(assessment.space.key) : undefined;
		if (!cached?.space) return; // unsupported/offline probe is unknown, never fake zero
		const freeBytes = Math.max(0, cached.space.freeBytes - cached.spent);
		const space = { ...cached.space, freeBytes };
		const required = Math.max(0, bytes) + config.reserveMb * MB;
		if (["blocked", "critical"].includes(diskLevel(space, config)) || freeBytes < required)
			throw new DiskSpaceError(path, space, required);
		cached.spent += Math.max(0, bytes);
	}
}

export class DiskSpaceError extends AppError {
	constructor(
		readonly path: string,
		readonly space: DiskSpace | null = null,
		readonly requiredBytes?: number,
		readonly occurred = false,
		readonly fatal = false,
	) {
		super("Disk space is insufficient; write refused.", 507, "DISK_SPACE_LOW");
		this.name = "DiskSpaceError";
		this.message = this.describe();
	}

	describe(locale = "en"): string {
		const location = this.space?.mountPath ?? this.path;
		const free = this.space ? ` (${Math.floor(this.space.freeBytes / MB)} MiB free)` : "";
		const required =
			this.requiredBytes === undefined
				? ""
				: `; ${Math.ceil(this.requiredBytes / MB)} MiB required including reserve`;
		if (locale.startsWith("zh"))
			return `磁盘空间不足：${location}${free}${required}。${this.occurred ? "操作遇到 ENOSPC/配额不足/SQLITE_FULL，可能已部分写入；请先核对文件。" : this.fatal ? "数据目录已达到危险阈值；为保护数据库 WAL，普通工具执行已停止（包括只读工具的历史写入）。" : "为保护文件、快照及数据库 WAL，本次写入已拒绝。"} 请释放空间后重试；管理员可在 diskSafety.mode 中临时选择 warn/off（有风险）。`;
		return `Disk space insufficient: ${location}${free}${required}. ${this.occurred ? "ENOSPC/quota/SQLITE_FULL occurred; partial writes are possible, verify affected files first." : this.fatal ? "The data directory is critically low; this tool turn is stopped to protect database WAL (read tools also persist history)." : "Write refused to protect files, snapshots and database WAL."} Free space and retry. Administrators can temporarily override diskSafety.mode to warn/off (unsafe).`;
	}
}

/** Match specific storage failures, not generic "ENOSPC" in a successful tool's source text.
 * inotify ENOSPC is an exhausted watch quota, not a full filesystem.
 */
export function isDiskFullError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 4 && current != null; depth++) {
		const record =
			typeof current === "object"
				? (current as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown })
				: {};
		const text = typeof current === "string" ? current : String(record.message ?? "");
		if (
			!/inotify|file watchers reached|watch(?:er)? limit|watch quota|max_user_watches/i.test(
				text,
			) &&
			(["ENOSPC", "EDQUOT", "SQLITE_FULL"].includes(String(record.code)) ||
				(record.errno === 13 && /database|sqlite/i.test(text)) ||
				/\bENOSPC\b|\bEDQUOT\b|\bSQLITE_FULL\b|no space left on device|disk quota exceeded|database or disk is full/i.test(
					text,
				))
		)
			return true;
		current = record.cause;
	}
	return false;
}

export const diskSpaceMonitor = new DiskSpaceMonitor();
export function diskSafetySettings(): DiskSafetySettings {
	const raw = settings.diskSafety ?? DEFAULT_DISK_SAFETY;
	// Malformed manually edited settings must not produce unlimited waits or disable reserves.
	const result = { ...DEFAULT_DISK_SAFETY, ...raw };
	for (const key of Object.keys(DEFAULT_DISK_SAFETY) as (keyof DiskSafetySettings)[]) {
		if (key === "mode") continue;
		if (!Number.isFinite(result[key]) || result[key] < 0) result[key] = DEFAULT_DISK_SAFETY[key];
	}
	if (!["off", "warn", "enforce"].includes(result.mode)) result.mode = "enforce";
	result.checkIntervalMs = Math.min(300_000, Math.max(1000, result.checkIntervalMs));
	result.pathCacheTtlMs = Math.min(600_000, Math.max(1000, result.pathCacheTtlMs));
	result.probeTimeoutMs = Math.min(2000, Math.max(50, result.probeTimeoutMs));
	return result;
}

export async function guardDiskWrite(path: string, bytes = 0): Promise<void> {
	await diskSpaceMonitor.guardWrite(path, bytes, diskSafetySettings());
}

/** Shed optional disk amplification at the warning tier, before creating any directories. */
export async function canWriteOptionalDiskData(path: string): Promise<boolean> {
	const config = diskSafetySettings();
	if (config.mode !== "enforce") return true;
	const assessment = await diskSpaceMonitor.assess(path, config);
	if (assessment.level === "blocked" || assessment.level === "critical") return false;
	// Percentage-only warnings on huge volumes need not sacrifice rollback protection.
	return !assessment.space || assessment.space.freeBytes > config.warningFreeMb * MB;
}
