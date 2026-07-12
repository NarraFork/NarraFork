/** Device-aware, compensating snapshot rollback helpers used before history deletion. */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, narratorToolCalls } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { LOCAL_DEVICE_ID, readCompleteFileBytes } from "../lib/agent/execution/backend";
import { backendDirname } from "../lib/agent/execution/path-resolve";
import { ExecutionTargetError, resolveBackend } from "../lib/agent/execution/registry";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { getDevice, isDeviceAuthorizedForProject } from "./device-service";
import {
	type DeviceFileIdentity,
	type DeviceFileState,
	FileHistoryError,
	getAffectedDeviceFilesStrict,
	rebuildDeviceFileStatesExcluding,
} from "./file-state-rebuild";

export type RevertFailureCode =
	| "REMOTE_DEVICE_UNAVAILABLE"
	| "REMOTE_DEVICE_UNAUTHORIZED"
	| "MISSING_EXECUTION_PATH"
	| "MISSING_LOCAL_CWD"
	| "UNSAFE_LEGACY_REMOTE_TARGET"
	| "PREPARE_FAILED"
	| "WRITE_FAILED"
	| "DELETE_FAILED"
	| "COMPENSATION_FAILED";

export interface RevertFailure {
	deviceId: string;
	filePath: string;
	code: RevertFailureCode;
	message: string;
}

export interface RevertResult {
	reverted: boolean;
	fileCount: number;
	files: string[];
	failures: RevertFailure[];
}

const EMPTY_RESULT: RevertResult = { reverted: false, fileCount: 0, files: [], failures: [] };
const compensationPlans = new WeakMap<RevertResult, RevertPlanItem[]>();

export class SnapshotRevertError extends AppError {
	constructor(public readonly failures: RevertFailure[]) {
		const first = failures[0];
		const detail = first ? `${first.code}: ${first.message}` : "unknown rollback failure";
		super(
			`File rollback did not complete; history was not deleted. ${detail}`,
			409,
			"SNAPSHOT_REVERT_FAILED",
		);
		this.name = "SnapshotRevertError";
	}
}

export function assertSnapshotRevertComplete(result: RevertResult): void {
	if (result.failures.length > 0) throw new SnapshotRevertError(result.failures);
}

/** Resolve the current local cwd used only to canonicalize legacy local records. */
export async function resolveNarratorCwd(narratorId: string): Promise<string | null> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true, cwd: true },
	});
	if (!narrator) return null;

	if (narrator.chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
			columns: { worktreePath: true },
		});
		return chapter?.worktreePath ?? null;
	}
	return narrator.cwd ?? null;
}

async function resolveNarratorProjectId(narratorId: string): Promise<string | null> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true },
	});
	if (!narrator?.chapterId) return null;
	const chapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, narrator.chapterId),
		columns: { projectId: true },
	});
	return chapter?.projectId ?? null;
}

function displayFile(identity: DeviceFileIdentity): string {
	return identity.deviceId === LOCAL_DEVICE_ID
		? identity.filePath
		: `${identity.deviceId}:${identity.filePath}`;
}

interface CapturedFileState {
	exists: boolean;
	bytes: Uint8Array | null;
}

interface RevertPlanItem {
	backend: ExecutionBackend;
	state: DeviceFileState;
	before: CapturedFileState;
}

async function captureFileState(
	backend: ExecutionBackend,
	filePath: string,
): Promise<CapturedFileState> {
	const stat = await backend.statFile(filePath);
	if (!stat) return { exists: false, bytes: null };
	if (!stat.isFile) throw new Error(`Rollback target is not a regular file: ${filePath}`);
	const current = await readCompleteFileBytes(backend, filePath);
	return { exists: true, bytes: Uint8Array.from(current.bytes) };
}

async function applyFileState(
	backend: ExecutionBackend,
	filePath: string,
	content: string | null,
): Promise<void> {
	if (content === null) {
		await backend.removeFile(filePath);
		return;
	}
	await backend.mkdirp(backendDirname(backend, filePath));
	await backend.writeFileBytes(filePath, new TextEncoder().encode(content));
}

async function restoreCapturedState(item: RevertPlanItem): Promise<void> {
	if (!item.before.exists) {
		await item.backend.removeFile(item.state.filePath);
		return;
	}
	if (!item.before.bytes) throw new Error("Captured file bytes are missing");
	await item.backend.mkdirp(backendDirname(item.backend, item.state.filePath));
	await item.backend.writeFileBytes(item.state.filePath, item.before.bytes);
}

function validateResolvedBackend(deviceId: string, backend: ExecutionBackend): void {
	const expectedKind = deviceId === LOCAL_DEVICE_ID ? "local" : "remote";
	if (backend.deviceId !== deviceId || backend.kind !== expectedKind) {
		throw new Error(
			`Resolved backend mismatch for ${deviceId}: got ${backend.kind}/${backend.deviceId}`,
		);
	}
}

function failure(
	state: DeviceFileIdentity,
	code: RevertFailureCode,
	error: unknown,
): RevertFailure {
	return {
		deviceId: state.deviceId,
		filePath: state.filePath,
		code,
		message: error instanceof Error ? error.message : String(error),
	};
}

async function prepareRevertPlan(
	states: DeviceFileState[],
	projectId: string | null,
): Promise<{
	plan: RevertPlanItem[];
	failures: RevertFailure[];
}> {
	const plan: RevertPlanItem[] = [];
	const failures: RevertFailure[] = [];
	const backends = new Map<string, ExecutionBackend>();

	for (const state of states) {
		let backend = backends.get(state.deviceId);
		if (!backend) {
			if (state.deviceId !== LOCAL_DEVICE_ID) {
				const device = await getDevice(state.deviceId);
				if (!device) {
					failures.push(
						failure(
							state,
							"REMOTE_DEVICE_UNAVAILABLE",
							new Error(`Remote device "${state.deviceId}" is unknown or revoked.`),
						),
					);
					continue;
				}
				if (!isDeviceAuthorizedForProject(device, projectId)) {
					failures.push(
						failure(
							state,
							"REMOTE_DEVICE_UNAUTHORIZED",
							new Error(
								projectId
									? `Remote device "${state.deviceId}" is not authorized for project "${projectId}".`
									: `Standalone narrator history may only target global remote devices; "${state.deviceId}" is project-scoped.`,
							),
						),
					);
					continue;
				}
			}
			try {
				backend = resolveBackend({ requested: state.deviceId });
				validateResolvedBackend(state.deviceId, backend);
				backends.set(state.deviceId, backend);
			} catch (error) {
				const code =
					error instanceof ExecutionTargetError ? error.code : ("PREPARE_FAILED" as const);
				failures.push(failure(state, code, error));
				continue;
			}
		}
		try {
			plan.push({ backend, state, before: await captureFileState(backend, state.filePath) });
		} catch (error) {
			failures.push(failure(state, "PREPARE_FAILED", error));
		}
	}
	return { plan, failures };
}

async function compensateAttempted(items: RevertPlanItem[]): Promise<RevertFailure[]> {
	const failures: RevertFailure[] = [];
	for (const item of [...items].reverse()) {
		try {
			await restoreCapturedState(item);
		} catch (error) {
			failures.push(failure(item.state, "COMPENSATION_FAILED", error));
		}
	}
	return failures;
}

/**
 * Commit the accompanying history mutation. If it fails, restore the exact file
 * bytes captured before rollback so filesystem state and retained history agree.
 */
export async function commitSnapshotRevert<T>(
	result: RevertResult,
	commit: () => T | Promise<T>,
): Promise<T> {
	assertSnapshotRevertComplete(result);
	try {
		const value = await commit();
		compensationPlans.delete(result);
		return value;
	} catch (error) {
		const plan = compensationPlans.get(result) ?? [];
		compensationPlans.delete(result);
		const compensationFailures = await compensateAttempted(plan);
		if (compensationFailures.length > 0) {
			logger.error("History mutation failed and snapshot compensation was incomplete", {
				commitError: String(error),
				compensationFailureCount: compensationFailures.length,
			});
			throw new SnapshotRevertError(compensationFailures);
		}
		throw error;
	}
}

export async function applyDeviceFileStates(
	narratorId: string,
	states: DeviceFileState[],
): Promise<RevertResult> {
	if (states.length === 0) return EMPTY_RESULT;
	const projectId = await resolveNarratorProjectId(narratorId);
	const sortedStates = [...states].sort(
		(left, right) =>
			left.deviceId.localeCompare(right.deviceId) || left.filePath.localeCompare(right.filePath),
	);
	const prepared = await prepareRevertPlan(sortedStates, projectId);
	if (prepared.failures.length > 0) {
		return { ...EMPTY_RESULT, failures: prepared.failures };
	}

	const attempted: RevertPlanItem[] = [];
	for (const item of prepared.plan) {
		attempted.push(item);
		try {
			await applyFileState(item.backend, item.state.filePath, item.state.content);
		} catch (error) {
			const code = item.state.content === null ? "DELETE_FAILED" : "WRITE_FAILED";
			const applyFailure = failure(item.state, code, error);
			const compensationFailures = await compensateAttempted(attempted);
			logger.warn("Snapshot rollback failed and was compensated", {
				deviceId: item.state.deviceId,
				filePath: item.state.filePath,
				compensationFailureCount: compensationFailures.length,
			});
			return {
				...EMPTY_RESULT,
				failures: [applyFailure, ...compensationFailures],
			};
		}
	}

	const files = prepared.plan.map((item) => displayFile(item.state));
	const result = { reverted: files.length > 0, fileCount: files.length, files, failures: [] };
	if (prepared.plan.length > 0) compensationPlans.set(result, prepared.plan);
	return result;
}

async function applyRebuiltStates(
	narratorId: string,
	identities: DeviceFileIdentity[],
	excludeToolUseIds: Set<string>,
): Promise<RevertResult> {
	if (identities.length === 0) return EMPTY_RESULT;
	try {
		const states = await rebuildDeviceFileStatesExcluding(
			narratorId,
			identities,
			excludeToolUseIds,
		);
		return applyDeviceFileStates(narratorId, [...states.values()]);
	} catch (error) {
		const code = error instanceof FileHistoryError ? error.code : "PREPARE_FAILED";
		const identity = identities[0] ?? { deviceId: LOCAL_DEVICE_ID, filePath: "(unknown)" };
		return { ...EMPTY_RESULT, failures: [failure(identity, code, error)] };
	}
}

type RevertableToolCall = {
	toolUseId: string;
	toolName: string;
	inputJson: unknown;
	executionDeviceId: string | null;
	executionCwd: string | null;
	resolvedFilePath: string | null;
};

function rawToolPath(toolCall: RevertableToolCall): string {
	const input = toolCall.inputJson as Record<string, unknown> | null;
	return typeof input?.file_path === "string" ? input.file_path : "(unknown)";
}

async function revertToolCalls(
	narratorId: string,
	toolCalls: RevertableToolCall[],
	excludeToolUseIds: Set<string>,
): Promise<RevertResult> {
	const legacyLocalCwd = await resolveNarratorCwd(narratorId);
	let affectedFiles: DeviceFileIdentity[];
	try {
		affectedFiles = getAffectedDeviceFilesStrict(toolCalls, legacyLocalCwd);
	} catch (error) {
		const historyError = error instanceof FileHistoryError ? error : null;
		const toolCall = historyError?.toolUseId
			? toolCalls.find((candidate) => candidate.toolUseId === historyError.toolUseId)
			: toolCalls[0];
		const input = toolCall?.inputJson as Record<string, unknown> | null;
		const deviceId =
			toolCall?.executionDeviceId ??
			(typeof input?.device === "string" ? input.device : LOCAL_DEVICE_ID);
		return {
			...EMPTY_RESULT,
			failures: [
				{
					deviceId,
					filePath: toolCall ? rawToolPath(toolCall) : "(unknown)",
					code: historyError?.code ?? "PREPARE_FAILED",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
	return applyRebuiltStates(narratorId, affectedFiles, excludeToolUseIds);
}

export async function revertPatchesForMessages(
	narratorId: string,
	messageIds: string[],
): Promise<RevertResult> {
	if (messageIds.length === 0) return EMPTY_RESULT;
	const toolCalls = await db.query.narratorToolCalls.findMany({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			inArray(narratorToolCalls.messageId, messageIds),
			eq(narratorToolCalls.status, "success"),
		),
		columns: {
			toolUseId: true,
			toolName: true,
			inputJson: true,
			executionDeviceId: true,
			executionCwd: true,
			resolvedFilePath: true,
		},
	});
	const result = await revertToolCalls(
		narratorId,
		toolCalls,
		new Set(toolCalls.map((toolCall) => toolCall.toolUseId)),
	);
	logger.info("Auto-reverted file changes for deleted messages", {
		narratorId,
		messageCount: messageIds.length,
		fileCount: result.fileCount,
		failureCount: result.failures.length,
	});
	return result;
}

export async function revertPatchForToolUse(
	narratorId: string,
	toolUseId: string,
): Promise<RevertResult> {
	return revertPatchForToolUses(narratorId, [toolUseId]);
}

export async function revertPatchForToolUses(
	narratorId: string,
	toolUseIds: string[],
): Promise<RevertResult> {
	if (toolUseIds.length === 0) return EMPTY_RESULT;
	const toolCalls = await db.query.narratorToolCalls.findMany({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			inArray(narratorToolCalls.toolUseId, toolUseIds),
			eq(narratorToolCalls.status, "success"),
		),
		columns: {
			toolUseId: true,
			toolName: true,
			inputJson: true,
			executionDeviceId: true,
			executionCwd: true,
			resolvedFilePath: true,
		},
	});
	const result = await revertToolCalls(
		narratorId,
		toolCalls,
		new Set(toolCalls.map((toolCall) => toolCall.toolUseId)),
	);
	logger.info("Auto-reverted file changes for deleted blocks", {
		narratorId,
		toolUseIdCount: toolUseIds.length,
		fileCount: result.fileCount,
		failureCount: result.failures.length,
	});
	return result;
}

/** @deprecated compatibility context for routes that still require the local cwd. */
export async function resolveSnapshotContext(
	narratorId: string,
): Promise<{ scopeId: string; worktreePath: string } | null> {
	const cwd = await resolveNarratorCwd(narratorId);
	return cwd ? { scopeId: narratorId, worktreePath: cwd } : null;
}
