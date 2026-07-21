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

export type UpdatePhase = "idle" | "draining_background_bash" | "quiescing_tools" | "restarting";
export type UpdateExecutionKind = "background_bash" | "ordinary" | "resumable";
type LegacyUpdateExecutionKind = "bash" | "subagent";

export interface UpdateCoordinationStatus {
	phase: UpdatePhase;
	scheduled: boolean;
	targetVersion?: string;
	updateEpoch?: string;
	pendingBackgroundBashCount: number;
	pendingOrdinaryExecutionCount: number;
	resumableExecutionCount: number;
	pausedToolCount: number;
	pendingToolStartGrantCount: number;
	pendingPreAdmissionCount: number;
	activeResponseCount: number;
	/** Compatibility total for callers that have not migrated to per-kind counts. */
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
	version: 2;
	updateEpoch: string;
	targetVersion?: string;
	capturedAt: string;
	narrators: NarratorRecoveryTarget[];
}

interface WritablePlannedUpdateRecoverySnapshot {
	version: 1 | 2;
	updateEpoch?: string;
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

export interface UpdateToolStartGrant {
	readonly kind: UpdateExecutionKind;
	readonly token: string;
	setNarratorId(narratorId: string): void;
	release(): void;
}

export interface UpdateCheckpointActivityLease {
	readonly token: string;
	release(): void;
}

interface CoordinatorState {
	phase: UpdatePhase;
	targetVersion?: string;
	updateEpoch?: string;
	error?: string;
}

interface ExecutionRecord {
	kind: UpdateExecutionKind | LegacyUpdateExecutionKind;
	narratorId?: string;
	startedAt: number;
}

interface ToolStartGrantRecord {
	kind: UpdateExecutionKind;
	narratorId: string;
	toolUseId: string;
	startedAt: number;
}

export type UpdateToolStartAdmission =
	| { status: "granted"; grant: UpdateToolStartGrant }
	| {
			status: "paused";
			updateEpoch: string;
			activity: UpdateCheckpointActivityLease;
	  };

export type UpdateToolStartExecutionTransition = {
	status: "execution";
	lease: UpdateExecutionLease;
};

interface NarratorLoopRecord {
	narratorId: string;
	locale: string;
	userId?: string | null;
	replyInUserLanguage?: boolean;
	startedAt: number;
}

interface GateWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface CheckpointActivityRecord {
	narratorId: string;
	toolUseId?: string;
	updateEpoch?: string;
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
const toolStartGrants = hotSafe<Map<string, ToolStartGrantRecord>>(
	"narrafork.updateCoordinator.toolStartGrants",
	() => new Map(),
);
const preAdmissionActivities = hotSafe<Map<string, CheckpointActivityRecord>>(
	"narrafork.updateCoordinator.preAdmissionActivities",
	() => new Map(),
);
const responseActivities = hotSafe<Map<string, CheckpointActivityRecord>>(
	"narrafork.updateCoordinator.responseActivities",
	() => new Map(),
);

// Migrate hot-reloaded state created by the former idle/draining/restarting coordinator.
if ((state.phase as string) === "draining") {
	state.phase = "draining_background_bash";
}
if (state.phase !== "idle" && !state.updateEpoch) {
	state.updateEpoch = generateUpdateEpoch();
}

let backgroundBashDrainWaiters: Array<() => void> = [];
let ordinaryDrainWaiters: Array<() => void> = [];
let checkpointFenceWaiters: Array<() => void> = [];
const gateWaiters = new Map<string, GateWaiter>();

function generateToken(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateUpdateEpoch(): string {
	return generateToken("update");
}

function normalizeExecutionKind(
	kind: UpdateExecutionKind | LegacyUpdateExecutionKind,
): UpdateExecutionKind {
	if (kind === "bash") return "background_bash";
	if (kind === "subagent") return "ordinary";
	return kind;
}

function countExecutions(kind: UpdateExecutionKind): number {
	let count = 0;
	for (const record of executions.values()) {
		if (normalizeExecutionKind(record.kind) === kind) count++;
	}
	return count;
}

function resolveStatus(): UpdateCoordinationStatus {
	const pendingBackgroundBashCount = countExecutions("background_bash");
	const pendingOrdinaryExecutionCount = countExecutions("ordinary");
	const resumableExecutionCount = countExecutions("resumable");
	return {
		phase: state.phase,
		scheduled: state.phase !== "idle",
		...(state.targetVersion ? { targetVersion: state.targetVersion } : {}),
		...(state.updateEpoch ? { updateEpoch: state.updateEpoch } : {}),
		pendingBackgroundBashCount,
		pendingOrdinaryExecutionCount,
		resumableExecutionCount,
		pausedToolCount: gateWaiters.size,
		pendingPreAdmissionCount: preAdmissionActivities.size,
		activeResponseCount: responseActivities.size,
		pendingExecutionCount:
			pendingBackgroundBashCount + pendingOrdinaryExecutionCount + resumableExecutionCount,
		pendingToolStartGrantCount: toolStartGrants.size,
		...(state.error ? { error: state.error } : {}),
	};
}

function resolveDrainWaitersIfReady(): void {
	if (countExecutions("background_bash") === 0 && backgroundBashDrainWaiters.length > 0) {
		const waiters = backgroundBashDrainWaiters;
		backgroundBashDrainWaiters = [];
		for (const resolve of waiters) resolve();
	}
	if (countExecutions("ordinary") === 0 && ordinaryDrainWaiters.length > 0) {
		const waiters = ordinaryDrainWaiters;
		ordinaryDrainWaiters = [];
		for (const resolve of waiters) resolve();
	}
}

function checkpointFenceIsStable(): boolean {
	return (
		toolStartGrants.size === 0 && preAdmissionActivities.size === 0 && responseActivities.size === 0
	);
}

function resolveCheckpointFenceWaitersIfReady(): void {
	if (!checkpointFenceIsStable() || checkpointFenceWaiters.length === 0) return;
	const waiters = checkpointFenceWaiters;
	checkpointFenceWaiters = [];
	for (const resolve of waiters) resolve();
}

function registerCheckpointActivity(
	map: Map<string, CheckpointActivityRecord>,
	prefix: string,
	record: Omit<CheckpointActivityRecord, "startedAt">,
): UpdateCheckpointActivityLease {
	const token = generateToken(prefix);
	map.set(token, { ...record, startedAt: Date.now() });
	let released = false;
	return {
		token,
		release() {
			if (released) return;
			released = true;
			map.delete(token);
			resolveCheckpointFenceWaitersIfReady();
		},
	};
}

function settleGateWaiter(token: string, action: "resolve" | "abort"): void {
	const waiter = gateWaiters.get(token);
	if (!waiter) return;
	gateWaiters.delete(token);
	if (waiter.signal && waiter.onAbort) {
		waiter.signal.removeEventListener("abort", waiter.onAbort);
	}
	if (action === "resolve") {
		waiter.resolve();
		return;
	}
	const error = new Error("Waiting for the update gate was aborted");
	error.name = "AbortError";
	waiter.reject(error);
}

function openUpdateGate(): void {
	for (const token of [...gateWaiters.keys()]) settleGateWaiter(token, "resolve");
}

export function getUpdateCoordinationStatus(): UpdateCoordinationStatus {
	return resolveStatus();
}

export function isUpdateScheduled(): boolean {
	return state.phase !== "idle";
}

/**
 * Track one provider response that may still produce tool rows. Phase two prevents new
 * responses from entering while allowing a response already in flight to reach persistence.
 */
export async function beginNarratorResponseActivity(
	narratorId: string,
	signal?: AbortSignal,
): Promise<UpdateCheckpointActivityLease> {
	while (state.phase === "quiescing_tools" || state.phase === "restarting") {
		await waitUntilUpdateGateOpens(signal);
	}
	return registerCheckpointActivity(responseActivities, "response", { narratorId });
}

/** Track a rejected tool admission until its durable continuation row is stable. */
export function beginUpdatePreAdmissionActivity(
	updateEpoch: string,
	narratorId: string,
	toolUseId: string,
): UpdateCheckpointActivityLease | null {
	if (state.phase === "idle" || state.updateEpoch !== updateEpoch) return null;
	return registerCheckpointActivity(preAdmissionActivities, "pre_admission", {
		narratorId,
		toolUseId,
		updateEpoch,
	});
}

export async function waitForUpdateCheckpointFence(
	options: { timeoutMs?: number } = {},
): Promise<void> {
	if (checkpointFenceIsStable()) return;
	const timeoutMs = options.timeoutMs ?? 30_000;
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			checkpointFenceWaiters = checkpointFenceWaiters.filter((waiter) => waiter !== finish);
			resolve();
		};
		checkpointFenceWaiters.push(finish);
		if (checkpointFenceIsStable()) {
			finish();
			return;
		}
		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			checkpointFenceWaiters = checkpointFenceWaiters.filter((waiter) => waiter !== finish);
			logger.error("Timed out waiting for the planned-update checkpoint fence", {
				timeoutMs,
				activeResponses: [...responseActivities.values()].slice(0, 20),
				pendingToolStartGrants: [...toolStartGrants.values()].slice(0, 20),
				pendingPreAdmissions: [...preAdmissionActivities.values()].slice(0, 20),
			});
			reject(
				new Error(
					`Timed out waiting for update checkpoint fence after ${timeoutMs}ms ` +
						`(${responseActivities.size} active responses, ` +
						`${toolStartGrants.size} tool start grants, ` +
						`${preAdmissionActivities.size} pre-admissions)`,
				),
			);
		}, timeoutMs);
		(timer as { unref?: () => void }).unref?.();
	});
}

export function canStartFinalUpdateExecution(kind: UpdateExecutionKind): boolean {
	switch (state.phase) {
		case "idle":
			return true;
		case "draining_background_bash":
			return kind !== "background_bash";
		case "quiescing_tools":
		case "restarting":
			return false;
	}
}

function registerExecutionLease(
	kind: UpdateExecutionKind,
	narratorId?: string,
): UpdateExecutionLease {
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
			resolveDrainWaitersIfReady();
		},
	};
}

function registerRejectedToolStart(
	narratorId: string,
	toolUseId: string,
): Extract<UpdateToolStartAdmission, { status: "paused" }> {
	if (state.phase === "idle" || !state.updateEpoch) {
		throw new Error("Cannot register a rejected tool start without an active update epoch");
	}
	const updateEpoch = state.updateEpoch;
	return {
		status: "paused",
		updateEpoch,
		activity: registerCheckpointActivity(preAdmissionActivities, "pre_admission", {
			narratorId,
			toolUseId,
			updateEpoch,
		}),
	};
}

/**
 * Atomically decide phase-one admission and register either a start grant or the
 * durable-pause activity that fences checkpointing. A granted result is the irrevocable
 * tool-start linearization point. The synchronous function body is the critical section:
 * a phase switch cannot interleave with the decision/record.
 */
export function beginToolStartAdmission(
	kind: UpdateExecutionKind,
	narratorId: string,
	toolUseId: string,
): UpdateToolStartAdmission {
	if (!canStartFinalUpdateExecution(kind)) {
		return registerRejectedToolStart(narratorId, toolUseId);
	}

	const token = generateToken("tool_start");
	toolStartGrants.set(token, { kind, narratorId, toolUseId, startedAt: Date.now() });
	let released = false;
	const grant: UpdateToolStartGrant = {
		kind,
		token,
		setNarratorId(id: string) {
			const record = toolStartGrants.get(token);
			if (record) record.narratorId = id;
		},
		release() {
			if (released) return;
			released = true;
			toolStartGrants.delete(token);
			resolveCheckpointFenceWaitersIfReady();
		},
	};
	return { status: "granted", grant };
}

/**
 * Atomically convert an irrevocable start grant into its execution lease. The grant itself is
 * the start linearization point, so a later phase change cannot turn already-started work into
 * a durable pause. Phase two only prevents beginToolStartAdmission from issuing new grants.
 */
export function convertToolStartGrantToExecution(
	grant: UpdateToolStartGrant,
	narratorId: string,
	_toolUseId: string,
): UpdateToolStartExecutionTransition {
	const record = toolStartGrants.get(grant.token);
	if (!record) throw new Error("Tool start grant is no longer active");
	if (record.kind !== grant.kind) throw new Error("Tool start grant kind changed unexpectedly");

	const lease = registerExecutionLease(record.kind, narratorId);
	toolStartGrants.delete(grant.token);
	resolveCheckpointFenceWaitersIfReady();
	return { status: "execution", lease };
}

/**
 * Perform the final synchronous admission check and register the execution lease.
 * Callers must use the returned lease as the authority to start work.
 */
export function tryAcquireFinalUpdateExecution(
	kind: UpdateExecutionKind,
	narratorId?: string,
): UpdateExecutionLease | null {
	if (!canStartFinalUpdateExecution(kind)) return null;
	return registerExecutionLease(kind, narratorId);
}

/**
 * Compatibility wrapper for existing Bash/subagent call sites.
 * Legacy Bash is conservatively treated as background Bash until those callers migrate.
 */
export function tryAcquireUpdateExecution(
	kind: UpdateExecutionKind | LegacyUpdateExecutionKind,
	narratorId?: string,
): UpdateExecutionLease | null {
	return tryAcquireFinalUpdateExecution(normalizeExecutionKind(kind), narratorId);
}

/** Compatibility admission helper retained for callers using the former API. */
export function canStartUpdateExecution(narratorId?: string): boolean {
	void narratorId;
	return canStartFinalUpdateExecution("ordinary");
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
	state.phase = "draining_background_bash";
	state.targetVersion = targetVersion;
	state.updateEpoch = generateUpdateEpoch();
	state.error = undefined;
	logger.info("Update scheduled; draining background Bash executions", {
		targetVersion,
		updateEpoch: state.updateEpoch,
		pendingBackgroundBashCount: countExecutions("background_bash"),
		pendingOrdinaryExecutionCount: countExecutions("ordinary"),
		resumableExecutionCount: countExecutions("resumable"),
	});
	return resolveStatus();
}

export async function waitForBackgroundBashDrain(): Promise<void> {
	if (countExecutions("background_bash") === 0) return;
	await new Promise<void>((resolve) => {
		backgroundBashDrainWaiters.push(resolve);
	});
}

export function beginQuiescingTools(): UpdateCoordinationStatus {
	if (state.phase === "draining_background_bash") {
		state.phase = "quiescing_tools";
		logger.info("Background Bash drained; closing the checkpoint fence", {
			updateEpoch: state.updateEpoch,
			pendingOrdinaryExecutionCount: countExecutions("ordinary"),
			resumableExecutionCount: countExecutions("resumable"),
			activeResponseCount: responseActivities.size,
			pendingToolStartGrantCount: toolStartGrants.size,
			pendingPreAdmissionCount: preAdmissionActivities.size,
		});
	}
	return resolveStatus();
}

export async function waitForOrdinaryToolDrain(): Promise<void> {
	if (countExecutions("ordinary") === 0) return;
	await new Promise<void>((resolve) => {
		ordinaryDrainWaiters.push(resolve);
	});
}

/** Compatibility drain helper. Resumable work intentionally never blocks restart. */
export async function waitForUpdateExecutionDrain(): Promise<void> {
	await waitForBackgroundBashDrain();
	await waitForOrdinaryToolDrain();
}

/**
 * Suspend a rejected tool until a failed/cancelled update returns the coordinator to idle.
 * This is a gate wait, not a tool failure result.
 */
export async function waitUntilUpdateGateOpens(signal?: AbortSignal): Promise<void> {
	if (state.phase === "idle") return;
	if (signal?.aborted) {
		const error = new Error("Waiting for the update gate was aborted");
		error.name = "AbortError";
		throw error;
	}

	const token = generateToken("paused_tool");
	await new Promise<void>((resolve, reject) => {
		const waiter: GateWaiter = { resolve, reject, signal };
		if (signal) {
			waiter.onAbort = () => settleGateWaiter(token, "abort");
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		}
		gateWaiters.set(token, waiter);
		// Close the race where failure opened the gate between the initial check and registration.
		if (state.phase === "idle") settleGateWaiter(token, "resolve");
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
	state.updateEpoch = undefined;
	state.error = error;
	openUpdateGate();
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
		if (!record.narratorId || targets.has(record.narratorId)) continue;
		targets.set(record.narratorId, { narratorId: record.narratorId, locale: "en" });
	}

	return {
		version: 2,
		updateEpoch: state.updateEpoch ?? generateUpdateEpoch(),
		targetVersion: state.targetVersion,
		capturedAt: new Date().toISOString(),
		narrators: [...targets.values()],
	};
}

function parseNarrators(value: unknown): NarratorRecoveryTarget[] | null {
	if (!Array.isArray(value)) return null;
	return value.flatMap((entry) => {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof (entry as NarratorRecoveryTarget).narratorId !== "string" ||
			typeof (entry as NarratorRecoveryTarget).locale !== "string"
		) {
			return [];
		}
		const target = entry as NarratorRecoveryTarget;
		return [
			{
				narratorId: target.narratorId,
				locale: target.locale,
				...(typeof target.userId === "string" || target.userId === null
					? { userId: target.userId }
					: {}),
				...(typeof target.replyInUserLanguage === "boolean"
					? { replyInUserLanguage: target.replyInUserLanguage }
					: {}),
			},
		];
	});
}

export function parsePlannedUpdateRecoverySnapshot(
	value: unknown,
): PlannedUpdateRecoverySnapshot | null {
	if (!value || typeof value !== "object") return null;
	const parsed = value as Partial<WritablePlannedUpdateRecoverySnapshot>;
	if (parsed.version !== 1 && parsed.version !== 2) return null;
	const narrators = parseNarrators(parsed.narrators);
	if (!narrators) return null;
	if (parsed.version === 2 && typeof parsed.updateEpoch !== "string") return null;
	const capturedAt =
		typeof parsed.capturedAt === "string" ? parsed.capturedAt : new Date().toISOString();

	return {
		version: 2,
		updateEpoch:
			parsed.version === 2
				? (parsed.updateEpoch as string)
				: `legacy_${capturedAt.replace(/[^a-zA-Z0-9]/g, "_")}`,
		targetVersion: typeof parsed.targetVersion === "string" ? parsed.targetVersion : undefined,
		capturedAt,
		narrators,
	};
}

function readExistingRecoverySnapshotEpoch(): string | undefined {
	if (!existsSync(RECOVERY_SNAPSHOT_PATH)) return undefined;
	try {
		return parsePlannedUpdateRecoverySnapshot(
			JSON.parse(readFileSync(RECOVERY_SNAPSHOT_PATH, "utf8")),
		)?.updateEpoch;
	} catch {
		return undefined;
	}
}

/**
 * Optional caller assertion for recovery-manifest mutations.
 *
 * The single on-disk recovery manifest is owned by exactly one update epoch at a time. Every
 * write is therefore compare-and-set by default: an existing manifest may only be replaced by a
 * snapshot with the same epoch. `expectedEpoch` additionally asserts which epoch the caller owns.
 */
export interface RecoveryManifestEpochGuard {
	expectedEpoch: string;
}

export class RecoveryManifestEpochConflictError extends Error {
	constructor(
		readonly manifestEpoch: string | null,
		readonly incomingEpoch: string,
	) {
		super(
			`Recovery manifest belongs to epoch ${manifestEpoch ?? "unknown"}; refusing to replace it with epoch ${incomingEpoch}`,
		);
		this.name = "RecoveryManifestEpochConflictError";
	}
}

export function writePlannedUpdateRecoverySnapshot(
	snapshot: WritablePlannedUpdateRecoverySnapshot = capturePlannedUpdateRecoverySnapshot(),
	guard: Partial<RecoveryManifestEpochGuard> = {},
): PlannedUpdateRecoverySnapshot {
	const normalized = parsePlannedUpdateRecoverySnapshot({
		...snapshot,
		version: 2,
		updateEpoch: snapshot.updateEpoch ?? state.updateEpoch ?? generateUpdateEpoch(),
	});
	if (!normalized) throw new Error("Invalid planned update recovery snapshot");

	if (guard.expectedEpoch !== undefined && normalized.updateEpoch !== guard.expectedEpoch) {
		throw new Error(
			`Recovery manifest epoch guard mismatch: snapshot epoch ${normalized.updateEpoch} does not match expected ${guard.expectedEpoch}`,
		);
	}

	const manifestExists = existsSync(RECOVERY_SNAPSHOT_PATH);
	const existingEpoch = readExistingRecoverySnapshotEpoch();
	if (manifestExists && existingEpoch !== normalized.updateEpoch) {
		logger.warn("Refused to replace recovery manifest owned by a different update epoch", {
			path: RECOVERY_SNAPSHOT_PATH,
			manifestEpoch: existingEpoch ?? null,
			incomingEpoch: normalized.updateEpoch,
		});
		throw new RecoveryManifestEpochConflictError(existingEpoch ?? null, normalized.updateEpoch);
	}

	mkdirSync(UPDATE_DIR, { recursive: true });
	const tempPath = `${RECOVERY_SNAPSHOT_PATH}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempPath, JSON.stringify(normalized, null, 2));
	renameSync(tempPath, RECOVERY_SNAPSHOT_PATH);
	logger.info("Planned update recovery snapshot written", {
		path: RECOVERY_SNAPSHOT_PATH,
		updateEpoch: normalized.updateEpoch,
		narratorCount: normalized.narrators.length,
	});
	return normalized;
}

export function consumePlannedUpdateRecoverySnapshot(): PlannedUpdateRecoverySnapshot | null {
	if (!existsSync(RECOVERY_SNAPSHOT_PATH)) return null;
	try {
		return parsePlannedUpdateRecoverySnapshot(
			JSON.parse(readFileSync(RECOVERY_SNAPSHOT_PATH, "utf8")),
		);
	} catch (error) {
		logger.warn("Failed to consume planned update recovery snapshot", {
			path: RECOVERY_SNAPSHOT_PATH,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export function removePlannedUpdateRecoverySnapshot(guard: RecoveryManifestEpochGuard): void {
	const existingEpoch = readExistingRecoverySnapshotEpoch();
	// Absent manifest: nothing to remove, and a corrupt/unparseable manifest (undefined epoch while
	// the file exists) is not claimed by this epoch, so leave it for its owner/consumer.
	if (existingEpoch !== guard.expectedEpoch) {
		if (existsSync(RECOVERY_SNAPSHOT_PATH)) {
			logger.warn("Skipped recovery manifest removal owned by a different update epoch", {
				path: RECOVERY_SNAPSHOT_PATH,
				expectedEpoch: guard.expectedEpoch,
				manifestEpoch: existingEpoch ?? null,
			});
		}
		return;
	}
	try {
		unlinkSync(RECOVERY_SNAPSHOT_PATH);
	} catch {
		// already absent
	}
}

/** Test-only reset helper; production code never needs to reset a scheduled update. */
export function resetUpdateCoordinationForTests(): void {
	executions.clear();
	narratorLoops.clear();
	toolStartGrants.clear();
	preAdmissionActivities.clear();
	responseActivities.clear();
	backgroundBashDrainWaiters = [];
	ordinaryDrainWaiters = [];
	const fenceWaiters = checkpointFenceWaiters;
	checkpointFenceWaiters = [];
	for (const resolve of fenceWaiters) resolve();
	state.phase = "idle";
	state.targetVersion = undefined;
	state.updateEpoch = undefined;
	state.error = undefined;
	openUpdateGate();
	try {
		unlinkSync(RECOVERY_SNAPSHOT_PATH);
	} catch {
		// already absent
	}
}
