import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { backgroundTasks, narratorMessages, narrators, narratorToolCalls } from "../db/schema";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import { isSubagentVariant, parseSubstatus } from "../lib/narrator-utils";
import { narratorPersistence } from "./narrator-persistence";
import {
	isToolContinuationOwnerMounted,
	type ToolContinuationProtectionSets,
	toolContinuationService,
} from "./tool-continuation-service";
import {
	beginQuiescingTools,
	capturePlannedUpdateRecoverySnapshot,
	getUpdateCoordinationStatus,
	type PlannedUpdateRecoverySnapshot,
	scheduleUpdate,
} from "./update-coordinator";
import { restoreNarratorsAfterPlannedUpdate } from "./update-recovery-service";

export const NO_AUTO_RESUME_FLAG = "--no-auto-resume";
const MAX_TARGETS = 1_000;
const MAX_MANIFEST_BYTES = 256 * 1024;
export const RESTART_EXECUTION_UNKNOWN =
	"Interrupted by server restart. This tool started executing but its final result was not persisted. " +
	"The outcome is unknown and side effects may already have occurred. It was not automatically retried; " +
	"inspect the actual state before deciding whether to retry.";

interface RestartTarget {
	narratorId: string;
	logicalRunId: string | null;
}
interface RestartManifest {
	version: 1;
	snapshot: PlannedUpdateRecoverySnapshot;
	targets: RestartTarget[];
}
export interface RestartStartupRecovery {
	manifest: RestartManifest | null;
	protection: ToolContinuationProtectionSets;
}
const processState = hotSafe("restart-recovery", () => ({
	prepared: false,
	pausedRecovery: null as RestartStartupRecovery | null,
	permissionToolCalls: new Map<string, string>(),
}));
const manifestPath = () => getNarraforkPath("restart-recovery.json");

export function automaticResumeEnabled(args: readonly string[] = process.argv): boolean {
	return !args.includes(NO_AUTO_RESUME_FLAG);
}

export function restartEligible(row: { status: string; substatus: string | null }): boolean {
	const tags = parseSubstatus(row.substatus);
	return (
		(row.status === "working" || row.status === "waiting") &&
		!tags.some((tag) => ["taken_over", "manual_override", "cancelled", "error"].includes(tag))
	);
}

export function restartToolDisposition(row: {
	status: string;
	executionStartedAt: string | number | null;
	fileChangeOperationId: string | null;
}): "terminal" | "execution_unknown" | "permission" | "deferred" {
	if (row.status === "success" || row.status === "fail") return "terminal";
	if (row.executionStartedAt != null || row.fileChangeOperationId != null)
		return "execution_unknown";
	return row.status === "pending" ? "permission" : "deferred";
}

async function readManifest(): Promise<RestartManifest | null> {
	try {
		if ((await stat(manifestPath())).size > MAX_MANIFEST_BYTES)
			throw new Error("Restart recovery manifest exceeds size limit");
		const value: unknown = JSON.parse(await readFile(manifestPath(), "utf8"));
		if (!value || typeof value !== "object") throw new Error("Invalid restart manifest");
		const manifest = value as RestartManifest;
		if (
			manifest.version !== 1 ||
			!Array.isArray(manifest.targets) ||
			manifest.targets.length > MAX_TARGETS ||
			!manifest.snapshot?.updateEpoch?.startsWith("restart-") ||
			!Array.isArray(manifest.snapshot.narrators) ||
			manifest.snapshot.narrators.length > MAX_TARGETS ||
			!manifest.targets.every(
				(target) =>
					typeof target.narratorId === "string" &&
					(target.logicalRunId === null || typeof target.logicalRunId === "string"),
			)
		)
			throw new Error("Invalid restart recovery manifest");
		return manifest;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		// Keep malformed evidence, but do not let it authorize execution.
		logger.warn("Cannot read ordinary restart recovery manifest", { error: String(error) });
		return null;
	}
}

async function writeManifest(manifest: RestartManifest): Promise<void> {
	const text = JSON.stringify(manifest);
	if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error("Restart manifest too large");
	const path = manifestPath();
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, text, { mode: 0o600 });
	await rename(temporary, path);
}

async function removeManifest(epoch: string): Promise<void> {
	if ((await readManifest())?.snapshot.updateEpoch !== epoch) return;
	await unlink(manifestPath()).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

async function loadActiveRows() {
	const rows = await db.query.narrators.findMany({
		where: inArray(narrators.status, ["working", "waiting"]),
		columns: {
			id: true,
			status: true,
			substatus: true,
			variant: true,
			type: true,
			logicalRunId: true,
			parentNarratorId: true,
			originToolCallId: true,
		},
		limit: MAX_TARGETS + 1,
	});
	if (rows.length > MAX_TARGETS) throw new Error("Too many active restart recovery targets");
	return rows.filter(restartEligible);
}

async function loadRetainedRestartRows(previous: RestartManifest | null) {
	if (!previous?.targets.length) return [];
	const records = await toolContinuationService.listByEpoch(previous.snapshot.updateEpoch);
	const recordTargets = (record: (typeof records)[number]) => [
		record.narratorId,
		...(record.kind === "foreground_agent" && typeof record.payloadJson?.subagentId === "string"
			? [record.payloadJson.subagentId]
			: []),
	];
	const unfinishedOwners = new Set(
		records.filter((record) => !isToolContinuationOwnerMounted(record)).flatMap(recordTargets),
	);
	const cancelledOwners = new Set(
		records.filter((record) => record.state === "cancelled").flatMap(recordTargets),
	);
	const targets = new Map(previous.targets.map((target) => [target.narratorId, target]));
	const rows = await db.query.narrators.findMany({
		where: inArray(narrators.id, [...targets.keys()]),
		columns: {
			id: true,
			status: true,
			substatus: true,
			variant: true,
			type: true,
			logicalRunId: true,
			parentNarratorId: true,
			originToolCallId: true,
		},
		limit: MAX_TARGETS + 1,
	});
	return rows.filter((row) => {
		const tags = parseSubstatus(row.substatus);
		return (
			targets.get(row.id)?.logicalRunId === row.logicalRunId &&
			!tags.some((tag) => ["error", "taken_over", "manual_override", "cancelled"].includes(tag)) &&
			(restartEligible(row) ||
				(row.status === "idle" &&
					(unfinishedOwners.has(row.id) ||
						(tags.includes("interrupted") && !cancelledOwners.has(row.id)))))
		);
	});
}

/** Freeze tool/model admission before resource teardown; never wait for a tool to finish. */
export async function prepareSignalRestartRecovery(): Promise<void> {
	const coordination = getUpdateCoordinationStatus();
	// A scheduled update owns its own epoch and handoff authorization. Do not turn that
	// operation's live snapshot into ordinary-restart authorization during signal teardown.
	if (coordination.phase !== "idle" && coordination.operation === "update") return;
	if (coordination.phase === "idle") {
		scheduleUpdate(undefined, "system_shutdown");
		beginQuiescingTools();
	}
	const previous = await readManifest();
	const rows = await loadActiveRows();
	const retained = await loadRetainedRestartRows(previous);
	for (const row of retained) {
		if (!rows.some((active) => active.id === row.id)) rows.push(row);
	}
	if (rows.length > MAX_TARGETS) throw new Error("Too many restart recovery targets");
	const live = capturePlannedUpdateRecoverySnapshot();
	const snapshot: PlannedUpdateRecoverySnapshot = {
		version: 2,
		capturedAt: live.capturedAt,
		updateEpoch: retained.length
			? (previous?.snapshot.updateEpoch ?? `restart-${generateId()}`)
			: `restart-${generateId()}`,
		narrators: rows.flatMap((row) => {
			const target =
				live.narrators.find((entry) => entry.narratorId === row.id) ??
				(retained.some((entry) => entry.id === row.id)
					? previous?.snapshot.narrators.find((entry) => entry.narratorId === row.id)
					: undefined);
			return target ? [target] : [];
		}),
	};
	// The cold-start scanner adds actual parent owners; a signal snapshot is eligibility evidence,
	// not a standing instruction to resume every primary narrator on every boot.
	await writeManifest({
		version: 1,
		snapshot,
		targets: rows.map((row) => ({ narratorId: row.id, logicalRunId: row.logicalRunId })),
	});
}

export function mergeStartupProtection(
	...sets: ToolContinuationProtectionSets[]
): ToolContinuationProtectionSets {
	return {
		narratorIds: new Set(sets.flatMap((set) => [...set.narratorIds])),
		toolCallIds: new Set(sets.flatMap((set) => [...set.toolCallIds])),
		backgroundTaskIds: new Set(sets.flatMap((set) => [...set.backgroundTaskIds])),
	};
}

/** Runs under the database instance lock, before generic startup cleanup touches any rows. */
export async function prepareOrdinaryRestartRecovery(
	plannedProtection: ToolContinuationProtectionSets,
): Promise<RestartStartupRecovery> {
	const empty: RestartStartupRecovery = {
		manifest: null,
		protection: { narratorIds: new Set(), toolCallIds: new Set(), backgroundTaskIds: new Set() },
	};
	if (processState.prepared) return empty; // Hot reload must not mount duplicate runtimes.
	processState.prepared = true;
	const previous = await readManifest();
	const unfinishedOwners = new Set(
		previous
			? (await toolContinuationService.listByEpoch(previous.snapshot.updateEpoch))
					.filter(
						(record) => record.state !== "cancelled" && !isToolContinuationOwnerMounted(record),
					)
					.map((record) => record.narratorId)
			: [],
	);
	const active = await loadActiveRows();
	for (const row of await loadRetainedRestartRows(previous)) {
		if (!active.some((entry) => entry.id === row.id)) active.push(row);
	}
	if (active.length > MAX_TARGETS) throw new Error("Too many restart recovery targets");
	const rows = active.filter((row) => !plannedProtection.narratorIds.has(row.id));
	const children = rows.filter((row) => row.type === "subagent" || isSubagentVariant(row.variant));
	const selectedIds = new Set([
		...children.map((row) => row.id),
		...rows.filter((row) => unfinishedOwners.has(row.id)).map((row) => row.id),
	]);
	// A parent waiting for a foreground Agent is required to settle that Agent result once.
	for (const child of children) {
		let parent = rows.find((row) => row.id === child.parentNarratorId);
		while (parent && !selectedIds.has(parent.id)) {
			selectedIds.add(parent.id);
			parent = rows.find((row) => row.id === parent?.parentNarratorId);
		}
	}
	if (!selectedIds.size) {
		if (previous) await removeManifest(previous.snapshot.updateEpoch);
		return empty;
	}
	const selected = rows.filter((row) => selectedIds.has(row.id));
	const snapshot: PlannedUpdateRecoverySnapshot = {
		version: 2,
		updateEpoch: previous?.snapshot.updateEpoch ?? `restart-${generateId()}`,
		capturedAt: previous?.snapshot.capturedAt ?? new Date().toISOString(),
		narrators: selected.map(
			(row) =>
				previous?.snapshot.narrators.find((target) => target.narratorId === row.id) ?? {
					narratorId: row.id,
					locale: "en",
				},
		),
	};
	const manifest: RestartManifest = {
		version: 1,
		snapshot,
		targets: selected.map((row) => ({ narratorId: row.id, logicalRunId: row.logicalRunId })),
	};
	// Write eligibility before repairing tools. A crash between writes can safely repeat repair.
	await writeManifest(manifest);
	const { cleanupIncompleteNarratorOutput } = await import("./narrator-output-recovery");
	for (const row of selected) await cleanupIncompleteNarratorOutput(row.id);
	const protection = empty.protection;
	for (const id of selectedIds) protection.narratorIds.add(id);

	const representedChildren = new Set<string>();
	for (const child of children) {
		const legacyOrigin =
			!child.originToolCallId && child.parentNarratorId
				? await db.query.narratorMessages.findFirst({
						where: and(
							eq(narratorMessages.narratorId, child.id),
							isNotNull(narratorMessages.parentToolUseId),
						),
						columns: { parentToolUseId: true },
						orderBy: [asc(narratorMessages.createdAt)],
					})
				: null;
		if (!child.originToolCallId && !legacyOrigin?.parentToolUseId) continue;
		const call = await db.query.narratorToolCalls.findFirst({
			where: child.originToolCallId
				? eq(narratorToolCalls.id, child.originToolCallId)
				: and(
						eq(narratorToolCalls.narratorId, child.parentNarratorId as string),
						eq(narratorToolCalls.toolUseId, legacyOrigin?.parentToolUseId as string),
					),
			columns: { id: true, narratorId: true, status: true },
		});
		if (!call || plannedProtection.toolCallIds.has(call.id)) continue;
		const task = await db.query.backgroundTasks.findFirst({
			where: and(
				eq(backgroundTasks.type, "agent"),
				or(eq(backgroundTasks.subagentNarratorId, child.id), eq(backgroundTasks.id, child.id)),
			),
			columns: { id: true, alias: true, status: true },
		});
		const background = task?.status === "running";
		// A historical Agent result is not the owner of a later follow-up run.
		if (!background && (call.status === "success" || call.status === "fail")) continue;
		if (!background && !selectedIds.has(call.narratorId)) continue;
		if (background && task) protection.backgroundTaskIds.add(task.id);
		await putColdContinuation({
			toolCallId: call.id,
			narratorId: call.narratorId,
			updateEpoch: snapshot.updateEpoch,
			kind: background ? "background_agent" : "foreground_agent",
			payloadJson: {
				subagentId: child.id,
				logicalRunId: child.logicalRunId,
				ordinaryRestart: true,
				...(background && task
					? {
							backgroundTaskId: task.id,
							backgroundTaskAlias: task.alias,
							parentNarratorId: call.narratorId,
						}
					: {}),
			},
		});
		protection.toolCallIds.add(call.id);
		representedChildren.add(child.id);
	}
	for (const row of selected) {
		const calls = await db.query.narratorToolCalls.findMany({
			where: and(
				eq(narratorToolCalls.narratorId, row.id),
				isNull(narratorToolCalls.executionOriginToolCallId),
				eq(narratorToolCalls.executionIdentityVersion, 1),
				inArray(narratorToolCalls.status, ["initializing", "pending", "running"]),
			),
			columns: {
				id: true,
				toolUseId: true,
				messageId: true,
				status: true,
				executionStartedAt: true,
				fileChangeOperationId: true,
				permissionSuggestions: true,
			},
			limit: 1_001,
		});
		if (calls.length > 1_000) throw new Error("Too many interrupted tools for one narrator");
		for (const call of calls) {
			if (protection.toolCallIds.has(call.id) || plannedProtection.toolCallIds.has(call.id))
				continue;
			const disposition = restartToolDisposition(call);
			if (disposition === "execution_unknown") {
				await narratorPersistence.updateToolCallResultIfActive(
					call.toolUseId,
					{
						status: "fail",
						output: RESTART_EXECUTION_UNKNOWN,
						errorMessage: RESTART_EXECUTION_UNKNOWN,
						completedAt: Date.now(),
					},
					call.messageId,
					call.id,
				);
				continue;
			}
			if (!automaticResumeEnabled() && Array.isArray(call.permissionSuggestions)) {
				for (const suggestion of call.permissionSuggestions) {
					if (
						suggestion &&
						typeof suggestion === "object" &&
						"requestId" in suggestion &&
						typeof suggestion.requestId === "string"
					) {
						processState.permissionToolCalls.set(suggestion.requestId, call.id);
					}
				}
			}
			await putColdContinuation({
				toolCallId: call.id,
				narratorId: row.id,
				updateEpoch: snapshot.updateEpoch,
				kind: disposition === "permission" ? "pending_permission" : "deferred_tool",
				state: disposition === "permission" ? "waiting" : "paused",
				payloadJson: {
					permissionMode: "normal",
					ordinaryRestart: true,
					preservePendingPermission: disposition === "permission",
				},
			});
			protection.toolCallIds.add(call.id);
		}
	}
	const queuedOwners = new Set(
		(await toolContinuationService.listByEpoch(snapshot.updateEpoch))
			.filter((record) => record.state !== "cancelled" && !isToolContinuationOwnerMounted(record))
			.map((record) => record.narratorId),
	);
	for (const row of selected) {
		if (row.type !== "subagent" && !isSubagentVariant(row.variant) && !queuedOwners.has(row.id)) {
			protection.narratorIds.delete(row.id);
		}
	}
	// Represented children are driven by Agent continuations; standalone children mount independently.
	logger.info("Prepared ordinary restart recovery", {
		targetCount: selected.length,
		agentCount: representedChildren.size,
		toolCount: protection.toolCallIds.size,
		automaticResume: automaticResumeEnabled(),
	});
	const prepared = { manifest, protection };
	if (!automaticResumeEnabled()) {
		processState.pausedRecovery = prepared;
		// A disabled recovery has no runtime owner: show an honest interrupted/resting state,
		// while keeping permission/tool records protected and available for a manual resume.
		return { manifest, protection: { ...protection, narratorIds: new Set<string>() } };
	}
	return prepared;
}

async function putColdContinuation(input: Parameters<typeof toolContinuationService.upsert>[0]) {
	const previous = await toolContinuationService.getByToolCallId(input.toolCallId);
	// The old process is gone (instance lock acquired). A permission wait without a tool start is
	// safe to remount; never replay a real execution. Preserve durable owner-result phases.
	if (previous?.updateEpoch === input.updateEpoch && previous.state === "completed") {
		if (input.kind !== "foreground_agent" && input.kind !== "background_agent") return;
	}
	if (previous?.state === "resuming") {
		const { narratorToolContinuations } = await import("../db/schema");
		await db
			.update(narratorToolContinuations)
			.set({
				state: "paused",
				claimToken: null,
				claimedAt: null,
				deadlineAt: null,
			})
			.where(eq(narratorToolContinuations.id, previous.id));
	}
	await toolContinuationService.upsert(input);
}

export async function restoreOrdinaryRestartRecovery(
	prepared: RestartStartupRecovery,
	options: { manual?: boolean; includedNarratorIds?: ReadonlySet<string> } = {},
) {
	if (!prepared.manifest || (!options.manual && !automaticResumeEnabled())) return null;
	const { manifest, protection } = prepared;
	const records = (await toolContinuationService.listByEpoch(manifest.snapshot.updateEpoch)).filter(
		(record) =>
			record.state !== "cancelled" &&
			!isToolContinuationOwnerMounted(record) &&
			(!options.includedNarratorIds || options.includedNarratorIds.has(record.narratorId)),
	);
	const driven = new Set(
		records.flatMap((record) => [
			record.narratorId,
			...(typeof record.payloadJson?.subagentId === "string"
				? [record.payloadJson.subagentId]
				: []),
		]),
	);
	// Independent streaming-only children must not wait behind another child's human approval.
	const { resumeSubagent } = await import("./subagent-resume");
	for (const target of manifest.targets) {
		if (
			driven.has(target.narratorId) ||
			(options.includedNarratorIds && !options.includedNarratorIds.has(target.narratorId))
		)
			continue;
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, target.narratorId),
			columns: {
				id: true,
				variant: true,
				type: true,
				logicalRunId: true,
				status: true,
				substatus: true,
			},
		});
		if (
			!row ||
			row.logicalRunId !== target.logicalRunId ||
			!(row.type === "subagent" || isSubagentVariant(row.variant)) ||
			!(
				restartEligible(row) ||
				(row.status === "idle" && parseSubstatus(row.substatus).includes("interrupted"))
			)
		)
			continue;
		try {
			await resumeSubagent({
				subagentId: row.id,
				intent: "continue_tool_results",
				actor: "parent_agent",
				locale: "en",
				resumeLogicalRunId: row.logicalRunId ?? undefined,
				allowRunningRestart: true,
				skipStaleAttach: true,
				skipConclusionDelivery: true,
			});
		} catch (error) {
			logger.error("Could not resume interrupted standalone subagent", {
				narratorId: row.id,
				error: String(error),
			});
			const { narratorService } = await import("./narrator-service");
			await narratorService.updateStatus(row.id, "idle", {
				substatus: ["error"],
				errorMessage: String(error),
			});
		}
	}
	return restoreNarratorsAfterPlannedUpdate(
		{ snapshot: manifest.snapshot, protection },
		{
			includedNarratorIds: options.includedNarratorIds,
			onQueueCompleted: async () => {
				if (!options.includedNarratorIds) {
					await removeManifest(manifest.snapshot.updateEpoch);
					return;
				}
				const latest = await readManifest();
				if (latest?.snapshot.updateEpoch !== manifest.snapshot.updateEpoch) return;
				latest.targets = latest.targets.filter(
					(target) => !options.includedNarratorIds?.has(target.narratorId),
				);
				latest.snapshot.narrators = latest.snapshot.narrators.filter(
					(target) => !options.includedNarratorIds?.has(target.narratorId),
				);
				if (latest.targets.length) await writeManifest(latest);
				else await removeManifest(manifest.snapshot.updateEpoch);
			},
		},
	);
}

/** Explicit Continue bypasses only the startup flag, and only for this narrator's subtree. */
export async function manuallyResumeRestartRecovery(narratorId: string): Promise<boolean> {
	const prepared = processState.pausedRecovery;
	if (!prepared?.manifest?.targets.some((target) => target.narratorId === narratorId)) return false;
	const ids = new Set([narratorId]);
	const rows = await db.query.narrators.findMany({
		where: inArray(
			narrators.id,
			prepared.manifest.targets.map((target) => target.narratorId),
		),
		columns: { id: true, parentNarratorId: true },
		limit: MAX_TARGETS + 1,
	});
	for (let changed = true; changed; ) {
		changed = false;
		for (const row of rows) {
			if (row.parentNarratorId && ids.has(row.parentNarratorId) && !ids.has(row.id)) {
				ids.add(row.id);
				changed = true;
			}
		}
	}
	const handle = await restoreOrdinaryRestartRecovery(prepared, {
		manual: true,
		includedNarratorIds: ids,
	});
	if (!handle) return false;
	processState.pausedRecovery = {
		...prepared,
		manifest: {
			...prepared.manifest,
			targets: prepared.manifest.targets.filter((target) => !ids.has(target.narratorId)),
		},
	};
	void handle.completion.catch((error) =>
		logger.error("Manual restart recovery failed", { narratorId, error: String(error) }),
	);
	return true;
}

export function pausedRestartToolCallForRequest(requestId: string): string {
	return processState.permissionToolCalls.get(requestId) ?? requestId;
}

/** Tests simulate a fresh process without touching the running server or its data directory. */
export function resetRestartRecoveryForTests(): void {
	if (process.env.NODE_ENV !== "test") throw new Error("Restart recovery reset is test-only");
	processState.prepared = false;
	processState.pausedRecovery = null;
	processState.permissionToolCalls.clear();
}
