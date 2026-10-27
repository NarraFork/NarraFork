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
import { logger } from "../logger";
import { getNarraforkHome } from "../narrafork-home";
import { OUTLINE_READ_TOOLS } from "./tools/outline-names";
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
	...OUTLINE_READ_TOOLS,
]);
const warnedAt = new Map<string, number>();
/** Operator log throttle, separate so diagnostics can never evict model-notice keys. */
const loggedAt = new Map<string, number>();
const MAX_NOTICES = 512;

/** Health notices are per narrator + volume, not per file. No persistent DB writes or timers. */
function throttle(map: Map<string, number>, key: string, intervalMs: number): boolean {
	const now = Date.now();
	const last = map.get(key);
	if (last !== undefined && now - last < intervalMs) return false;
	map.delete(key);
	map.set(key, now);
	if (map.size > MAX_NOTICES) {
		const first = map.keys().next();
		if (!first.done) map.delete(first.value);
	}
	return true;
}
const shouldNotify = (key: string, intervalMs: number) => throttle(warnedAt, key, intervalMs);
const shouldLog = (key: string, intervalMs: number) => throttle(loggedAt, key, intervalMs);

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
		toolName === "Stop" ||
		(["Bash", "bash", "Agent", "Task"].includes(toolName) &&
			typeof input.stop === "string" &&
			!input.command);
	const readOnly = READ_ONLY_TOOLS.has(toolName) || cancelling;
	const writeVolumes = new Set(
		endpoints
			.filter((e) => e.operation === "write" || e.operation === "execute")
			.map((e) => e.target.canonicalPath ?? e.target.cwd),
	);
	// Only advice the model can act on goes into tool output. Probe failures, remote
	// coverage gaps and the warn-mode override are operator diagnostics: an agent cannot
	// repair them, and a footer on a successful result reads as a tool failure.
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
		if (!assessment.space) {
			// Host state, not per narrator or per file: throttle by failure cause (+ HOME), so
			// a host whose statfs never works logs once per TTL rather than once per Read path.
			const reason = monitor.failureReason(assessment.path) ?? "unknown";
			if (shouldLog(`probe-unknown:${homePath}:${reason}`, config.pathCacheTtlMs))
				logger.warn("Disk safety probe unavailable; free space unknown, writes not blocked", {
					path: assessment.path,
					isHome: homePath,
					reason,
					mode: config.mode,
					platform: process.platform,
				});
			continue;
		}
		const key = assessment.space.key;
		if (reported.has(key)) continue;
		reported.add(key);
		if (
			!shouldNotify(
				`${ctx.narratorId}:${key}:${assessment.level}:${config.mode}`,
				config.checkIntervalMs,
			)
		)
			continue;
		const free = Math.floor(assessment.space.freeBytes / (1024 * 1024));
		notices.push(
			ctx.locale.startsWith("zh")
				? `磁盘空间警告：${assessment.space.mountPath} 仅余 ${free} MiB。请避免大体积写入（大文件、构建产物、依赖安装），必要时提醒用户释放空间。`
				: `Disk space warning: ${assessment.space.mountPath} has only ${free} MiB free. Avoid large writes (big files, build output, dependency installs) and tell the user if space is needed.`,
		);
	}
	// Intentionally global: one coverage reminder per TTL for the whole host, not per narrator.
	if (remote && shouldLog("remote-disk-unknown", config.pathCacheTtlMs))
		logger.info("Disk safety does not probe remote devices; only the host disk is guarded", {
			narratorId: ctx.narratorId,
		});
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
