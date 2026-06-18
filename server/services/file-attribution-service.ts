/**
 * File attribution service.
 *
 * Records a timeline of file modifications attributed to narrators / subagents
 * (or external/terminal changes), keyed by normalized workspace path. Works for
 * chapters AND standalone narrators that share the same directory.
 *
 * Writes are fire-and-forget and fully fault-tolerant: a failure here must
 * never block tool execution (same philosophy as file-snapshot-service).
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { fileAttributions, narrators } from "../db/schema";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { normalizeWorkspacePath } from "./git-workspace";

export type AttributionAction = "write" | "edit" | "bash" | "external";

export interface RecordAttributionInput {
	/** Raw or normalized workspace path; normalized internally. */
	workspacePath: string;
	/** Repo-relative file path. */
	filePath: string;
	/** Narrator that made the change; omit for external edits. */
	narratorId?: string | null;
	/** Subagent type, if known (avoids an extra lookup). */
	subagentType?: string | null;
	action: AttributionAction;
	toolName?: string | null;
	toolUseId?: string | null;
}

/** One modification event for a file. */
export interface AttributionEvent {
	id: string;
	narratorId: string | null;
	subagentType: string | null;
	action: AttributionAction;
	toolName: string | null;
	toolUseId: string | null;
	changedAt: string;
}

/** Aggregated attribution for a single file. */
export interface FileAttributionSummary {
	filePath: string;
	/** Most recent modifier (narratorId), or null if only external. */
	lastNarratorId: string | null;
	lastAction: AttributionAction;
	lastChangedAt: string;
	/** Distinct narratorIds that have touched this file. */
	contributorNarratorIds: string[];
	/** Whether any external (non-narrator) change was recorded. */
	hasExternal: boolean;
	/** Full timeline, newest first (capped). */
	timeline: AttributionEvent[];
}

/** Max timeline events returned per file to keep payloads bounded. */
const MAX_TIMELINE_PER_FILE = 50;

// ── Recently AI-attributed paths (in-memory) ─────────────────────────────────
//
// The worktree watcher fires on ANY file change, including terminal / external
// editor edits. To attribute those as "external" without misclassifying changes
// the AI tools just made, the tool path marks paths here. The watcher consults
// this in-memory map (no DB query in the hot path) and only records the
// remainder as external.

/** workspaceKey → (filePath → epoch ms of last AI attribution). */
const recentlyAttributed = new Map<string, Map<string, number>>();

/** How long an AI attribution "shadows" a path from external classification. */
const RECENT_ATTRIBUTION_TTL_MS = 15_000;

/** Mark file paths as recently attributed to an AI tool for `workspacePath`. */
export function markRecentlyAttributed(workspacePath: string, filePaths: string[]): void {
	const key = normalizeWorkspacePath(workspacePath);
	let map = recentlyAttributed.get(key);
	if (!map) {
		map = new Map();
		recentlyAttributed.set(key, map);
	}
	const now = Date.now();
	for (const fp of filePaths) {
		map.set(fp, now);
	}
}

/**
 * Return true if `filePath` was attributed to an AI tool within the TTL window.
 * Expired entries are pruned as a side effect.
 */
export function wasRecentlyAttributed(workspacePath: string, filePath: string): boolean {
	const key = normalizeWorkspacePath(workspacePath);
	const map = recentlyAttributed.get(key);
	if (!map) return false;
	const ts = map.get(filePath);
	if (ts == null) return false;
	if (Date.now() - ts > RECENT_ATTRIBUTION_TTL_MS) {
		map.delete(filePath);
		return false;
	}
	return true;
}

/**
 * Record a file modification. Never throws — failures are logged at debug.
 */
export async function recordAttribution(input: RecordAttributionInput): Promise<void> {
	try {
		const workspacePath = normalizeWorkspacePath(input.workspacePath);

		// Resolve subagentType lazily if a narrator was given but type omitted.
		let subagentType = input.subagentType ?? null;
		if (input.narratorId && subagentType == null) {
			const n = await db.query.narrators.findFirst({
				where: eq(narrators.id, input.narratorId),
				columns: { type: true, subagentType: true },
			});
			if (n?.type === "subagent") {
				subagentType = n.subagentType ?? "subagent";
			}
		}

		await db.insert(fileAttributions).values({
			id: generateId(),
			workspacePath,
			filePath: input.filePath,
			narratorId: input.narratorId ?? null,
			subagentType,
			action: input.action,
			toolName: input.toolName ?? null,
			toolUseId: input.toolUseId ?? null,
			changedAt: new Date().toISOString(),
		});

		// Shadow this path from external classification by the watcher.
		if (input.action !== "external") {
			markRecentlyAttributed(workspacePath, [input.filePath]);
		}
	} catch (err) {
		logger.debug("Failed to record file attribution", {
			workspacePath: input.workspacePath,
			filePath: input.filePath,
			error: String(err),
		});
	}
}

/** Record attributions for multiple files (e.g. Bash touched several). */
export async function recordAttributions(
	base: Omit<RecordAttributionInput, "filePath">,
	filePaths: string[],
): Promise<void> {
	for (const filePath of filePaths) {
		await recordAttribution({ ...base, filePath });
	}
}

/**
 * Get aggregated attribution summaries for a workspace.
 *
 * @param workspacePath  Raw or normalized path; normalized internally.
 * @param filePath       Optional: restrict to a single file.
 * @param limit          Max attribution rows scanned (bounded). Default 2000.
 */
export async function getAttributions(
	workspacePath: string,
	filePath?: string,
	limit = 2000,
): Promise<FileAttributionSummary[]> {
	const key = normalizeWorkspacePath(workspacePath);

	const where = filePath
		? and(eq(fileAttributions.workspacePath, key), eq(fileAttributions.filePath, filePath))
		: eq(fileAttributions.workspacePath, key);

	const rows = await db
		.select({
			id: fileAttributions.id,
			filePath: fileAttributions.filePath,
			narratorId: fileAttributions.narratorId,
			subagentType: fileAttributions.subagentType,
			action: fileAttributions.action,
			toolName: fileAttributions.toolName,
			toolUseId: fileAttributions.toolUseId,
			changedAt: fileAttributions.changedAt,
		})
		.from(fileAttributions)
		.where(where)
		.orderBy(desc(fileAttributions.changedAt))
		.limit(limit);

	// Group by file, newest first (already sorted desc).
	const byFile = new Map<string, FileAttributionSummary>();
	for (const row of rows) {
		let summary = byFile.get(row.filePath);
		if (!summary) {
			summary = {
				filePath: row.filePath,
				lastNarratorId: row.narratorId,
				lastAction: row.action as AttributionAction,
				lastChangedAt: row.changedAt,
				contributorNarratorIds: [],
				hasExternal: false,
				timeline: [],
			};
			byFile.set(row.filePath, summary);
		}

		if (summary.timeline.length < MAX_TIMELINE_PER_FILE) {
			summary.timeline.push({
				id: row.id,
				narratorId: row.narratorId,
				subagentType: row.subagentType as string | null,
				action: row.action as AttributionAction,
				toolName: row.toolName,
				toolUseId: row.toolUseId,
				changedAt: row.changedAt,
			});
		}

		if (row.narratorId) {
			if (!summary.contributorNarratorIds.includes(row.narratorId)) {
				summary.contributorNarratorIds.push(row.narratorId);
			}
		} else if (row.action === "external") {
			summary.hasExternal = true;
		}
	}

	return [...byFile.values()];
}
