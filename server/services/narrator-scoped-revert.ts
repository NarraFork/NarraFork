/**
 * M0 safety gate for narrator-scoped rollback.
 *
 * A v1 pair observes a whole worktree, not the bytes an operation actually wrote.
 * Neither declared paths, equal trees nor a sampled attribution timeline upgrades
 * it to operation evidence. Enumerate the entire selected window first; refuse
 * unknown coverage before any filesystem work. M1–M3 supply the v2 planner.
 */
import { isAbsolute, relative } from "node:path";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorMessageRefs, narratorMessages, narrators, narratorToolCalls } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import type { NarratorPrincipal } from "./narrator-acl";
import type { RevertPlannerResult } from "./revert-planner-service";
import {
	EMPTY_RESULT,
	type RevertResult,
	resolveNarratorCwd,
	unavailableSnapshotRevert,
} from "./snapshot-revert";
import { specVfsService } from "./spec-vfs-service";

/** Legacy observations retained for read-only consumers, never execution evidence. */
export interface BoundaryPair {
	toolUseId: string;
	messageId: string;
	seq: number;
	before: string;
	after: string;
	/** A declaration/observation of paths, not proof of owned content. */
	ownedPaths: string[] | null;
}

export type ScopedRevertSelector =
	| { minSeq: number }
	| { messageIds: string[] }
	| { toolUses: Array<{ messageId: string; toolUseId: string }> };

export type ScopedRevertUnavailableReason =
	| "no_boundaries"
	| "snapshot_missing"
	| "no_workspace"
	| "git_unsupported"
	| "window_too_large"
	| "legacy_unverified"
	/** A recorded operation is not yet connected to execution through this adapter. */
	| "execution_unavailable"
	| "runtime_reload_required"
	| "incomplete_coverage"
	| "file_conflict"
	| "history_changed"
	| "unsupported_target"
	/** The server's data volume cannot provide stable object identities/link counts. */
	| "platform_unsupported"
	| "pending_operations"
	/** Only explicit empty selections, known read-only calls or spec-only writes. */
	| "nothing_owned";

export interface ScopedRevertPlan {
	worktreePath: string;
	pairs: BoundaryPair[];
}

interface PairSelection {
	pairs: BoundaryPair[];
	unavailable: ScopedRevertUnavailableReason;
}

const MAX_OPERATION_ROWS = 1_000;
// Avoid parsing megabytes of legacy Write content on the SQLite request thread.
// Larger inputs remain unknown unless frozen execution metadata identifies them.
const MAX_INPUT_METADATA_BYTES = 16 * 1024;
/** Only tools with explicit file-journal semantics participate in file rollback. */
const REVERTABLE_FILE_TOOLS = new Set(["Write", "Edit", "StructSed"]);
type WindowCoverage =
	| { kind: "empty" }
	| { kind: "too_large" }
	| { kind: "nothing_owned" }
	| { kind: "incomplete_coverage" };

/**
 * Seq/message leftover cards: stay inside the operation-row budget.
 * The query already excludes every message with a persisted tool row, so any
 * existing message role is content-only and cannot own a disk mutation.
 */
async function classifyWindowWithoutOperations(
	narratorId: string,
	scope: Exclude<
		ScopedRevertSelector,
		{ toolUses: Array<{ messageId: string; toolUseId: string }> }
	>,
	knownMessageIds: ReadonlySet<string> = new Set(),
): Promise<WindowCoverage> {
	const rows = await db
		.select({
			messageId: narratorMessageRefs.messageId,
			role: narratorMessages.role,
		})
		.from(narratorMessageRefs)
		.leftJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				"messageIds" in scope
					? inArray(narratorMessageRefs.messageId, scope.messageIds)
					: gte(narratorMessageRefs.seq, scope.minSeq),
				sql`NOT EXISTS (
					SELECT 1 FROM ${narratorToolCalls}
					WHERE ${narratorToolCalls.messageId} = ${narratorMessageRefs.messageId}
				)`,
			),
		)
		.limit(MAX_OPERATION_ROWS + 1);
	if (rows.length > MAX_OPERATION_ROWS) return { kind: "too_large" };
	if (rows.some((row) => row.role == null)) {
		return { kind: "incomplete_coverage" };
	}
	if ("messageIds" in scope) {
		const found = new Set(rows.map((row) => row.messageId));
		const missing = scope.messageIds.filter((id) => !knownMessageIds.has(id) && !found.has(id));
		if (missing.length > 0) {
			if (rows.length + missing.length > MAX_OPERATION_ROWS) return { kind: "too_large" };
			const extra = await db
				.select({ id: narratorMessages.id, role: narratorMessages.role })
				.from(narratorMessages)
				.where(inArray(narratorMessages.id, missing));
			if (extra.length !== missing.length) return { kind: "incomplete_coverage" };
			if (extra.some((row) => row.role == null)) {
				return { kind: "incomplete_coverage" };
			}
			return { kind: "nothing_owned" };
		}
	}
	if (rows.length === 0) return { kind: "empty" };
	return { kind: "nothing_owned" };
}

/** Keep the selection bounded before constructing SQL, including explicit selectors. */
function selectorCondition(scope: ScopedRevertSelector) {
	if ("messageIds" in scope) return inArray(narratorToolCalls.messageId, scope.messageIds);
	if ("toolUses" in scope) {
		// A row-value IN avoids SQLite's expression-depth limit for a thousand ORs.
		// Match the message too: toolUseId alone also matches shared-message clones.
		return sql`(${narratorToolCalls.messageId}, ${narratorToolCalls.toolUseId}) IN (
			SELECT json_extract(value, '$.messageId'), json_extract(value, '$.toolUseId')
			FROM json_each(${JSON.stringify(scope.toolUses)})
		)`;
	}
	return gte(narratorMessageRefs.seq, scope.minSeq);
}

function outsideWorkspace(worktreePath: string, path: string): boolean {
	if (!isAbsolute(path)) return false;
	const rel = relative(worktreePath, path);
	return !rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
}

/**
 * All calls are selected, not just successful rows that happen to have two hashes.
 * Only short JSON scalars are projected: Write input bodies never enter JS memory.
 * Shared refs are authoritative for membership; the call's original author may
 * differ from this narrator after a fork/COW and must not make it disappear.
 */
async function selectPairs(
	narratorId: string,
	scope: ScopedRevertSelector,
	worktreePath: string | null,
): Promise<PairSelection> {
	const count =
		"messageIds" in scope
			? scope.messageIds.length
			: "toolUses" in scope
				? scope.toolUses.length
				: null;
	if (count === 0) return { pairs: [], unavailable: "nothing_owned" };
	if (count !== null && count > MAX_OPERATION_ROWS)
		return { pairs: [], unavailable: "window_too_large" };

	const input = sql`CASE
		WHEN octet_length(${narratorToolCalls.inputJson}) <= ${MAX_INPUT_METADATA_BYTES}
		THEN CASE WHEN json_valid(${narratorToolCalls.inputJson}) THEN ${narratorToolCalls.inputJson} ELSE '{}' END
		ELSE '{}' END`;
	const rows = await db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			messageId: narratorToolCalls.messageId,
			seq: narratorMessageRefs.seq,
			toolName: narratorToolCalls.toolName,
			status: narratorToolCalls.status,
			isBackground: narratorToolCalls.isBackground,
			fileChangeOperationId: narratorToolCalls.fileChangeOperationId,
			before: narratorToolCalls.treeHashBefore,
			after: narratorToolCalls.treeHashAfter,
			executionDeviceId: narratorToolCalls.executionDeviceId,
			executionCwd: narratorToolCalls.executionCwd,
			executionPathFlavor: narratorToolCalls.executionPathFlavor,
			resolvedFilePath: narratorToolCalls.resolvedFilePath,
			canonicalFilePath: narratorToolCalls.canonicalFilePath,
			inputFilePath: sql<string | null>`json_extract(${input}, '$.file_path')`,
			inputDevice: sql<string | null>`json_extract(${input}, '$.device')`,
			inputBackground: sql<number | null>`json_extract(${input}, '$.run_in_background')`,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(selectorCondition(scope))
		.orderBy(
			asc(narratorMessageRefs.seq),
			asc(narratorToolCalls.createdAt),
			asc(narratorToolCalls.id),
		)
		.limit(MAX_OPERATION_ROWS + 1);

	if (rows.length > MAX_OPERATION_ROWS) return { pairs: [], unavailable: "window_too_large" };
	if (rows.length === 0) {
		// A tool-use selector with zero rows is still unknown history.
		// Seq/message windows can be only injections or user turns (the cards
		// written after an interrupt). Those roles never persist tool calls,
		// so treat them as a no-op instead of REVERT_UNAVAILABLE.
		if ("toolUses" in scope) return { pairs: [], unavailable: "no_boundaries" };
		const coverage = await classifyWindowWithoutOperations(narratorId, scope);
		if (coverage.kind === "empty") return { pairs: [], unavailable: "no_boundaries" };
		if (coverage.kind === "too_large") return { pairs: [], unavailable: "window_too_large" };
		return { pairs: [], unavailable: coverage.kind };
	}
	if ("toolUses" in scope) {
		const present = new Set(rows.map((row) => `${row.messageId}\0${row.toolUseId}`));
		if (scope.toolUses.some((target) => !present.has(`${target.messageId}\0${target.toolUseId}`))) {
			return { pairs: [], unavailable: "incomplete_coverage" };
		}
	} else {
		// Mixed windows still have leftover content cards (task-guard,
		// continuation, user turns or provider-specific injections). Since these
		// rows have no persisted tool calls, they cannot own disk mutations.
		const leftover = await classifyWindowWithoutOperations(
			narratorId,
			scope,
			new Set(rows.map((row) => row.messageId)),
		);
		if (leftover.kind === "too_large") return { pairs: [], unavailable: "window_too_large" };
		if (leftover.kind === "incomplete_coverage") {
			return { pairs: [], unavailable: "incomplete_coverage" };
		}
	}

	const reasons = new Set<ScopedRevertUnavailableReason>();
	const pairs: BoundaryPair[] = [];
	for (const row of rows) {
		if (!REVERTABLE_FILE_TOOLS.has(row.toolName)) continue;
		const paths = [row.resolvedFilePath, row.canonicalFilePath, row.inputFilePath].filter(
			(path): path is string => typeof path === "string" && path.length > 0,
		);
		// The real tools intercept spec URIs before any disk I/O. An empty owned set
		// is NOT an equivalent proof, and contradictory resolved paths fail closed.
		if (
			(row.toolName === "Write" || row.toolName === "Edit") &&
			paths.length > 0 &&
			paths.every((path) => specVfsService.isSpecUri(path))
		)
			continue;

		if (
			(row.executionDeviceId && row.executionDeviceId !== LOCAL_DEVICE_ID) ||
			(typeof row.inputDevice === "string" && row.inputDevice !== LOCAL_DEVICE_ID) ||
			(worktreePath && paths.some((path) => outsideWorkspace(worktreePath, path)))
		) {
			reasons.add("unsupported_target");
		}
		// Non-terminal rows can survive a stopped/failed loop. They prove missing
		// completion evidence, not live IO that waiting will necessarily resolve.
		if (
			row.status !== "success" ||
			row.isBackground ||
			row.inputBackground ||
			(!row.fileChangeOperationId && (!row.before || !row.after))
		) {
			reasons.add("incomplete_coverage");
		}
		if (!worktreePath) reasons.add("no_workspace");
		// This adapter does not validate or execute operation journals. A pointer
		// identifies the unconnected execution path, NOT settled/complete evidence.
		// Legacy rows still lack receipts even when before===after or paths look known.
		reasons.add(row.fileChangeOperationId ? "execution_unavailable" : "legacy_unverified");
		if (row.before && row.after)
			pairs.push({
				toolUseId: row.toolUseId,
				messageId: row.messageId,
				seq: row.seq,
				before: row.before,
				after: row.after,
				ownedPaths: null,
			});
	}
	// A loop sharing this cwd may only be thinking/reading; even a real writer
	// cannot make these unavailable execution paths work just by finishing.
	// Preserve the actual blocker, and never hide unknown coverage behind a pointer.
	for (const reason of [
		"unsupported_target",
		"incomplete_coverage",
		"no_workspace",
		"legacy_unverified",
		"execution_unavailable",
	] as const) {
		if (reasons.has(reason)) return { pairs, unavailable: reason };
	}
	return { pairs: [], unavailable: "nothing_owned" };
}

/** No v1 row can produce an executable plan; object existence is not a receipt. */
export async function planNarratorScopedRevert(
	narratorId: string,
	scope: ScopedRevertSelector,
): Promise<{ plan: ScopedRevertPlan } | { unavailable: ScopedRevertUnavailableReason }> {
	const selection = await selectPairs(narratorId, scope, await resolveNarratorCwd(narratorId));
	return { unavailable: selection.unavailable };
}

/** Dedupe legacy display material only. This must not be used to prove coverage. */
export function dedupeBoundaryRows(
	rows: Array<{
		toolUseId: string;
		messageId: string;
		seq: number;
		before: string | null;
		after: string | null;
		ownedPaths?: string[] | null;
	}>,
): BoundaryPair[] {
	const seen = new Set<string>();
	const pairs: BoundaryPair[] = [];
	for (const row of rows) {
		if (!row.before || !row.after) continue;
		const ownedPaths = row.ownedPaths ?? null;
		const key = JSON.stringify([
			row.toolUseId,
			row.before,
			row.after,
			ownedPaths === null ? null : [...ownedPaths].sort(),
		]);
		if (seen.has(key)) continue;
		seen.add(key);
		pairs.push({ ...row, before: row.before, after: row.after, ownedPaths });
	}
	return pairs;
}

export interface ScopedRevertPreviewFile {
	deviceId: string;
	filePath: string;
	relPath: string;
	willBeDeleted: boolean;
	currentContent?: string | null;
	revertedContent?: string | null;
}

export interface ScopedRevertPreviewOptions {
	withContents?: boolean;
	/** Required for actual v2 preparation, never guessed from narrator ownership. */
	principal?: NarratorPrincipal;
	idempotencyKey?: string;
	signal?: AbortSignal;
}

export interface ScopedRevertPreview {
	plan?: RevertPlannerResult["plan"];
	available: boolean;
	reason?: ScopedRevertUnavailableReason;
	files: ScopedRevertPreviewFile[];
	totalFileCount?: number;
	hasMore?: boolean;
	conflicts: string[];
	subagentWarning?: { changeCount: number; sampleFiles: string[] };
}

export async function previewNarratorScopedRevert(
	narratorId: string,
	scope: ScopedRevertSelector,
	opts?: ScopedRevertPreviewOptions,
): Promise<ScopedRevertPreview> {
	if (opts?.principal) {
		const signal = opts.signal ?? AbortSignal.timeout(60_000);
		if (!opts.idempotencyKey)
			throw new Error("A stable scoped preview idempotency key is required");
		const prepared = await prepareNarratorScopedRevert(opts.principal, narratorId, scope, {
			idempotencyKey: opts.idempotencyKey,
			signal,
		});
		const { listLocalRevertPlanFiles } = await import("./revert-planner-local-access");
		const page = await listLocalRevertPlanFiles(opts.principal, narratorId, prepared.plan.id, {
			signal,
			limit: 100,
		});
		return {
			available: true,
			plan: prepared.plan,
			files: page.items.map((file) => ({
				deviceId: file.identityJson.deviceId,
				filePath: file.identityJson.canonicalPath,
				relPath: file.identityJson.displayPath,
				willBeDeleted: file.desiredStateJson.kind === "absent",
			})),
			totalFileCount: prepared.plan.expectedFileCount,
			hasMore: page.hasMore,
			conflicts: [],
		};
	}
	const selection = await selectPairs(narratorId, scope, await resolveNarratorCwd(narratorId));
	return {
		available: selection.unavailable === "nothing_owned",
		reason: selection.unavailable,
		files: [],
		conflicts: [],
	};
}

/** Never return null: unavailability is a refusal, not permission to widen scope. */
async function revertNarratorScoped(
	narratorId: string,
	scope: ScopedRevertSelector,
): Promise<RevertResult> {
	const cwd = await resolveNarratorCwd(narratorId);
	const selection = await selectPairs(narratorId, scope, cwd);
	if (selection.unavailable === "nothing_owned") return EMPTY_RESULT;
	return unavailableSnapshotRevert(
		`Narrator-scoped rollback unavailable: ${selection.unavailable}. Files and history were not changed.`,
		cwd ?? undefined,
	);
}

export type { SegmentReversalPlan } from "./worktree-tree-snapshot";

export function revertNarratorScopedFromSeq(
	narratorId: string,
	minSeq: number,
): Promise<RevertResult> {
	return revertNarratorScoped(narratorId, { minSeq });
}

export function revertNarratorScopedForMessages(
	narratorId: string,
	messageIds: string[],
): Promise<RevertResult> {
	return revertNarratorScoped(narratorId, { messageIds });
}

export function revertNarratorScopedForToolUses(
	narratorId: string,
	toolUses: Array<{ messageId: string; toolUseId: string }>,
): Promise<RevertResult> {
	return revertNarratorScoped(narratorId, { toolUses });
}

export function previewNarratorScopedForToolUses(
	narratorId: string,
	toolUses: Array<{ messageId: string; toolUseId: string }>,
	opts?: ScopedRevertPreviewOptions,
): Promise<ScopedRevertPreview> {
	return previewNarratorScopedRevert(narratorId, { toolUses }, opts);
}

export function previewNarratorScopedFromSeq(
	narratorId: string,
	minSeq: number,
	opts?: ScopedRevertPreviewOptions,
): Promise<ScopedRevertPreview> {
	return previewNarratorScopedRevert(narratorId, { minSeq }, opts);
}

export function previewNarratorScopedForMessages(
	narratorId: string,
	messageIds: string[],
	opts?: ScopedRevertPreviewOptions,
): Promise<ScopedRevertPreview> {
	return previewNarratorScopedRevert(narratorId, { messageIds }, opts);
}

/** Authenticated v2 preparation shared by local and remote record-qualified providers.
 * Unlike legacy boundary pairs, a result contains a durable consent/hash-bound manifest. */
export async function prepareNarratorScopedRevert(
	principal: NarratorPrincipal,
	narratorId: string,
	scope: ScopedRevertSelector,
	options: { idempotencyKey: string; signal: AbortSignal },
): Promise<RevertPlannerResult> {
	const { RevertPlannerLocalAccess, prepareLocalRevertPlan } = await import(
		"./revert-planner-local-access"
	);
	await new RevertPlannerLocalAccess().owner(principal, narratorId, options.signal);
	const row = db
		.select({ version: narrators.messageVersion })
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.get();
	if (!row) throw new Error("Narrator no longer exists");
	let selector: import("./revert-planner-service").RevertPlannerRequest["selector"];
	if ("minSeq" in scope) selector = { kind: "from_seq", minSeq: scope.minSeq };
	else if ("messageIds" in scope)
		selector = { kind: "messages", messageIds: [...scope.messageIds] };
	else {
		if (!scope.toolUses.length || scope.toolUses.length > MAX_OPERATION_ROWS)
			throw new Error("Scoped selection has no bounded tool identities");
		const rows = await db
			.select({
				id: narratorToolCalls.id,
				messageId: narratorToolCalls.messageId,
				toolUseId: narratorToolCalls.toolUseId,
			})
			.from(narratorToolCalls)
			.innerJoin(
				narratorMessageRefs,
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
				),
			)
			.where(selectorCondition(scope))
			.limit(MAX_OPERATION_ROWS + 1);
		if (rows.length > MAX_OPERATION_ROWS || rows.length !== scope.toolUses.length)
			throw new Error("Scoped selection has incomplete or ambiguous execution coverage");
		selector = { kind: "tool_calls", toolCallIds: rows.map((tool) => tool.id) };
	}
	return prepareLocalRevertPlan({
		principal,
		narratorId,
		expectedMessageVersion: row.version,
		idempotencyKey: options.idempotencyKey,
		kind: "revert",
		revertScope: "narrator",
		selector,
		uiAction: "revert_files",
		signal: options.signal,
	});
}

/** Apply ONLY a previously prepared, explicitly consented plan; no replan/cwd fallback. */
export async function applyNarratorScopedRevert(
	principal: NarratorPrincipal,
	narratorId: string,
	input: { planId: string; planHash: string },
	signal: AbortSignal,
) {
	const { applyLocalRevertPlan } = await import("./revert-planner-local-access");
	return applyLocalRevertPlan(
		principal,
		narratorId,
		input.planId,
		{ planHash: input.planHash, action: "revert_files" },
		signal,
	);
}
