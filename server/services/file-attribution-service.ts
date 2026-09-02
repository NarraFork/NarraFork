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
import { eq } from "drizzle-orm";
import { db } from "../db";
import { fileAttributions, narrators } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { normalizeWorkspacePath } from "./git-workspace";

export type AttributionAction = "write" | "edit" | "bash" | "external" | "human";

export interface RecordAttributionInput {
	/** Target device. Omitted only by legacy/local callers. */
	deviceId?: string;
	/** Local workspace path, or an already-normalized remote target workspace/path scope. */
	workspacePath: string;
	/** Local repo-relative path, or normalized absolute target path for remote tools. */
	filePath: string;
	/** Narrator that made the change; omit for external edits. */
	narratorId?: string | null;
	/**
	 * User who made the change. Set only for `action: "human"`.
	 *
	 * A human edit carries no `narratorId` (a person is not a session), so without this
	 * a shared worktree cannot tell two people's saves apart.
	 */
	userId?: string | null;
	/** Subagent type, if known (avoids an extra lookup). */
	subagentType?: string | null;
	action: AttributionAction;
	toolName?: string | null;
	toolUseId?: string | null;
	/**
	 * Lines added / removed by this change, when the tool measured them.
	 *
	 * Omit (or pass null) when unknown — Bash cannot attribute a line delta per
	 * file, a binary write has none, and a diff may exceed its compute budget. The
	 * column then stays NULL, which readers report as "not measured" rather than
	 * folding into a total as zero. Never pass 0 to mean "unknown".
	 */
	lineStats?: { added: number; removed: number } | null;
}

// ── Recently AI-attributed paths (in-memory) ─────────────────────────────────
//
// The worktree watcher fires on ANY file change, including terminal / external
// editor edits. To attribute those as "external" without misclassifying changes
// the AI tools just made, the tool path marks paths here. The watcher consults
// this in-memory map (no DB query in the hot path) and only records the
// remainder as external.

/** device + workspace key → (filePath → epoch ms of last AI attribution). */
const recentlyAttributed = new Map<string, Map<string, number>>();

function normalizeAttributionWorkspace(deviceId: string, workspacePath: string): string {
	return deviceId === LOCAL_DEVICE_ID ? normalizeWorkspacePath(workspacePath) : workspacePath;
}

function attributionWorkspaceKey(deviceId: string, workspacePath: string): string {
	return `${deviceId}\0${normalizeAttributionWorkspace(deviceId, workspacePath)}`;
}

/** How long an AI attribution "shadows" a path from external classification. */
const RECENT_ATTRIBUTION_TTL_MS = 15_000;

/**
 * Writes between full sweeps.
 *
 * Entries expired lazily on READ only, which cleaned up whatever the watcher happened to
 * ask about and nothing else: a path written once and never looked at again, or a whole
 * workspace that went away, stayed for the process's lifetime. Every tool call that touches
 * a file adds to this, so over a long-running server it is a slow leak of dead path strings.
 *
 * A sweep is O(tracked paths) and the TTL is 15 s, so amortizing it over this many writes
 * keeps it off the hot path while ensuring it happens often enough that nothing accumulates
 * far beyond one window's worth of real activity. The count is a cheap proxy for "enough has
 * happened to be worth looking"; correctness never depends on when a sweep runs, because
 * {@link wasRecentlyAttributed} re-checks the timestamp regardless.
 */
const ATTRIBUTION_SWEEP_INTERVAL_WRITES = 512;

let writesSinceSweep = 0;

/**
 * Drop every expired entry, and every workspace left holding none.
 *
 * The inner maps are removed too, not just emptied: the outer key is
 * `deviceId + workspacePath`, so a destroyed worktree leaves a map that will never be read
 * again, and an empty `Map` object per dead workspace is exactly the kind of residue the
 * lazy path could not reach.
 */
function sweepRecentlyAttributed(now: number): void {
	for (const [key, map] of recentlyAttributed) {
		for (const [filePath, ts] of map) {
			if (now - ts > RECENT_ATTRIBUTION_TTL_MS) map.delete(filePath);
		}
		if (map.size === 0) recentlyAttributed.delete(key);
	}
}

/** Mark file paths as recently attributed to an AI tool for `workspacePath`. */
export function markRecentlyAttributed(
	workspacePath: string,
	filePaths: string[],
	deviceId = LOCAL_DEVICE_ID,
): void {
	const key = attributionWorkspaceKey(deviceId, workspacePath);
	let map = recentlyAttributed.get(key);
	if (!map) {
		map = new Map();
		recentlyAttributed.set(key, map);
	}
	const now = Date.now();
	for (const fp of filePaths) {
		map.set(fp, now);
	}

	// Swept here rather than on a timer: a timer would keep the process's event loop busy
	// for a structure that only grows when something writes to it, and would go on firing
	// long after the last tool call.
	writesSinceSweep += filePaths.length;
	if (writesSinceSweep >= ATTRIBUTION_SWEEP_INTERVAL_WRITES) {
		writesSinceSweep = 0;
		sweepRecentlyAttributed(now);
	}
}

/**
 * Forget every recorded path for a workspace.
 *
 * Called when a worktree is destroyed, for the same reason `dropStatus` is: once the
 * directory is gone nothing will ever query these paths, so keeping them is pure residue.
 * Cheap and exact, where the periodic sweep is amortized and TTL-driven.
 */
export function dropRecentlyAttributed(workspacePath: string, deviceId = LOCAL_DEVICE_ID): void {
	recentlyAttributed.delete(attributionWorkspaceKey(deviceId, workspacePath));
}

/** Tracked (workspace, path) pair count. Tests assert the sweep actually reclaims. */
export function recentlyAttributedSize(): { workspaces: number; paths: number } {
	let paths = 0;
	for (const map of recentlyAttributed.values()) paths += map.size;
	return { workspaces: recentlyAttributed.size, paths };
}

/**
 * Reset the in-memory shadow map, and optionally back-date every entry (tests only).
 *
 * `ageBy` exists so the reclaim behaviour can be tested without sleeping out a 15 s TTL.
 * Shifting the stored timestamps into the past is equivalent to time passing, from the
 * point of view of every reader — both the lazy check and the sweep compare against
 * `Date.now()` — while keeping the test instant.
 */
export const recentlyAttributedTesting = {
	clear(): void {
		recentlyAttributed.clear();
		writesSinceSweep = 0;
	},
	/** Move every recorded timestamp `ms` further into the past. */
	ageBy(ms: number): void {
		for (const map of recentlyAttributed.values()) {
			for (const [filePath, ts] of map) map.set(filePath, ts - ms);
		}
	},
	/** Writes still needed to trip the next sweep. */
	writesUntilSweep(): number {
		return ATTRIBUTION_SWEEP_INTERVAL_WRITES - writesSinceSweep;
	},
};

/** The sweep interval, exported so a test cannot drift from the value it drives. */
export const RECENT_ATTRIBUTION_SWEEP_WRITES = ATTRIBUTION_SWEEP_INTERVAL_WRITES;
/** The TTL, exported for the same reason. */
export const RECENT_ATTRIBUTION_WINDOW_MS = RECENT_ATTRIBUTION_TTL_MS;

/**
 * Return true if `filePath` was attributed to an AI tool within the TTL window.
 * Expired entries are pruned as a side effect.
 */
export function wasRecentlyAttributed(
	workspacePath: string,
	filePath: string,
	deviceId = LOCAL_DEVICE_ID,
): boolean {
	const key = attributionWorkspaceKey(deviceId, workspacePath);
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
		const deviceId = input.deviceId ?? LOCAL_DEVICE_ID;
		const workspacePath = normalizeAttributionWorkspace(deviceId, input.workspacePath);

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
			deviceId,
			workspacePath,
			filePath: input.filePath,
			narratorId: input.narratorId ?? null,
			userId: input.userId ?? null,
			subagentType,
			action: input.action,
			toolName: input.toolName ?? null,
			toolUseId: input.toolUseId ?? null,
			linesAdded: input.lineStats?.added ?? null,
			linesRemoved: input.lineStats?.removed ?? null,
			changedAt: new Date().toISOString(),
		});

		// Shadow this path from external classification by the watcher.
		if (input.action !== "external") {
			markRecentlyAttributed(workspacePath, [input.filePath], deviceId);
		}
	} catch (err) {
		logger.debug("Failed to record file attribution", {
			workspacePath: input.workspacePath,
			filePath: input.filePath,
			error: String(err),
		});
	}
}

/** Record attributions for multiple files (e.g. Bash touched several).
 *
 * Batched into a single INSERT for efficiency: a Bash command touching 50+ files
 * used to produce 50 sequential round-trips. The semantics are identical to calling
 * recordAttribution per file — every call is an unconditional insert (no first-write
 * dedup), and the subagentType lookup only needs to happen once since the narrator
 * is the same across all paths.
 */
export async function recordAttributions(
	base: Omit<RecordAttributionInput, "filePath">,
	filePaths: string[],
): Promise<void> {
	if (filePaths.length === 0) return;
	try {
		const deviceId = base.deviceId ?? LOCAL_DEVICE_ID;
		const workspacePath = normalizeAttributionWorkspace(deviceId, base.workspacePath);

		// Resolve subagentType once for the shared narrator.
		let subagentType = base.subagentType ?? null;
		if (base.narratorId && subagentType == null) {
			const n = await db.query.narrators.findFirst({
				where: eq(narrators.id, base.narratorId),
				columns: { type: true, subagentType: true },
			});
			if (n?.type === "subagent") {
				subagentType = n.subagentType ?? "subagent";
			}
		}

		const now = new Date().toISOString();
		const values = filePaths.map((filePath) => ({
			id: generateId(),
			deviceId,
			workspacePath,
			filePath,
			narratorId: base.narratorId ?? null,
			subagentType,
			action: base.action,
			toolName: base.toolName ?? null,
			toolUseId: base.toolUseId ?? null,
			// A batch shares ONE line-stat value, which in practice means null: the only
			// batch caller is Bash (it touched several files and cannot attribute a line
			// delta to any single one). Threaded through rather than hard-coded null so a
			// future caller that does know per-batch figures is not silently dropped.
			linesAdded: base.lineStats?.added ?? null,
			linesRemoved: base.lineStats?.removed ?? null,
			changedAt: now,
		}));

		await db.insert(fileAttributions).values(values);

		// Shadow all paths from external classification by the watcher.
		if (base.action !== "external") {
			markRecentlyAttributed(workspacePath, filePaths, deviceId);
		}
	} catch (err) {
		logger.debug("Failed to record batch file attributions", {
			workspacePath: base.workspacePath,
			fileCount: filePaths.length,
			error: String(err),
		});
	}
}

// Reading attributions back lives in `attribution-actors.ts` (actor resolution) and
// `workspace-modification-view.ts` (the queries that consume it). This module is the write
// path only: the tool chain and the worktree watcher record here.
