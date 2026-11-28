import { closeSync, openSync, readSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseReplyContext, type ReplyContext } from "@shared/reply-context";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { backgroundTasks, narrators, narratorToolCalls } from "../db/schema";
import { type ReadQueryOptions, readQuery, readQueryFirst } from "../db/worker-read";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import { parseSubstatus } from "../lib/narrator-utils";
import type { Locale } from "../lib/prompt-i18n";
import { runDeliverToOf } from "../lib/runtime-source";
import type { RunDeliverTo } from "../lib/validators/runtime-registration";
import { RuntimeReadConflictError } from "./agent-runtime/read-conflict";
import { runAtomicWrite } from "./agent-runtime/runtime-write";
import { narratorPersistence } from "./narrator-persistence";
import {
	getRecoverySource,
	getRegisteredRecoverySource,
	type RecoverySource,
	registerRecoverySource,
	withRecoveryAdvance,
} from "./recovery-handoff";
import {
	assertRestartRecoveryObservation,
	RESTART_NARRATOR_COLUMNS,
	RESTART_TASK_COLUMNS,
	RESTART_TOOL_COLUMNS,
	type RestartNarrator,
	type RestartTool,
} from "./recovery-observation";
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
type RecoveryReadOptions = Pick<ReadQueryOptions, "signal" | "deadlineAt" | "timeoutMs">;
function narratorObservation(row: RestartNarrator): RestartNarrator {
	return {
		id: row.id,
		status: row.status,
		substatus: row.substatus,
		logicalRunId: row.logicalRunId,
		runtimeRegistrationJson: row.runtimeRegistrationJson,
	};
}

async function readRestartCalls(
	ids: string[],
	options: RecoveryReadOptions,
): Promise<RestartTool[]> {
	const calls: RestartTool[] = [];
	for (let start = 0; start < ids.length; start += 100) {
		const owners = ids.slice(start, start + 100);
		for (let after = ""; ; ) {
			const page = await readQuery(
				db
					.select(RESTART_TOOL_COLUMNS)
					.from(narratorToolCalls)
					.where(
						and(
							inArray(narratorToolCalls.narratorId, owners),
							gt(narratorToolCalls.id, after),
							isNull(narratorToolCalls.executionOriginToolCallId),
							eq(narratorToolCalls.executionIdentityVersion, 1),
							inArray(narratorToolCalls.status, ["initializing", "pending", "running"]),
						),
					)
					.orderBy(asc(narratorToolCalls.id))
					.limit(100),
				{ ...options, executionPolicy: "worker-required", maxRows: 100 },
			);
			calls.push(...page);
			if (calls.length > 10_000) throw new Error("Too many interrupted tools");
			if (page.length < 100) break;
			after = page[page.length - 1].id;
		}
	}
	return calls;
}

async function readDestinationCalls(destinations: RunDeliverTo[], options: RecoveryReadOptions) {
	const calls: RestartTool[] = [];
	for (let start = 0; start < destinations.length; start += 100) {
		const page = await readQuery(
			db
				.select(RESTART_TOOL_COLUMNS)
				.from(narratorToolCalls)
				.where(
					or(
						...destinations
							.slice(start, start + 100)
							.map((target) =>
								target.toolCallId
									? eq(narratorToolCalls.id, target.toolCallId)
									: and(
											eq(narratorToolCalls.narratorId, target.narratorId),
											eq(narratorToolCalls.toolUseId, target.toolUseId),
										),
							),
					),
				)
				.limit(MAX_TARGETS + 1),
			{ ...options, executionPolicy: "worker-required", maxRows: MAX_TARGETS + 1 },
		);
		if (page.length > MAX_TARGETS) throw new Error("Too many restart destination calls");
		calls.push(...page);
	}
	return calls;
}

function destinationCall(calls: RestartTool[], target: RunDeliverTo) {
	return calls.find((call) =>
		target.toolCallId
			? call.id === target.toolCallId
			: call.narratorId === target.narratorId && call.toolUseId === target.toolUseId,
	);
}
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
	/** This cold-start pass only; never persisted or reused for a later explicit hydration. */
	heldRunIds?: ReadonlySet<string>;
}
const processState = hotSafe("restart-recovery", () => ({
	prepared: false,
	pausedRecovery: null as RestartStartupRecovery | null,
	permissionToolCalls: new Map<string, string>(),
}));
const manifestPath = () => getNarraforkPath("restart-recovery.json");
const manifestIdentities = hotSafe(
	"restart-recovery-identities",
	() => new Map<string, { text: string }>(),
);

function readBoundedManifestText(): string {
	const fd = openSync(manifestPath(), "r");
	try {
		const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
		}
		if (length > MAX_MANIFEST_BYTES)
			throw new Error("Restart recovery manifest exceeds size limit");
		return buffer.toString("utf8", 0, length);
	} finally {
		closeSync(fd);
	}
}

function assertManifestIdentity(epoch: string): void {
	const expected = manifestIdentities.get(epoch);
	if (expected && readBoundedManifestText() !== expected.text) {
		throw new Error("Ordinary recovery manifest changed after it was claimed");
	}
}

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
		const value: unknown = JSON.parse(readBoundedManifestText());
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
		throw error;
	}
}

async function writeManifest(manifest: RestartManifest): Promise<void> {
	assertManifestIdentity(manifest.snapshot.updateEpoch);
	const text = JSON.stringify(manifest);
	if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error("Restart manifest too large");
	const path = manifestPath();
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, text, { mode: 0o600 });
	await rename(temporary, path);
	const identity = manifestIdentities.get(manifest.snapshot.updateEpoch);
	if (identity) identity.text = text;
}

async function removeManifest(epoch: string): Promise<void> {
	assertManifestIdentity(epoch);
	if ((await readManifest())?.snapshot.updateEpoch !== epoch) return;
	await unlink(manifestPath()).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	manifestIdentities.delete(epoch);
}

/**
 * Where the row's current run delivers its result, if anywhere: the one rule for
 * "this session is delegated" (`runDeliverToOf`), never its type or variant.
 */
async function withDeliverTo<T extends { id: string }>(
	rows: T[],
	options: RecoveryReadOptions = {},
): Promise<Array<T & { deliverTo?: RunDeliverTo }>> {
	if (!rows.length) return [];
	const registrations = await readQuery(
		db.query.narrators.findMany({
			where: inArray(
				narrators.id,
				rows.map((row) => row.id),
			),
			columns: { id: true, runtimeRegistrationJson: true },
			limit: MAX_TARGETS + 1,
		}),
		{ ...options, executionPolicy: "worker-required", maxRows: MAX_TARGETS + 1 },
	);
	const byId = new Map(registrations.map((row) => [row.id, runDeliverToOf(row)]));
	return rows.map((row) => ({ ...row, deliverTo: byId.get(row.id) }));
}

async function loadActiveRows(
	includeTerminalCandidates = false,
	options: RecoveryReadOptions = {},
) {
	const rows = await readQuery(
		db.query.narrators.findMany({
			where: inArray(narrators.status, ["working", "waiting"]),
			columns: RESTART_NARRATOR_COLUMNS,
			limit: MAX_TARGETS + 1,
		}),
		{ ...options, executionPolicy: "worker-required", maxRows: MAX_TARGETS + 1 },
	);
	if (rows.length > MAX_TARGETS) throw new Error("Too many active restart recovery targets");
	return includeTerminalCandidates ? rows : rows.filter(restartEligible);
}

async function loadRetainedRestartRows(
	previous: RestartManifest | null,
	options: RecoveryReadOptions = {},
) {
	if (!previous?.targets.length) return [];
	const records = await toolContinuationService.listByEpoch(previous.snapshot.updateEpoch, options);
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
	const rows = await readQuery(
		db.query.narrators.findMany({
			where: inArray(narrators.id, [...targets.keys()]),
			columns: RESTART_NARRATOR_COLUMNS,
			limit: MAX_TARGETS + 1,
		}),
		{ ...options, executionPolicy: "worker-required", maxRows: MAX_TARGETS + 1 },
	);
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
export async function prepareSignalRestartRecovery(
	options: RecoveryReadOptions = {},
): Promise<void> {
	const coordination = getUpdateCoordinationStatus();
	// A scheduled update owns its own epoch and handoff authorization. Do not turn that
	// operation's live snapshot into ordinary-restart authorization during signal teardown.
	if (coordination.phase !== "idle" && coordination.operation === "update") return;
	if (coordination.phase === "idle") {
		scheduleUpdate(undefined, "system_shutdown");
		beginQuiescingTools();
	}
	const previous = await readManifest();
	const rows = await loadActiveRows(false, options);
	const retained = await loadRetainedRestartRows(previous, options);
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

/** A restored user hold protects facts, not permission to automatically execute them. */
export async function protectHeldRunFacts(
	protection: ToolContinuationProtectionSets,
	hydratedRunIds?: ReadonlySet<string>,
	options: RecoveryReadOptions = {},
): Promise<Set<string>> {
	// Share only the snapshot explicitly passed by this cold-start orchestration. A later
	// standalone caller must still read current durable holds, including newly taken-over runs.
	const held = hydratedRunIds
		? new Set(hydratedRunIds)
		: await import("./agent-runtime/run").then(({ hydrateRunHolds }) => hydrateRunHolds(options));
	if (held.size > MAX_TARGETS) throw new Error("Too many held restart targets");
	const destinations = (
		await withDeliverTo(
			[...held].map((id) => ({ id })),
			options,
		)
	).flatMap((row) => (row.deliverTo ? [row.deliverTo] : []));
	for (const id of held) protection.narratorIds.add(id);
	const ids = [...held];
	for (let start = 0; start < ids.length; start += 100) {
		const owners = ids.slice(start, start + 100);
		for (let after = ""; ; ) {
			const calls = await readQuery(
				db
					.select({ id: narratorToolCalls.id })
					.from(narratorToolCalls)
					.where(
						and(
							inArray(narratorToolCalls.narratorId, owners),
							gt(narratorToolCalls.id, after),
							inArray(narratorToolCalls.status, ["initializing", "pending", "running"]),
						),
					)
					.orderBy(asc(narratorToolCalls.id))
					.limit(100),
				{ ...options, executionPolicy: "worker-required", maxRows: 100 },
			);
			for (const call of calls) protection.toolCallIds.add(call.id);
			if (calls.length < 100) break;
			after = calls[calls.length - 1].id;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		for (let after = ""; ; ) {
			const tasks = await readQuery(
				db
					.select({ id: backgroundTasks.id })
					.from(backgroundTasks)
					.where(
						and(
							gt(backgroundTasks.id, after),
							eq(backgroundTasks.status, "running"),
							or(
								inArray(backgroundTasks.subagentNarratorId, owners),
								inArray(backgroundTasks.id, owners),
								inArray(backgroundTasks.parentNarratorId, owners),
							),
						),
					)
					.orderBy(asc(backgroundTasks.id))
					.limit(100),
				{ ...options, executionPolicy: "worker-required", maxRows: 100 },
			);
			for (const task of tasks) protection.backgroundTaskIds.add(task.id);
			if (tasks.length < 100) break;
			after = tasks[tasks.length - 1].id;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	for (const call of await readDestinationCalls(destinations, options))
		protection.toolCallIds.add(call.id);
	return held;
}

/** Runs under the database instance lock, before generic startup cleanup touches any rows. */
export async function prepareOrdinaryRestartRecovery(
	plannedProtection: ToolContinuationProtectionSets,
	options: RecoveryReadOptions & { onTargetsDiscovered?: (ids: readonly string[]) => void } = {},
): Promise<RestartStartupRecovery> {
	const empty: RestartStartupRecovery = {
		manifest: null,
		protection: { narratorIds: new Set(), toolCallIds: new Set(), backgroundTaskIds: new Set() },
	};
	if (processState.prepared) return empty; // Hot reload must not mount duplicate runtimes.
	processState.prepared = true;
	try {
		const held = await protectHeldRunFacts(empty.protection, undefined, options);
		empty.heldRunIds = held;
		const saved = await readManifest();
		// A v3 planned root already owns this source; never load the ordinary file a second time.
		const previous = saved && !getRecoverySource(saved.snapshot.updateEpoch) ? saved : null;
		// Publish only the validated, unclaimed ordinary source before bounded continuation reads.
		if (previous)
			options.onTargetsDiscovered?.(previous.targets.map((target) => target.narratorId));
		const unfinishedOwners = new Set(
			previous
				? (await toolContinuationService.listByEpoch(previous.snapshot.updateEpoch, options))
						.filter(
							(record) => record.state !== "cancelled" && !isToolContinuationOwnerMounted(record),
						)
						.map((record) => record.narratorId)
				: [],
		);
		const active = await loadActiveRows(true, options);
		for (const row of await loadRetainedRestartRows(previous, options)) {
			if (!active.some((entry) => entry.id === row.id)) active.push(row);
		}
		if (active.length > MAX_TARGETS) throw new Error("Too many restart recovery targets");
		const candidates = [] as Awaited<ReturnType<typeof withDeliverTo<(typeof active)[number]>>>;
		const origins = new Map(
			(
				await toolContinuationService.getByToolCallIds(
					active.flatMap((row) => {
						const id = runDeliverToOf(row)?.toolCallId;
						return id ? [id] : [];
					}),
					options,
				)
			).map((record) => [record.toolCallId, record]),
		);
		for (const row of active
			.filter((row) => !plannedProtection.narratorIds.has(row.id) && !held.has(row.id))
			.map((row) => ({ ...row, deliverTo: runDeliverToOf(row) }))) {
			const origin = row.deliverTo?.toolCallId ? origins.get(row.deliverTo.toolCallId) : null;
			// A dead process can leave an active status behind after a durable cancellation/delivery.
			// It is not new ordinary authorization for that same delivering run.
			if (
				origin &&
				isToolContinuationOwnerMounted(origin) &&
				(origin.state === "cancelled" || origin.kind !== "background_agent") &&
				origin.payloadJson?.subagentId === row.id &&
				origin.payloadJson?.logicalRunId === row.logicalRunId
			)
				continue;
			candidates.push(row);
		}
		const { getRuntimePublicationService } = await import("./agent-runtime/publication");
		const publication = getRuntimePublicationService();
		const publicationRuns = candidates.flatMap((row) =>
			row.logicalRunId && row.deliverTo
				? [
						{
							producerKind: "agent" as const,
							taskId: row.id,
							logicalRunId: row.logicalRunId,
							recipientId: row.deliverTo.narratorId,
						},
					]
				: [],
		);
		const publicationStates = new Map(
			(await publication.readRunPublicationStates(publicationRuns, options)).map((state, index) => [
				publicationRuns[index].taskId,
				state,
			]),
		);
		const initialDestinationCalls = await readDestinationCalls(
			candidates.flatMap((row) => (row.deliverTo ? [row.deliverTo] : [])),
			options,
		);
		const rows: typeof candidates = [];
		for (const row of candidates) {
			const run =
				row.logicalRunId && row.deliverTo
					? {
							producerKind: "agent" as const,
							taskId: row.id,
							logicalRunId: row.logicalRunId,
							recipientId: row.deliverTo.narratorId,
						}
					: null;
			const publicationState = publicationStates.get(row.id) ?? { state: "none" as const };
			if (publicationState.state !== "settled") {
				// Idle rows entered this set only through the verified retained manifest.
				if (restartEligible(row) || row.status === "idle") rows.push(row);
				continue;
			}
			const result = run
				? await publication.readAgentTerminalResult(run, { includeEventKind: true }, options)
				: null;
			// A crash after the terminal transaction but before idle needs delivery only.
			// The durable terminal evidence is authoritative; never execute the model again,
			// even when the result snapshot itself can no longer be read.
			const eventKind = result?.eventKind ?? publicationState.eventKind;
			const settled = runAtomicWrite(db, "restart.settledNarrator", (tx) => {
				assertRestartRecoveryObservation(tx, { narrator: narratorObservation(row) });
				return tx
					.update(narrators)
					.set({
						status: "idle",
						substatus: JSON.stringify([
							!eventKind
								? "interrupted"
								: eventKind === "failed"
									? "error"
									: eventKind === "timed_out"
										? "timeout"
										: eventKind === "cancelled"
											? "interrupted"
											: "unread",
						]),
						...(!result
							? {
									errorMessage:
										"Run had already published its terminal result before restart; the stored result is no longer readable, so it was not rerun.",
								}
							: {}),
					})
					.where(eq(narrators.id, row.id))
					.returning()
					.get();
			});
			if (!settled) throw new RuntimeReadConflictError();
			Object.assign(row, { status: settled.status, substatus: settled.substatus });
			publication.schedule();
			// A foreground caller may have crashed before saving its tool result. Preserve
			// its continuation; run.ts observes this committed snapshot before any model pass.
			if (row.deliverTo?.toolCallId) {
				const call = destinationCall(initialDestinationCalls, row.deliverTo);
				if (call && call.status !== "success" && call.status !== "fail") rows.push(row);
			}
		}
		// A live loop recorded at shutdown also authorizes its own unchanged run, even
		// when it delivers to nobody. Historical active rows (or rows without a run ID) do not.
		const recordedRuns = new Map(
			previous?.targets
				.filter(
					(target) =>
						target.logicalRunId &&
						previous.snapshot.narrators.some((entry) => entry.narratorId === target.narratorId),
				)
				.map((target) => [target.narratorId, target.logicalRunId]),
		);
		const explicitIds = new Set(
			rows
				.filter((row) => row.logicalRunId && recordedRuns.get(row.id) === row.logicalRunId)
				.map((row) => row.id),
		);
		// A run that delivers its result is resumed; the session it delivers to (and so on
		// up) is selected too, because it waits for that result exactly once.
		const delegated = rows.filter((row) => row.deliverTo);
		const selectedIds = new Set([
			...explicitIds,
			...delegated.map((row) => row.id),
			...rows.filter((row) => unfinishedOwners.has(row.id)).map((row) => row.id),
		]);
		for (const row of delegated) {
			let caller = rows.find((entry) => entry.id === row.deliverTo?.narratorId);
			while (caller && !selectedIds.has(caller.id)) {
				selectedIds.add(caller.id);
				caller = rows.find((entry) => entry.id === caller?.deliverTo?.narratorId);
			}
		}
		if (!selectedIds.size) {
			if (previous) await removeManifest(previous.snapshot.updateEpoch);
			return empty;
		}
		const selected = rows.filter((row) => selectedIds.has(row.id));
		// If manifest publication or any repair fails, startup can still settle these known runs.
		options.onTargetsDiscovered?.(selected.map((row) => row.id));
		const snapshot: PlannedUpdateRecoverySnapshot = {
			version: 2,
			updateEpoch: previous?.snapshot.updateEpoch ?? `restart-${generateId()}`,
			capturedAt: previous?.snapshot.capturedAt ?? new Date().toISOString(),
			narrators: selected.flatMap((row) => {
				const saved = previous?.targets.some(
					(target) => target.narratorId === row.id && target.logicalRunId === row.logicalRunId,
				)
					? previous.snapshot.narrators.find((target) => target.narratorId === row.id)
					: undefined;
				// Caller discovery is not evidence that its independent loop was live. Keep
				// its continuation, but do not manufacture standalone restart authorization.
				return saved ? [saved] : row.deliverTo ? [{ narratorId: row.id, locale: "en" }] : [];
			}),
		};
		const manifest: RestartManifest = {
			version: 1,
			snapshot,
			targets: selected.map((row) => ({ narratorId: row.id, logicalRunId: row.logicalRunId })),
		};
		// Write eligibility before repairing tools. A crash between writes can safely repeat repair.
		await writeManifest(manifest);
		manifestIdentities.set(snapshot.updateEpoch, { text: JSON.stringify(manifest) });
		registerRecoverySource(
			{
				updateEpoch: snapshot.updateEpoch,
				kind: "ordinary",
				capturedAt: snapshot.capturedAt,
				narrators: selected.map(
					(row) =>
						snapshot.narrators.find((target) => target.narratorId === row.id) ?? {
							narratorId: row.id,
							locale: "en",
						},
				),
				pendingNarratorIds: manifest.targets.map((target) => target.narratorId),
				logicalRuns: manifest.targets,
			},
			{ validateManifest: () => assertManifestIdentity(snapshot.updateEpoch) },
		);
		const { cleanupIncompleteNarratorOutput } = await import("./narrator-output-recovery");
		for (const row of selected) await cleanupIncompleteNarratorOutput(row.id);
		const protection = empty.protection;
		for (const id of selectedIds) protection.narratorIds.add(id);

		const destinationCalls = await readDestinationCalls(
			delegated.map((child) => child.deliverTo as RunDeliverTo),
			options,
		);
		const delegatedTasks = delegated.length
			? await readQuery(
					db
						.select(RESTART_TASK_COLUMNS)
						.from(backgroundTasks)
						.where(
							and(
								eq(backgroundTasks.type, "agent"),
								or(
									inArray(
										backgroundTasks.id,
										delegated.map((row) => row.id),
									),
									inArray(
										backgroundTasks.subagentNarratorId,
										delegated.map((row) => row.id),
									),
								),
							),
						)
						.limit(MAX_TARGETS + 1),
					{ ...options, executionPolicy: "worker-required", maxRows: MAX_TARGETS + 1 },
				)
			: [];
		if (delegatedTasks.length > MAX_TARGETS) throw new Error("Too many delegated restart tasks");
		const interruptedCalls = await readRestartCalls(
			selected.map((row) => row.id),
			options,
		);
		const continuations = new Map(
			(
				await toolContinuationService.getByToolCallIds(
					[...destinationCalls, ...interruptedCalls].map((call) => call.id),
					options,
				)
			).map((record) => [record.toolCallId, record]),
		);
		const representedChildren = new Set<string>();
		for (const child of delegated) {
			const deliverTo = child.deliverTo as RunDeliverTo;
			const call = destinationCall(destinationCalls, deliverTo);
			if (!call || plannedProtection.toolCallIds.has(call.id)) continue;
			const tasks = delegatedTasks.filter(
				(task) => task.id === child.id || task.subagentNarratorId === child.id,
			);
			if (tasks.length > 1) throw new RuntimeReadConflictError();
			const task = tasks[0];
			const background = task?.status === "running";
			// A historical Agent result is not the owner of a later follow-up run.
			if (!background && (call.status === "success" || call.status === "fail")) continue;
			if (!background && !selectedIds.has(call.narratorId)) continue;
			if (background && task) protection.backgroundTaskIds.add(task.id);
			await putColdContinuation(
				{
					recoveryObservation: {
						narrator: narratorObservation(child),
						tool: call,
						task: task ?? null,
					},
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
				},
				continuations.get(call.id) ?? null,
				options,
			);
			protection.toolCallIds.add(call.id);
			representedChildren.add(child.id);
		}
		for (const row of selected) {
			const calls = interruptedCalls.filter((call) => call.narratorId === row.id);
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
						{ narrator: narratorObservation(row), tool: call },
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
				await putColdContinuation(
					{
						recoveryObservation: { narrator: narratorObservation(row), tool: call },
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
					},
					continuations.get(call.id) ?? null,
					options,
				);
				protection.toolCallIds.add(call.id);
			}
		}
		const queuedOwners = new Set(
			(await toolContinuationService.listByEpoch(snapshot.updateEpoch, options))
				.filter((record) => record.state !== "cancelled" && !isToolContinuationOwnerMounted(record))
				.map((record) => record.narratorId),
		);
		for (const row of selected) {
			if (!row.deliverTo && !queuedOwners.has(row.id) && !explicitIds.has(row.id)) {
				protection.narratorIds.delete(row.id);
			}
		}
		// Ancestors discovered through a historical/finished Agent call have no loop to
		// mount. Keep their run facts for tool adoption, but not as pending standalone work.
		const source = getRegisteredRecoverySource(snapshot.updateEpoch);
		if (source)
			registerRecoverySource(source).update({
				...source,
				pendingNarratorIds: source.pendingNarratorIds.filter((id) =>
					protection.narratorIds.has(id),
				),
			});
		// Represented children are driven by Agent continuations; standalone children mount independently.
		logger.info("Prepared ordinary restart recovery", {
			targetCount: selected.length,
			agentCount: representedChildren.size,
			toolCount: protection.toolCallIds.size,
			automaticResume: automaticResumeEnabled(),
		});
		const prepared = { manifest, protection, heldRunIds: held };
		if (!automaticResumeEnabled()) {
			processState.pausedRecovery = prepared;
			// A disabled recovery has no runtime owner: show an honest interrupted/resting state,
			// while keeping permission/tool records protected and available for a manual resume.
			return { manifest, protection: { ...protection, narratorIds: held }, heldRunIds: held };
		}
		return prepared;
	} catch (error) {
		processState.prepared = false;
		throw error;
	}
}

async function putColdContinuation(
	input: Parameters<typeof toolContinuationService.upsert>[0],
	previous: Awaited<ReturnType<typeof toolContinuationService.getByToolCallId>>,
	options: RecoveryReadOptions = {},
) {
	if (!previous) {
		await toolContinuationService.upsert(input, previous, options);
		return;
	}
	if (previous.state === "cancelled" || isToolContinuationOwnerMounted(previous)) return;
	if (
		previous.updateEpoch === input.updateEpoch &&
		previous.state === "completed" &&
		input.kind !== "foreground_agent" &&
		input.kind !== "background_agent"
	)
		return;
	if (previous.updateEpoch !== input.updateEpoch) {
		const pass = await toolContinuationService.beginOrdinaryColdAdoptionPass(
			{
				rootEpoch: input.updateEpoch,
				toolCallId: input.toolCallId,
				observation: input.recoveryObservation?.tool
					? { continuation: previous, tool: input.recoveryObservation.tool }
					: undefined,
			},
			options,
		);
		try {
			const adopted = await toolContinuationService.controlledOrdinaryColdAdoption(
				input,
				pass.authorization,
			);
			if (!adopted)
				logger.warn("Ordinary cold recovery could not prove continuation identity", {
					toolCallId: input.toolCallId,
					rootEpoch: input.updateEpoch,
					sourceEpoch: previous.updateEpoch,
				});
		} finally {
			pass.close();
		}
		return;
	}
	const call =
		input.recoveryObservation?.tool ??
		(await readQueryFirst(
			db
				.select({
					executionAttempt: narratorToolCalls.executionAttempt,
					executionStartedAt: narratorToolCalls.executionStartedAt,
				})
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, input.toolCallId))
				.limit(1),
			{ ...options, executionPolicy: "worker-required", maxRows: 1 },
		));
	if (!call) return;
	const pass = toolContinuationService.beginColdRecoveryPass({
		rootEpoch: input.updateEpoch,
		sourceEpochs: [previous.updateEpoch],
		unstartedTools:
			call.executionStartedAt == null
				? [{ toolCallId: input.toolCallId, executionAttempt: call.executionAttempt }]
				: [],
	});
	try {
		const evidence = {
			sourceEpoch: previous.updateEpoch,
			executionAttempt: call.executionAttempt,
			authorization: pass.authorization,
			observed: previous,
		};
		if (input.kind === "foreground_agent" || input.kind === "background_agent") {
			const subagentId = input.payloadJson?.subagentId;
			const logicalRunId = input.payloadJson?.logicalRunId;
			if (typeof subagentId === "string" && typeof logicalRunId === "string") {
				const reattached = await toolContinuationService.controlledColdReattachAgent(input, {
					...evidence,
					subagentId,
					logicalRunId,
				});
				if (reattached) return;
			}
		} else {
			const taken = await toolContinuationService.controlledColdTakeover(input, evidence);
			if (taken) return;
		}
		if (previous.updateEpoch !== input.updateEpoch || previous.state === "resuming") {
			throw new Error(`Cold recovery cannot prove execution identity for ${input.toolCallId}`);
		}
		await toolContinuationService.upsert(input, previous, options);
	} finally {
		pass.close();
	}
}

/** A v3 root owns this source's authorization; the old file cannot run independently. */
export async function removeCarriedOrdinaryManifest(epoch: string): Promise<void> {
	await removeManifest(epoch);
}

export async function restoreCarriedOrdinaryTargets(
	source: RecoverySource,
	driven: ReadonlySet<string>,
	includedNarratorIds?: ReadonlySet<string>,
	humanReplyContext?: { narratorId: string; context: ReplyContext },
	options: RecoveryReadOptions = {},
): Promise<void> {
	const { continueNarrator } = await import("./narrator-session");
	const failures: string[] = [];
	const targets = (source.logicalRuns ?? []).filter(
		(target) =>
			!driven.has(target.narratorId) &&
			(!includedNarratorIds || includedNarratorIds.has(target.narratorId)),
	);
	const observations = new Map<string, RestartNarrator>();
	const ids = [...new Set(targets.map((target) => target.narratorId))];
	for (let offset = 0; offset < ids.length; offset += 100) {
		const rows = await readQuery(
			db.query.narrators.findMany({
				where: inArray(narrators.id, ids.slice(offset, offset + 100)),
				columns: RESTART_NARRATOR_COLUMNS,
			}),
			{
				signal: options.signal,
				deadlineAt: options.deadlineAt,
				timeoutMs: options.timeoutMs,
				executionPolicy: "worker-required",
				maxRows: 100,
			},
		);
		for (const row of rows) observations.set(row.id, row);
	}
	for (const target of targets) {
		try {
			await withRecoveryAdvance(source.updateEpoch, async () => {
				const current = getRecoverySource(source.updateEpoch);
				if (!current?.pendingNarratorIds.includes(target.narratorId)) return;
				options.signal?.throwIfAborted();
				const row = observations.get(target.narratorId);
				const saved = current.narrators.find((entry) => entry.narratorId === target.narratorId);
				const valid =
					row &&
					row.logicalRunId === target.logicalRunId &&
					(!!runDeliverToOf(row) || (!!target.logicalRunId && !!saved)) &&
					(restartEligible(row) ||
						(row.status === "idle" &&
							parseSubstatus(row.substatus).includes("interrupted") &&
							!parseSubstatus(row.substatus).some((tag) =>
								["error", "taken_over", "manual_override", "cancelled"].includes(tag),
							)));
				if (valid) {
					// Keep the persisted run/deadline and original reply options. A delegated
					// run's task/tool call already owns delivery; recovery must not deliver twice.
					const resumed = await continueNarrator(
						row.id,
						(saved?.locale ?? "en") as Locale,
						saved?.replyInUserLanguage ?? false,
						saved?.userId,
						{
							resumeRunId: row.logicalRunId ?? undefined,
							recovered: true,
							deliver: false,
							recoveryObservation: row,
							cancelSignal: options.signal,
						},
						humanReplyContext?.narratorId === row.id ? humanReplyContext.context : undefined,
					);
					if (!resumed.ok) throw new Error("Standalone run recovery did not start");
				}
				const original = getRegisteredRecoverySource(source.updateEpoch);
				if (original)
					registerRecoverySource(original).update({
						...current,
						pendingNarratorIds: current.pendingNarratorIds.filter((id) => id !== target.narratorId),
					});
			});
		} catch (error) {
			if (error instanceof RuntimeReadConflictError) throw error;
			failures.push(target.narratorId);
			logger.error("Could not resume interrupted standalone narrator", {
				narratorId: target.narratorId,
				error: String(error),
			});
		}
	}
	if (failures.length)
		throw new Error(`Failed to mount ordinary restart targets: ${failures.join(", ")}`);
}

export async function restoreOrdinaryRestartRecovery(
	prepared: RestartStartupRecovery,
	options: RecoveryReadOptions & {
		manual?: boolean;
		includedNarratorIds?: ReadonlySet<string>;
		humanReplyContext?: { narratorId: string; context: ReplyContext };
	} = {},
) {
	if (!prepared.manifest || (!options.manual && !automaticResumeEnabled())) return null;
	const { manifest, protection } = prepared;
	const records = (
		await toolContinuationService.listByEpoch(manifest.snapshot.updateEpoch, options)
	).filter(
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
	const source = getRecoverySource(manifest.snapshot.updateEpoch);
	if (!source) throw new Error("Ordinary recovery source was not registered during classification");
	return restoreNarratorsAfterPlannedUpdate(
		{ snapshot: manifest.snapshot, protection },
		{
			includedNarratorIds: options.includedNarratorIds,
			humanReplyContext: options.humanReplyContext,
			onSendWaitersSettled: () =>
				restoreCarriedOrdinaryTargets(
					source,
					driven,
					options.includedNarratorIds,
					options.humanReplyContext,
					options,
				),
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
export async function manuallyResumeRestartRecovery(
	narratorId: string,
	humanReplyContext?: ReplyContext,
	options: RecoveryReadOptions = {},
): Promise<boolean> {
	const context = parseReplyContext(humanReplyContext);
	const prepared = processState.pausedRecovery;
	if (!prepared?.manifest?.targets.some((target) => target.narratorId === narratorId)) return false;
	const ids = new Set([narratorId]);
	const rows = await withDeliverTo(
		prepared.manifest.targets.slice(0, MAX_TARGETS).map((target) => ({ id: target.narratorId })),
		options,
	);
	// The chosen session plus every run that (transitively) delivers to it.
	for (let changed = true; changed; ) {
		changed = false;
		for (const row of rows) {
			const caller = row.deliverTo?.narratorId;
			if (caller && ids.has(caller) && !ids.has(row.id)) {
				ids.add(row.id);
				changed = true;
			}
		}
	}
	const handle = await restoreOrdinaryRestartRecovery(prepared, {
		...options,
		manual: true,
		includedNarratorIds: ids,
		humanReplyContext: context ? { narratorId, context } : undefined,
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
	manifestIdentities.clear();
}
