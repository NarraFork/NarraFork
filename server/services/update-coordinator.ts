import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";

export type UpdatePhase = "idle" | "draining" | "restarting";
export type UpdateExecutionKind = "bash" | "subagent";

export interface UpdateCoordinationStatus {
	phase: UpdatePhase;
	scheduled: boolean;
	targetVersion?: string;
	pendingExecutionCount: number;
	error?: string;
}

export interface NarratorRecoveryTarget {
	narratorId: string;
	locale: string;
	userId?: string | null;
	replyInUserLanguage?: boolean;
}

export interface PlannedUpdateRecoverySnapshot {
	version: 1;
	targetVersion?: string;
	capturedAt: string;
	narrators: NarratorRecoveryTarget[];
}

export interface UpdateExecutionLease {
	readonly kind: UpdateExecutionKind;
	readonly token: string;
	setNarratorId(narratorId: string): void;
	release(): void;
}

interface CoordinatorState {
	phase: UpdatePhase;
	targetVersion?: string;
	error?: string;
}

interface ExecutionRecord {
	kind: UpdateExecutionKind;
	narratorId?: string;
	startedAt: number;
}

interface NarratorLoopRecord {
	narratorId: string;
	locale: string;
	userId?: string | null;
	replyInUserLanguage?: boolean;
	startedAt: number;
}

const UPDATE_DIR = getNarraforkPath("updates");
const RECOVERY_SNAPSHOT_PATH = join(UPDATE_DIR, "planned-update-recovery.json");

const state = hotSafe<CoordinatorState>("narrafork.updateCoordinator.state", () => ({
	phase: "idle",
}));
const executions = hotSafe<Map<string, ExecutionRecord>>(
	"narrafork.updateCoordinator.executions",
	() => new Map(),
);
const narratorLoops = hotSafe<Map<string, NarratorLoopRecord>>(
	"narrafork.updateCoordinator.narratorLoops",
	() => new Map(),
);

let drainWaiters: Array<() => void> = [];

function generateToken(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolveStatus(): UpdateCoordinationStatus {
	return {
		phase: state.phase,
		scheduled: state.phase !== "idle",
		...(state.targetVersion ? { targetVersion: state.targetVersion } : {}),
		pendingExecutionCount: executions.size,
		...(state.error ? { error: state.error } : {}),
	};
}

export function getUpdateCoordinationStatus(): UpdateCoordinationStatus {
	return resolveStatus();
}

export function isUpdateScheduled(): boolean {
	return state.phase !== "idle";
}

/** Return false when a new Bash/subagent execution must not start. */
export function canStartUpdateExecution(): boolean {
	return state.phase === "idle";
}

export function tryAcquireUpdateExecution(
	kind: UpdateExecutionKind,
	narratorId?: string,
): UpdateExecutionLease | null {
	if (!canStartUpdateExecution()) return null;

	const token = generateToken(kind);
	executions.set(token, {
		kind,
		narratorId,
		startedAt: Date.now(),
	});
	let released = false;

	return {
		kind,
		token,
		setNarratorId(id: string) {
			const record = executions.get(token);
			if (record) record.narratorId = id;
		},
		release() {
			if (released) return;
			released = true;
			executions.delete(token);
			if (executions.size === 0 && drainWaiters.length > 0) {
				const waiters = drainWaiters;
				drainWaiters = [];
				for (const resolve of waiters) resolve();
			}
		},
	};
}

export function registerNarratorLoop(
	narratorId: string,
	locale: string,
	options: { userId?: string | null; replyInUserLanguage?: boolean } = {},
): () => void {
	const token = generateToken("loop");
	narratorLoops.set(token, {
		narratorId,
		locale,
		userId: options.userId,
		replyInUserLanguage: options.replyInUserLanguage,
		startedAt: Date.now(),
	});
	let released = false;
	return () => {
		if (released) return;
		released = true;
		narratorLoops.delete(token);
	};
}

export function scheduleUpdate(targetVersion?: string): UpdateCoordinationStatus {
	if (state.phase !== "idle") return resolveStatus();
	state.phase = "draining";
	state.targetVersion = targetVersion;
	state.error = undefined;
	logger.info("Update scheduled; draining active Bash and subagent executions", {
		targetVersion,
		pendingExecutionCount: executions.size,
	});
	return resolveStatus();
}

export async function waitForUpdateExecutionDrain(): Promise<void> {
	if (executions.size === 0) return;
	await new Promise<void>((resolve) => {
		drainWaiters.push(resolve);
	});
}

export function markUpdateRestarting(): UpdateCoordinationStatus {
	if (state.phase === "idle") return resolveStatus();
	state.phase = "restarting";
	return resolveStatus();
}

export function failScheduledUpdate(error: string): UpdateCoordinationStatus {
	state.phase = "idle";
	state.targetVersion = undefined;
	state.error = error;
	logger.error("Scheduled update failed before replacement startup", { error });
	return resolveStatus();
}

export function clearUpdateError(): void {
	state.error = undefined;
}

export function capturePlannedUpdateRecoverySnapshot(): PlannedUpdateRecoverySnapshot {
	const targets = new Map<string, NarratorRecoveryTarget>();
	for (const record of narratorLoops.values()) {
		targets.set(record.narratorId, {
			narratorId: record.narratorId,
			locale: record.locale,
			userId: record.userId,
			replyInUserLanguage: record.replyInUserLanguage,
		});
	}
	for (const record of executions.values()) {
		if (record.kind !== "subagent" || !record.narratorId) continue;
		if (!targets.has(record.narratorId)) {
			targets.set(record.narratorId, { narratorId: record.narratorId, locale: "en" });
		}
	}

	return {
		version: 1,
		targetVersion: state.targetVersion,
		capturedAt: new Date().toISOString(),
		narrators: [...targets.values()],
	};
}

export function writePlannedUpdateRecoverySnapshot(
	snapshot: PlannedUpdateRecoverySnapshot = capturePlannedUpdateRecoverySnapshot(),
): PlannedUpdateRecoverySnapshot {
	mkdirSync(UPDATE_DIR, { recursive: true });
	const tempPath = `${RECOVERY_SNAPSHOT_PATH}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempPath, JSON.stringify(snapshot, null, 2));
	renameSync(tempPath, RECOVERY_SNAPSHOT_PATH);
	logger.info("Planned update recovery snapshot written", {
		path: RECOVERY_SNAPSHOT_PATH,
		narratorCount: snapshot.narrators.length,
	});
	return snapshot;
}

export function consumePlannedUpdateRecoverySnapshot(): PlannedUpdateRecoverySnapshot | null {
	if (!existsSync(RECOVERY_SNAPSHOT_PATH)) return null;
	try {
		const parsed = JSON.parse(
			readFileSync(RECOVERY_SNAPSHOT_PATH, "utf8"),
		) as PlannedUpdateRecoverySnapshot;
		if (parsed.version !== 1 || !Array.isArray(parsed.narrators)) return null;
		// Keep the snapshot until every recovery target has been handled successfully.
		// The recovery service may rewrite it with only transiently failed targets.
		return {
			version: 1,
			targetVersion: typeof parsed.targetVersion === "string" ? parsed.targetVersion : undefined,
			capturedAt:
				typeof parsed.capturedAt === "string" ? parsed.capturedAt : new Date().toISOString(),
			narrators: parsed.narrators.flatMap((entry) => {
				if (
					!entry ||
					typeof entry !== "object" ||
					typeof entry.narratorId !== "string" ||
					typeof entry.locale !== "string"
				) {
					return [];
				}
				return [
					{
						narratorId: entry.narratorId,
						locale: entry.locale,
						...(typeof entry.userId === "string" || entry.userId === null
							? { userId: entry.userId }
							: {}),
						...(typeof entry.replyInUserLanguage === "boolean"
							? { replyInUserLanguage: entry.replyInUserLanguage }
							: {}),
					},
				];
			}),
		};
	} catch (error) {
		logger.warn("Failed to consume planned update recovery snapshot", {
			path: RECOVERY_SNAPSHOT_PATH,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export function removePlannedUpdateRecoverySnapshot(): void {
	try {
		unlinkSync(RECOVERY_SNAPSHOT_PATH);
	} catch {
		// already absent
	}
}

/** Test-only reset helper; production code never needs to reset a scheduled update. */
export function resetUpdateCoordinationForTests(): void {
	for (const token of executions.keys()) executions.delete(token);
	for (const token of narratorLoops.keys()) narratorLoops.delete(token);
	drainWaiters = [];
	state.phase = "idle";
	state.targetVersion = undefined;
	state.error = undefined;
	removePlannedUpdateRecoverySnapshot();
}
