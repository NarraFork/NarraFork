/**
 * What a NESTED subagent's events must also send to its ACL root's page.
 *
 * A subagent's events are addressed to its parent's page (the card that launched it) and
 * to its own page (`narrator-dual-broadcast`). For a first-level subagent the parent IS
 * the primary narrator. A second-level helper's parent is a first-level subagent, so the
 * people watching the primary — the ones who approve its work, since approval is "write
 * access on the ACL root" — would never see the helper's permission requests or know it
 * is waiting on them. This module remembers which subagents are nested, under which
 * parent and root, and sends the root page:
 *
 * - every permission and reflection frame of a nested helper, unchanged (they keep
 *   `subagentNarratorId` / `ownerNarratorId`, so the root page knows whose request it is,
 *   and the decision route still checks write access on the owner's root);
 * - `subagent_nested_changed` whenever a helper starts or changes status (asking for a
 *   permission is a status change), coalesced per first-level subagent, so its card on
 *   the root page lists the helpers live.
 *
 * The registry is filled where a nested subagent is created, where one runs and where its
 * permission gates load its row (which also covers rows created before a restart). It
 * holds one short id triple per nested subagent.
 */
import { eventBus } from "../lib/event-bus";
import { hotOnce, hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import type { NarratorServerMessage } from "../websocket/narrator-ws-types";

interface NestedPlacement {
	/** The first-level subagent that launched the helper. */
	parentId: string;
	/** The ACL root (the primary narrator) whose page watches the whole tree. */
	rootId: string;
}

const nested = hotSafe(
	"narrafork.nestedSubagentPlacements",
	() => new Map<string, NestedPlacement>(),
);
const scheduledRefresh = hotSafe(
	"narrafork.nestedSubagentRefresh",
	() => new Map<string, ReturnType<typeof setTimeout>>(),
);

/** Coalescing window for a burst of helper status changes under one card. */
const NESTED_REFRESH_DELAY_MS = 250;

/**
 * Record a subagent's placement when it is nested (its ACL root is not its parent). A
 * first-level subagent, whose parent is the root, is never recorded. A newly recorded
 * helper refreshes its parent's card on the root page.
 */
export function rememberNestedSubagentRoot(row: {
	id: string;
	type?: string | null;
	parentNarratorId?: string | null;
	aclRootNarratorId?: string | null;
}): void {
	if (
		row.type !== "subagent" ||
		!row.aclRootNarratorId ||
		!row.parentNarratorId ||
		row.aclRootNarratorId === row.parentNarratorId ||
		row.aclRootNarratorId === row.id
	)
		return;
	const known = nested.get(row.id);
	if (known?.parentId === row.parentNarratorId && known.rootId === row.aclRootNarratorId) return;
	nested.set(row.id, { parentId: row.parentNarratorId, rootId: row.aclRootNarratorId });
	ensureStatusListener();
	scheduleNestedRefresh(row.parentNarratorId, row.aclRootNarratorId);
}

/** The ACL root page a nested subagent's frames also go to; undefined when not nested. */
export function nestedSubagentRootOf(subagentId: string): string | undefined {
	return nested.get(subagentId)?.rootId;
}

/** Tests only. */
export function resetNestedSubagentRoots(): void {
	nested.clear();
	for (const timer of scheduledRefresh.values()) clearTimeout(timer);
	scheduledRefresh.clear();
}

/**
 * Send a permission frame to its usual target and, for a nested subagent's request, the
 * same frame to the ACL root's page (re-addressed with the root's `narratorId`).
 */
export function broadcastPermissionFrame(
	ownerNarratorId: string,
	targetId: string,
	frame: NarratorServerMessage,
): void {
	broadcastToNarrator(targetId, frame);
	const root = nestedSubagentRootOf(ownerNarratorId);
	if (root && root !== targetId)
		broadcastToNarrator(root, { ...frame, narratorId: root } as NarratorServerMessage);
}

function ensureStatusListener(): void {
	if (!hotOnce("narrafork.nestedSubagentStatusListener")) return;
	eventBus.on("narrator:status_changed", (event) => {
		const placement = nested.get(event.narratorId);
		if (!placement) return;
		scheduleNestedRefresh(placement.parentId, placement.rootId);
		// An archived helper runs no more gates; it is re-learned if it is ever unarchived
		// and runs again (orchestrator registration).
		if (event.status === "archived") nested.delete(event.narratorId);
	});
	eventBus.on("narrator:deleted", (event) => {
		const placement = nested.get(event.narratorId);
		if (!placement) return;
		nested.delete(event.narratorId);
		scheduleNestedRefresh(placement.parentId, placement.rootId);
	});
}

/** Tests only: how many nested subagents are remembered. */
export function nestedSubagentCount(): number {
	return nested.size;
}

function scheduleNestedRefresh(parentId: string, rootId: string): void {
	if (scheduledRefresh.has(parentId)) return;
	const timer = setTimeout(() => {
		scheduledRefresh.delete(parentId);
		void publishNestedSummary(parentId, rootId);
	}, NESTED_REFRESH_DELAY_MS);
	timer.unref?.();
	scheduledRefresh.set(parentId, timer);
}

/** Read the first-level subagent's helper rows and send them to the root page. */
export async function publishNestedSummary(parentId: string, rootId: string): Promise<void> {
	try {
		const [{ loadNestedSubagentSummaries }, { resolveSpawningToolUseId }] = await Promise.all([
			import("./subagent-nested"),
			import("./subagent-takeover-broadcast"),
		]);
		const [summaries, toolUseId] = await Promise.all([
			loadNestedSubagentSummaries([parentId]),
			resolveSpawningToolUseId(parentId),
		]);
		broadcastToNarrator(rootId, {
			type: "subagent_nested_changed",
			narratorId: rootId,
			subagentNarratorId: parentId,
			...(toolUseId ? { toolUseId } : {}),
			nested: summaries.get(parentId) ?? { agents: [], total: 0 },
		});
	} catch (error) {
		// Display only: the next page load reads the same rows from the activity snapshot.
		logger.debug("Nested subagent summary not published", {
			parentId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
