/**
 * Bounded, metadata-only projections of legacy subagent file attributions.
 *
 * These rows measure cumulative churn, NOT net contribution. In particular, a
 * tool-use id or a timestamp is not an operation/attempt receipt: file_attributions
 * has no v2 effect link. Execution windows only exclude obviously unrelated rows;
 * every projection remains explicitly legacy/unscoped until evidence v2 takes over.
 */
import { and, asc, eq, inArray, like, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "../db";
import { fileAttributions, narrators, narratorToolCalls } from "../db/schema";
import { logger } from "../lib/logger";
import { normalizeWorkspacePath } from "./git-workspace";

export const MAX_AGGREGATED_FILES = 2000;
/** Bound input work too: LIMIT after SUM/GROUP BY would still scan an entire history. */
export const MAX_LEGACY_ATTRIBUTION_ROWS = 10_000;
export const MAX_SUBAGENT_QUERY_IDS = 200;
export const CARD_FILE_LIST_MAX = 5;
export const INJECTED_FILE_LIST_MAX = 20;

export interface SubagentParentWorkspace {
	/** null is unknown, not the local server. */
	deviceId: string | null;
	workspacePath: string | null;
}

/** Requested boundary, not proof of ownership by a particular execution attempt. */
export interface SubagentFileChangeScope {
	/** The parent's Agent/Task call, NOT a child's Write/Edit tool-use id. */
	sourceToolUseId: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
}

export interface SubagentChangedFile {
	subagentNarratorId: string;
	deviceId: string;
	workspacePath: string;
	filePath: string;
	/** Sum of the available measurements; null means none were measured. */
	linesAdded: number | null;
	linesRemoved: number | null;
	editCount: number;
	/** Either missing side makes a row unmeasured. Never infer this from SUM. */
	unmeasuredCount: number;
	/** null means unknown. Even false is location information, NOT undo authorization. */
	outsideParentWorkspace: boolean | null;
}

export interface SubagentFileChanges {
	files: SubagentChangedFile[];
	/** Distinct (child, device, workspace, file) groups; a lower bound when truncated. */
	totalFiles: number;
	totalUnmeasured: number;
	/** Distinct (device, workspace, file) shell observations, separate from Write/Edit. */
	bashTouchedCount: number;
	countsTruncated: boolean;
	attributionScope: "legacy_unscoped";
	/** The window actually used, when one was requested. It does not establish attempt ownership. */
	scope?: SubagentFileChangeScope;
}

function emptyChanges(scope?: SubagentFileChangeScope): SubagentFileChanges {
	return {
		files: [],
		totalFiles: 0,
		totalUnmeasured: 0,
		bashTouchedCount: 0,
		countsTruncated: false,
		attributionScope: "legacy_unscoped",
		...(scope ? { scope } : {}),
	};
}

export function hasSubagentFileChanges(changes: SubagentFileChanges): boolean {
	return changes.totalFiles > 0 || changes.bashTouchedCount > 0 || changes.countsTruncated;
}

/** Collision-safe even when paths contain delimiters. Never key on display path alone. */
export function subagentFileIdentityKey(file: {
	deviceId: string | null;
	workspacePath: string | null;
	filePath: string;
}): string {
	return JSON.stringify([file.deviceId, file.workspacePath, file.filePath]);
}

function normalizeParentWorkspace(workspace: SubagentParentWorkspace): SubagentParentWorkspace {
	return {
		deviceId: workspace.deviceId || null,
		workspacePath:
			workspace.deviceId === "local" && workspace.workspacePath
				? normalizeWorkspacePath(workspace.workspacePath)
				: workspace.workspacePath || null,
	};
}

function outsideParentWorkspace(
	file: { deviceId: string; workspacePath: string },
	parent: SubagentParentWorkspace | null,
): boolean | null {
	if (!parent?.deviceId || !parent.workspacePath || !file.deviceId || !file.workspacePath) {
		return null;
	}
	return file.deviceId !== parent.deviceId || file.workspacePath !== parent.workspacePath;
}

/** The variant is current identity; legacy type-only subagents remain readable. */
function subagentPredicate() {
	return or(eq(narrators.type, "subagent"), like(narrators.variant, "subagent:%"));
}

interface ChildQuery {
	id: string;
	parentNarratorId: string | null;
	parentWorkspace: SubagentParentWorkspace | null;
}

/** Batches identity validation AND parent location; a primary fork is not a team member. */
async function loadChildren(ids: string[], parentNarratorId?: string): Promise<ChildQuery[]> {
	if (!ids.length) return [];
	const parent = alias(narrators, "file_changes_parent");
	const rows = await db
		.select({
			id: narrators.id,
			parentNarratorId: narrators.parentNarratorId,
			parentId: parent.id,
			parentCwd: parent.cwd,
			parentDeviceId: parent.defaultDeviceId,
		})
		.from(narrators)
		.leftJoin(parent, eq(parent.id, narrators.parentNarratorId))
		.where(
			and(
				inArray(narrators.id, ids),
				subagentPredicate(),
				parentNarratorId ? eq(narrators.parentNarratorId, parentNarratorId) : undefined,
			),
		)
		.limit(MAX_SUBAGENT_QUERY_IDS);
	return rows.map((row) => ({
		id: row.id,
		parentNarratorId: row.parentNarratorId,
		// The persisted defaultDeviceId contract makes null LOCAL, but only when a
		// real parent row exists. An absent parent or an explicit unknown override
		// must never acquire a guessed local device.
		parentWorkspace: row.parentId
			? normalizeParentWorkspace({
					deviceId: row.parentDeviceId ?? "local",
					workspacePath: row.parentCwd,
				})
			: null,
	}));
}

function isoTime(value: string | null | undefined): string | null {
	if (!value) return null;
	const millis = Date.parse(value);
	return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/** Only narrow timing columns, never Agent input/output or message bodies. */
async function resolveScopes(
	children: ChildQuery[],
	requested: ReadonlyMap<string, SubagentFileChangeScope>,
): Promise<Map<string, SubagentFileChangeScope>> {
	const scopes = new Map<string, SubagentFileChangeScope>();
	const lookups = children.flatMap((child) => {
		const scope = requested.get(child.id);
		return scope?.sourceToolUseId && child.parentNarratorId
			? [
					and(
						eq(narratorToolCalls.narratorId, child.parentNarratorId),
						eq(narratorToolCalls.toolUseId, scope.sourceToolUseId),
					),
				]
			: [];
	});
	const timings = lookups.length
		? await db
				.select({
					parentNarratorId: narratorToolCalls.narratorId,
					sourceToolUseId: narratorToolCalls.toolUseId,
					startedAt: narratorToolCalls.executionStartedAt,
					createdAt: narratorToolCalls.createdAt,
					completedAt: narratorToolCalls.completedAt,
				})
				.from(narratorToolCalls)
				.where(or(...lookups))
				.limit(MAX_SUBAGENT_QUERY_IDS * 2 + 1)
		: [];
	for (const child of children) {
		const scope = requested.get(child.id);
		if (!scope) continue;
		const matching = timings.filter(
			(row) =>
				row.parentNarratorId === child.parentNarratorId &&
				row.sourceToolUseId === scope.sourceToolUseId,
		);
		// Duplicate/COW calls with this id are ambiguous. Explicit live-run bounds
		// still work, but do not pick an arbitrary historical call as evidence.
		const timing = matching.length === 1 ? matching[0] : undefined;
		scopes.set(child.id, {
			sourceToolUseId: scope.sourceToolUseId,
			startedAt: isoTime(
				scope.startedAt === undefined ? (timing?.startedAt ?? timing?.createdAt) : scope.startedAt,
			),
			completedAt: isoTime(
				scope.completedAt === undefined ? timing?.completedAt : scope.completedAt,
			),
		});
	}
	return scopes;
}

export interface SubagentFileChangeQueryOptions {
	parentNarratorId?: string;
	scopesBySubagent?: ReadonlyMap<string, SubagentFileChangeScope>;
	/** A present null value explicitly means unknown; an absent entry resolves from DB. */
	parentWorkspacesBySubagent?: ReadonlyMap<string, SubagentParentWorkspace | null>;
}

interface AggregateEntry {
	changes: SubagentFileChanges;
	files: Map<string, SubagentChangedFile>;
	bashFiles: Set<string>;
}

/** Shared implementation for single-child results, whole-team summaries, and cards. */
async function queryChanges(ids: string[], options: SubagentFileChangeQueryOptions = {}) {
	const children = await loadChildren(ids, options.parentNarratorId);
	const scopes = await resolveScopes(children, options.scopesBySubagent ?? new Map());
	const entries = new Map<string, AggregateEntry>();
	for (const child of children) {
		entries.set(child.id, {
			changes: emptyChanges(scopes.get(child.id)),
			files: new Map(),
			bashFiles: new Set(),
		});
	}
	if (!children.length) return entries;
	// Use the narrator index and a source-row cap, not unbounded SQL SUM/COUNT.
	// No timestamp ordering: that would sort a potentially enormous history before
	// LIMIT. Reaching the cap is explicitly a lower bound, even for a filtered run.
	const rows = await db
		.select({
			subagentNarratorId: fileAttributions.narratorId,
			deviceId: fileAttributions.deviceId,
			workspacePath: fileAttributions.workspacePath,
			filePath: fileAttributions.filePath,
			action: fileAttributions.action,
			linesAdded: fileAttributions.linesAdded,
			linesRemoved: fileAttributions.linesRemoved,
			changedAt: fileAttributions.changedAt,
		})
		.from(fileAttributions)
		.where(
			inArray(
				fileAttributions.narratorId,
				children.map((child) => child.id),
			),
		)
		.orderBy(asc(fileAttributions.narratorId))
		.limit(MAX_LEGACY_ATTRIBUTION_ROWS + 1);
	const firstOmittedOwner = rows[MAX_LEGACY_ATTRIBUTION_ROWS]?.subagentNarratorId;
	const workspaceByChild = new Map(children.map((child) => [child.id, child.parentWorkspace]));
	for (const [id, workspace] of options.parentWorkspacesBySubagent ?? []) {
		workspaceByChild.set(id, workspace ? normalizeParentWorkspace(workspace) : null);
	}
	for (const row of rows.slice(0, MAX_LEGACY_ATTRIBUTION_ROWS)) {
		if (!row.subagentNarratorId) continue;
		const entry = entries.get(row.subagentNarratorId);
		if (!entry) continue;
		const scope = scopes.get(row.subagentNarratorId);
		if (
			(scope?.startedAt && row.changedAt < scope.startedAt) ||
			(scope?.completedAt && row.changedAt > scope.completedAt)
		)
			continue;
		const key = subagentFileIdentityKey(row);
		if (row.action === "bash") {
			entry.bashFiles.add(key);
			continue;
		}
		if (row.action !== "write" && row.action !== "edit") continue;
		let file = entry.files.get(key);
		if (!file) {
			if (entry.files.size >= MAX_AGGREGATED_FILES) {
				entry.changes.countsTruncated = true;
				continue;
			}
			file = {
				subagentNarratorId: row.subagentNarratorId,
				deviceId: row.deviceId,
				workspacePath: row.workspacePath,
				filePath: row.filePath,
				linesAdded: null,
				linesRemoved: null,
				editCount: 0,
				unmeasuredCount: 0,
				outsideParentWorkspace: outsideParentWorkspace(
					row,
					workspaceByChild.get(row.subagentNarratorId) ?? null,
				),
			};
			entry.files.set(key, file);
		}
		if (row.linesAdded !== null) file.linesAdded = (file.linesAdded ?? 0) + row.linesAdded;
		if (row.linesRemoved !== null) file.linesRemoved = (file.linesRemoved ?? 0) + row.linesRemoved;
		file.editCount += 1;
		if (row.linesAdded === null || row.linesRemoved === null) file.unmeasuredCount += 1;
	}
	for (const [id, entry] of entries) {
		entry.changes.files = [...entry.files.values()];
		sortByChurnDescending(entry.changes.files);
		entry.changes.totalFiles = entry.files.size;
		entry.changes.totalUnmeasured = entry.changes.files.reduce(
			(sum, file) => sum + file.unmeasuredCount,
			0,
		);
		entry.changes.bashTouchedCount = entry.bashFiles.size;
		if (firstOmittedOwner && id >= firstOmittedOwner) entry.changes.countsTruncated = true;
	}
	return entries;
}

/** Legacy-compatible, batched card query; supply scopes to use the same window as a result. */
export async function getFileChangesBySubagent(
	subagentNarratorIds: string[],
	options: SubagentFileChangeQueryOptions = {},
): Promise<Map<string, SubagentFileChanges>> {
	const ids = [...new Set(subagentNarratorIds)].filter(Boolean);
	const result = new Map<string, SubagentFileChanges>();
	try {
		const entries = await queryChanges(ids.slice(0, MAX_SUBAGENT_QUERY_IDS), options);
		for (const [id, entry] of entries) {
			if (hasSubagentFileChanges(entry.changes)) result.set(id, entry.changes);
		}
		// Never turn a page budget into an assertion that omitted children changed nothing.
		for (const id of ids.slice(MAX_SUBAGENT_QUERY_IDS)) {
			result.set(id, { ...emptyChanges(options.scopesBySubagent?.get(id)), countsTruncated: true });
		}
	} catch (err) {
		logger.debug("Failed to aggregate file changes by subagent", { error: String(err) });
	}
	return result;
}

export interface ChildSubagentFileChangesOptions {
	parentNarratorId: string;
	childNarratorId: string;
	scope: SubagentFileChangeScope;
	parentWorkspace?: SubagentParentWorkspace | null;
}

/** Single-result entry point: never falls back to the whole parent team. */
export async function getChildSubagentFileChanges(
	options: ChildSubagentFileChangesOptions,
): Promise<SubagentFileChanges> {
	const { parentNarratorId, childNarratorId, scope, parentWorkspace } = options;
	const entries = await getFileChangesBySubagent([childNarratorId], {
		parentNarratorId,
		scopesBySubagent: new Map([[childNarratorId, scope]]),
		...(parentWorkspace !== undefined
			? { parentWorkspacesBySubagent: new Map([[childNarratorId, parentWorkspace]]) }
			: {}),
	});
	return entries.get(childNarratorId) ?? emptyChanges(scope);
}

/** Explicit whole-team entry point. No caller may attach this to a single child result. */
export async function getTeamSubagentFileChanges(
	parentNarratorId: string,
	parentWorkspacePath?: string | null,
	parentDeviceId?: string | null,
): Promise<SubagentFileChanges> {
	try {
		const children = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(and(eq(narrators.parentNarratorId, parentNarratorId), subagentPredicate()))
			.orderBy(asc(narrators.id))
			.limit(MAX_SUBAGENT_QUERY_IDS + 1);
		const ids = children.slice(0, MAX_SUBAGENT_QUERY_IDS).map((child) => child.id);
		let workspace: SubagentParentWorkspace | undefined;
		if (parentWorkspacePath !== undefined || parentDeviceId !== undefined) {
			const parent = await db.query.narrators.findFirst({
				where: eq(narrators.id, parentNarratorId),
				columns: { cwd: true, defaultDeviceId: true },
			});
			workspace = {
				deviceId:
					parentDeviceId === undefined
						? parent
							? (parent.defaultDeviceId ?? "local")
							: null
						: parentDeviceId,
				workspacePath:
					parentWorkspacePath === undefined ? (parent?.cwd ?? null) : parentWorkspacePath,
			};
		}
		const entries = await queryChanges(ids, {
			parentNarratorId,
			...(workspace
				? { parentWorkspacesBySubagent: new Map(ids.map((id) => [id, workspace])) }
				: {}),
		});
		const result = emptyChanges();
		const bashFiles = new Set<string>();
		for (const entry of entries.values()) {
			result.files.push(...entry.changes.files);
			result.countsTruncated ||= entry.changes.countsTruncated;
			for (const key of entry.bashFiles) bashFiles.add(key);
		}
		sortByChurnDescending(result.files);
		result.countsTruncated ||=
			children.length > MAX_SUBAGENT_QUERY_IDS || result.files.length > MAX_AGGREGATED_FILES;
		result.files = result.files.slice(0, MAX_AGGREGATED_FILES);
		result.totalFiles = result.files.length;
		result.totalUnmeasured = result.files.reduce((sum, file) => sum + file.unmeasuredCount, 0);
		result.bashTouchedCount = bashFiles.size;
		return result;
	} catch (err) {
		logger.debug("Failed to aggregate subagent file changes", {
			parentNarratorId,
			error: String(err),
		});
		return emptyChanges();
	}
}

/** Compatibility alias for existing whole-team callers. */
export const getSubagentFileChanges = getTeamSubagentFileChanges;

function sortByChurnDescending(files: SubagentChangedFile[]): void {
	files.sort((a, b) => {
		const churn = (f: SubagentChangedFile) => (f.linesAdded ?? 0) + (f.linesRemoved ?? 0);
		return (
			churn(b) - churn(a) ||
			a.filePath.localeCompare(b.filePath) ||
			subagentFileIdentityKey(a).localeCompare(subagentFileIdentityKey(b)) ||
			a.subagentNarratorId.localeCompare(b.subagentNarratorId)
		);
	});
}

function formatFileLine(file: SubagentChangedFile): string {
	const figures =
		file.linesAdded === null || file.linesRemoved === null
			? "(lines not measured)"
			: `+${file.linesAdded} -${file.linesRemoved}${file.editCount > 1 ? ` across ${file.editCount} edits` : ""}`;
	// A filename is presentation, never a unique identity (even within one child).
	return `${file.filePath} ${figures} [device=${JSON.stringify(file.deviceId)}, workspace=${JSON.stringify(file.workspacePath)}]`;
}

export function formatSubagentFileChanges(changes: SubagentFileChanges): string {
	if (!hasSubagentFileChanges(changes)) return "";
	const lines = [
		"Legacy/unscoped attribution; no verified operation/attempt link or precise net contribution.",
		"Figures are cumulative across edits, not net change from the original.",
	];
	if (changes.scope?.startedAt || changes.scope?.completedAt) {
		lines.push(
			`Time-window filter only: ${changes.scope.startedAt ?? "unknown start"} to ${changes.scope.completedAt ?? "unknown end"}; not proof of this attempt's changes.`,
		);
	} else if (changes.scope) {
		lines.push(
			"Execution boundary unavailable: these are this child's legacy history, not verified changes from the current run.",
		);
	}
	const visible = changes.files.slice(0, INJECTED_FILE_LIST_MAX);
	for (const file of visible) lines.push(formatFileLine(file));
	const hidden = changes.totalFiles - visible.length;
	if (hidden > 0) {
		lines.push(
			`…and ${hidden} more files${changes.totalUnmeasured > 0 ? ` (${changes.totalUnmeasured} not measured)` : ""}`,
		);
	} else if (changes.totalUnmeasured > 0) {
		lines.push(`(${changes.totalUnmeasured} change(s) had no line measurement)`);
	}
	if (changes.bashTouchedCount > 0) {
		lines.push(
			`plus ${changes.bashTouchedCount} file(s) touched by shell commands (lines not measured)`,
		);
	}
	const outside = changes.files.filter((file) => file.outsideParentWorkspace === true).length;
	if (outside > 0)
		lines.push(`${outside} file(s) outside this workspace — a revert here will not restore them`);
	const unknown = changes.files.filter((file) => file.outsideParentWorkspace == null).length;
	if (unknown > 0)
		lines.push(
			`${unknown} file(s) with unknown parent device/workspace coverage; do not assume a revert here covers them`,
		);
	if (changes.countsTruncated) {
		lines.push(
			`(counts truncated at ${MAX_AGGREGATED_FILES} files, ${MAX_LEGACY_ATTRIBUTION_ROWS} legacy rows or ${MAX_SUBAGENT_QUERY_IDS} children; totals are lower bounds)`,
		);
	}
	return `<subagent_file_changes>\n${lines.join("\n")}\n</subagent_file_changes>`;
}

/** All five outlets must supply child AND requested execution boundary explicitly. */
export async function appendSubagentFileChanges(
	options: ChildSubagentFileChangesOptions,
	resultText: string,
): Promise<string> {
	try {
		const block = formatSubagentFileChanges(await getChildSubagentFileChanges(options));
		return block ? `${resultText}\n\n${block}` : resultText;
	} catch (err) {
		logger.debug("Failed to append subagent file changes", {
			parentNarratorId: options.parentNarratorId,
			childNarratorId: options.childNarratorId,
			error: String(err),
		});
		return resultText;
	}
}
