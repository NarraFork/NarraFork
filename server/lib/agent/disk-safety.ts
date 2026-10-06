import { resolve } from "node:path";
import {
	confirmedDiskFullEvidence,
	type DiskAssessment,
	DiskSpaceError,
	type DiskSpaceMonitor,
	diskSafetySettings,
	diskSpaceMonitor,
} from "../disk-safety";
import type { DiskSafetySettings } from "../disk-safety-config";
import { getNarraforkHome } from "../narrafork-home";
import type { ToolContext } from "./types";

const READ_ONLY_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"StructView",
	"WebSearch",
	"WebFetch",
	"ContextAsk",
	"TeamStatus",
	"Await",
	"Recall",
]);
const warnedAt = new Map<string, number>();
const MAX_NOTICES = 512;

/** Health notices are per narrator + volume, not per file. No persistent DB writes or timers. */
function shouldNotify(key: string, intervalMs: number): boolean {
	const now = Date.now();
	const last = warnedAt.get(key);
	if (last !== undefined && now - last < intervalMs) return false;
	warnedAt.delete(key);
	warnedAt.set(key, now);
	if (warnedAt.size > MAX_NOTICES) {
		const first = warnedAt.keys().next();
		if (!first.done) warnedAt.delete(first.value);
	}
	return true;
}

export interface ToolDiskCheck {
	assessments: DiskAssessment[];
	notice: string;
}

/** Run after routing/permission has frozen canonical endpoints but BEFORE snapshot observers.
 * A remote path must never be probed on the host. Home is still relevant for remote tools,
 * since their history and results are stored here. No shell parsing: Bash is opaque and can
 * be unbounded; cleanup remains possible through the user's terminal/admin override.
 */
export async function checkToolDiskSafety(
	toolName: string,
	input: Record<string, unknown>,
	ctx: Pick<
		ToolContext,
		"narratorId" | "cwd" | "locale" | "executionTarget" | "executionPlan" | "defaultDeviceId"
	>,
	monitor: DiskSpaceMonitor = diskSpaceMonitor,
	config: DiskSafetySettings = diskSafetySettings(),
	home = getNarraforkHome(),
): Promise<ToolDiskCheck> {
	if (config.mode === "off") return { assessments: [], notice: "" };
	const paths = new Map<string, boolean>([[home, true]]);
	const endpoints =
		ctx.executionPlan?.endpoints ??
		(ctx.executionTarget ? [{ operation: "execute", target: ctx.executionTarget }] : []);
	let remote = false;
	for (const endpoint of endpoints) {
		if (endpoint.target.backendKind !== "local") {
			remote = true;
			continue;
		}
		if (endpoint.target.pathFlavor === "spec") continue;
		paths.set(endpoint.target.cwd, false);
		const path = endpoint.target.canonicalPath ?? endpoint.target.lexicalPath;
		if (path && !path.startsWith("spec://")) paths.set(path, false);
	}
	if (endpoints.length === 0 && (ctx.defaultDeviceId ?? "local") === "local") {
		paths.set(ctx.cwd, false);
		for (const key of ["file_path", "path", "to_file", "workdir"]) {
			const value = input[key];
			if (typeof value === "string" && !value.startsWith("spec://"))
				paths.set(resolve(ctx.cwd, value), false);
		}
	} else if ((ctx.defaultDeviceId ?? "local") !== "local") remote = true;
	// Keep HOME ownership even if it equals cwd/the target.
	paths.set(home, true);
	const entries = [...paths].slice(0, 16);
	const assessments = await Promise.all(
		entries.map(async ([path]) => monitor.assess(path, config)),
	);
	const cancelling =
		["Bash", "bash", "Agent", "Task"].includes(toolName) &&
		typeof input.stop === "string" &&
		!input.command;
	const readOnly = READ_ONLY_TOOLS.has(toolName) || cancelling;
	const writeVolumes = new Set(
		endpoints
			.filter((e) => e.operation === "write" || e.operation === "execute")
			.map((e) => e.target.canonicalPath ?? e.target.cwd),
	);
	const notices: string[] = [];
	const reported = new Set<string>();
	for (const assessment of assessments) {
		const homePath = paths.get(assessment.path) === true;
		// Even Read persists tool/history rows. At critical HOME pressure stop the turn,
		// but retain cancellation so an existing producer can be stopped safely.
		if (config.mode === "enforce" && homePath && assessment.level === "critical" && !cancelling)
			throw new DiskSpaceError(assessment.path, assessment.space, undefined, false, true);
		const mutating =
			!readOnly &&
			(homePath ||
				writeVolumes.size === 0 ||
				writeVolumes.has(assessment.path) ||
				assessment.path === ctx.cwd);
		if (
			config.mode === "enforce" &&
			mutating &&
			["blocked", "critical"].includes(assessment.level)
		) {
			throw new DiskSpaceError(
				assessment.path,
				assessment.space,
				undefined,
				false,
				homePath && assessment.level === "critical",
			);
		}
		if (assessment.level === "ok") continue;
		const key = assessment.space?.key ?? "unknown";
		if (reported.has(key)) continue;
		reported.add(key);
		if (
			!shouldNotify(
				`${ctx.narratorId}:${key}:${assessment.level}:${config.mode}`,
				config.checkIntervalMs,
			)
		)
			continue;
		if (!assessment.space) {
			notices.push(
				ctx.locale.startsWith("zh")
					? `磁盘安全检测暂不可用：${assessment.path}；本次未阻断，但无法保证空间预检有效。`
					: `Disk safety probe unavailable for ${assessment.path}; free space is unknown.`,
			);
		} else {
			const free = Math.floor(assessment.space.freeBytes / (1024 * 1024));
			notices.push(
				ctx.locale.startsWith("zh")
					? `磁盘空间警告：${assessment.space.mountPath} 仅余 ${free} MiB（${assessment.level}）。低空间下可选快照/dump 会跳过；请释放空间。`
					: `Disk space warning: ${assessment.space.mountPath} has ${free} MiB free (${assessment.level}). Optional snapshots/dumps may be skipped; free space before further writes.`,
			);
		}
	}
	if (remote && shouldNotify(`${ctx.narratorId}:remote-disk-unknown`, config.pathCacheTtlMs)) {
		notices.push(
			ctx.locale.startsWith("zh")
				? "远程设备磁盘空间尚不能探测；以上保护只覆盖 NarraFork 宿主磁盘。"
				: "Remote device disk space is not probed yet; this guard covers the NarraFork host only.",
		);
	}
	if (notices.length && config.mode === "warn") {
		notices.push(
			ctx.locale.startsWith("zh")
				? "管理员已选择 diskSafety.mode=warn：当前不会拒绝危险写入，也不会跳过快照/dump。"
				: "Administrator override diskSafety.mode=warn is active: unsafe writes and optional snapshots/dumps are not blocked.",
		);
	}
	return { assessments, notice: notices.length ? `\n\n${notices.join("\n")}` : "" };
}

export function diskToolError(
	error: unknown,
	locale: string,
	localFilesystem: boolean,
): { output: string; fatal?: boolean; metadata?: Record<string, unknown> } | null {
	let diskError = error instanceof DiskSpaceError ? error : null;
	if (!diskError) {
		const evidence = confirmedDiskFullEvidence(error);
		// A native SQLite FULL proves a database failure, not which database or
		// partition failed. Only an explicitly attributed application-DB boundary
		// below may promote it to a host DiskSpaceError. Never guess from cwd.
		if (!evidence || evidence.kind !== "filesystem" || !localFilesystem) return null;
		diskError = new DiskSpaceError(evidence.path, null, undefined, true);
	}
	if (diskError.occurred) diskSpaceMonitor.noteDiskFull(diskError.path);
	return {
		output: diskError.describe(locale),
		fatal: diskError.fatal || undefined,
		metadata: {
			diskSafety: {
				code: diskError.code,
				path: diskError.path,
				mountPath: diskError.space?.mountPath,
				freeBytes: diskError.space?.freeBytes,
				occurred: diskError.occurred,
			},
		},
	};
}

export function rethrowConfirmedToolDiskError(
	error: unknown,
	ctx: ToolContext,
	hostDatabase = false,
): void {
	if (error instanceof DiskSpaceError) throw error;
	const evidence = confirmedDiskFullEvidence(error);
	if (!evidence) return;
	if (evidence.kind === "sqlite") {
		// Explicit attribution by Write/Edit/StructSed: their in-process SQLite
		// operations use the application database, not a user/project database.
		if (hostDatabase) {
			const failure = new DiskSpaceError(getNarraforkHome(), null, undefined, true, true);
			failure.cause = error;
			throw failure;
		}
		return;
	}
	if (ctx.executionTarget?.backendKind === "local") throw error;
}
