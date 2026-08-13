// Includes legacy status values ("done", "error", "interrupted") that may still exist
// in databases not yet migrated to the new status+substatus model.
export const STALE_SESSION_STATUSES = new Set(["idle", "done", "error", "interrupted"]);

export type DatabaseCleanupTarget =
	| "archivedSessions"
	| "staleSessions"
	| "apiRequestDumps"
	| "toolCallPayloads";

export type DatabaseCleanupBlockedReasonCode =
	| "chapterBound"
	| "runningTerminal"
	| "backgroundRunning"
	| "nonArchived"
	| "nonStaleStatus"
	| "recentActivity";

export interface NarratorCleanupRecord {
	id: string;
	parentNarratorId: string | null;
	chapterId: string | null;
	type: string;
	variant: string;
	traits: string[] | null;
	title: string | null;
	status: string;
	messageCount: number;
	createdAt: string;
	updatedAt: string;
	lastMessageAt: string | null;
	isBackground: boolean;
	backgroundStatus: string | null;
}

export interface CleanupPlanRoot {
	rootNarratorId: string;
	rootTitle: string | null;
	rootStatus: string;
	rootMessageCount: number;
	lastActivityAt: string;
	deletedNarratorIds: string[];
	descendantNarratorCount: number;
}

export interface CleanupPlanBlockedRoot {
	narratorId: string;
	title: string | null;
	lastActivityAt: string;
	reasonCode: DatabaseCleanupBlockedReasonCode;
	blockingNarratorId: string;
	blockingTitle: string | null;
	blockingStatus: string;
}

export interface BuildNarratorCleanupPlanOptions {
	staleCutoffIso?: string;
	runningTerminalIds?: Set<string>;
}

export interface NarratorCleanupPlan {
	safeRoots: CleanupPlanRoot[];
	blockedRoots: CleanupPlanBlockedRoot[];
}

interface EligibilityContext {
	staleCutoffIso?: string;
	runningTerminalIds: Set<string>;
}

interface EligibilityResult {
	ok: boolean;
	reasonCode?: DatabaseCleanupBlockedReasonCode;
}

function getEligibilityResult(
	target: Exclude<DatabaseCleanupTarget, "apiRequestDumps">,
	narrator: NarratorCleanupRecord,
	ctx: EligibilityContext,
): EligibilityResult {
	if (narrator.chapterId) {
		return { ok: false, reasonCode: "chapterBound" };
	}
	if (ctx.runningTerminalIds.has(narrator.id)) {
		return { ok: false, reasonCode: "runningTerminal" };
	}
	if (narrator.isBackground && narrator.backgroundStatus === "running") {
		return { ok: false, reasonCode: "backgroundRunning" };
	}
	if (target === "archivedSessions") {
		return narrator.status === "archived" ? { ok: true } : { ok: false, reasonCode: "nonArchived" };
	}
	if (!STALE_SESSION_STATUSES.has(narrator.status)) {
		return { ok: false, reasonCode: "nonStaleStatus" };
	}
	if (ctx.staleCutoffIso && getNarratorLastActivityAt(narrator) > ctx.staleCutoffIso) {
		return { ok: false, reasonCode: "recentActivity" };
	}
	return { ok: true };
}

function collectSubtree(
	root: NarratorCleanupRecord,
	childrenMap: Map<string | null, NarratorCleanupRecord[]>,
): NarratorCleanupRecord[] {
	const result: NarratorCleanupRecord[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		result.push(current);
		const children = childrenMap.get(current.id) ?? [];
		for (let i = children.length - 1; i >= 0; i--) {
			stack.push(children[i]);
		}
	}
	return result;
}

function getDepth(
	narratorId: string,
	byId: Map<string, NarratorCleanupRecord>,
	memo: Map<string, number>,
): number {
	const cached = memo.get(narratorId);
	if (cached != null) return cached;
	const narrator = byId.get(narratorId);
	if (!narrator?.parentNarratorId) {
		memo.set(narratorId, 0);
		return 0;
	}
	const depth = getDepth(narrator.parentNarratorId, byId, memo) + 1;
	memo.set(narratorId, depth);
	return depth;
}

function hasSelectedAncestor(
	narratorId: string,
	selectedRootIds: Set<string>,
	byId: Map<string, NarratorCleanupRecord>,
): boolean {
	let current = byId.get(narratorId)?.parentNarratorId ?? null;
	while (current) {
		if (selectedRootIds.has(current)) return true;
		current = byId.get(current)?.parentNarratorId ?? null;
	}
	return false;
}

function isRootCandidate(
	target: Exclude<DatabaseCleanupTarget, "apiRequestDumps">,
	narrator: NarratorCleanupRecord,
): boolean {
	if (narrator.variant !== "primary") return false;
	if (narrator.chapterId !== null) return false;
	if (target === "archivedSessions") {
		return narrator.status === "archived";
	}
	return STALE_SESSION_STATUSES.has(narrator.status);
}

export function getNarratorLastActivityAt(narrator: NarratorCleanupRecord): string {
	return narrator.lastMessageAt ?? narrator.updatedAt ?? narrator.createdAt;
}

export function buildNarratorCleanupPlan(
	target: Exclude<DatabaseCleanupTarget, "apiRequestDumps">,
	narrators: NarratorCleanupRecord[],
	options: BuildNarratorCleanupPlanOptions = {},
): NarratorCleanupPlan {
	const runningTerminalIds = options.runningTerminalIds ?? new Set<string>();
	const ctx: EligibilityContext = {
		staleCutoffIso: options.staleCutoffIso,
		runningTerminalIds,
	};
	const byId = new Map(narrators.map((n) => [n.id, n]));
	const childrenMap = new Map<string | null, NarratorCleanupRecord[]>();
	for (const narrator of narrators) {
		const siblings = childrenMap.get(narrator.parentNarratorId) ?? [];
		siblings.push(narrator);
		childrenMap.set(narrator.parentNarratorId, siblings);
	}

	const safeRootsRaw: CleanupPlanRoot[] = [];
	const blockedRoots: CleanupPlanBlockedRoot[] = [];

	for (const narrator of narrators) {
		if (!isRootCandidate(target, narrator)) continue;
		const subtree = collectSubtree(narrator, childrenMap);
		const blockingNarrator = subtree.find((item) => !getEligibilityResult(target, item, ctx).ok);
		if (blockingNarrator) {
			const blocking = getEligibilityResult(target, blockingNarrator, ctx);
			blockedRoots.push({
				narratorId: narrator.id,
				title: narrator.title,
				lastActivityAt: getNarratorLastActivityAt(narrator),
				reasonCode: blocking.reasonCode ?? "nonStaleStatus",
				blockingNarratorId: blockingNarrator.id,
				blockingTitle: blockingNarrator.title,
				blockingStatus: blockingNarrator.status,
			});
			continue;
		}
		safeRootsRaw.push({
			rootNarratorId: narrator.id,
			rootTitle: narrator.title,
			rootStatus: narrator.status,
			rootMessageCount: narrator.messageCount,
			lastActivityAt: getNarratorLastActivityAt(narrator),
			deletedNarratorIds: subtree.map((item) => item.id),
			descendantNarratorCount: Math.max(0, subtree.length - 1),
		});
	}

	const depthMemo = new Map<string, number>();
	const orderedSafeRoots = [...safeRootsRaw].sort((a, b) => {
		const depthA = getDepth(a.rootNarratorId, byId, depthMemo);
		const depthB = getDepth(b.rootNarratorId, byId, depthMemo);
		if (depthA !== depthB) return depthA - depthB;
		return a.rootNarratorId.localeCompare(b.rootNarratorId);
	});

	const selectedRootIds = new Set<string>();
	const safeRoots: CleanupPlanRoot[] = [];
	for (const root of orderedSafeRoots) {
		if (hasSelectedAncestor(root.rootNarratorId, selectedRootIds, byId)) continue;
		selectedRootIds.add(root.rootNarratorId);
		safeRoots.push(root);
	}

	const orderedBlockedRoots = blockedRoots.sort((a, b) => {
		if (a.lastActivityAt !== b.lastActivityAt) {
			return a.lastActivityAt.localeCompare(b.lastActivityAt);
		}
		return a.narratorId.localeCompare(b.narratorId);
	});

	return {
		safeRoots,
		blockedRoots: orderedBlockedRoots,
	};
}
