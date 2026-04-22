/**
 * Unified status registry — single source of truth for all status/role colors,
 * icons, and i18n keys across the application.
 *
 * Usage:
 *   import { statusRegistry } from "@frontend/lib/status-registry";
 *   const { color, icon, i18nKey } = statusRegistry.chapterStatus("active");
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StatusEntry = {
	color: string;
	icon: string;
	i18nKey: string;
};

type StatusMap<K extends string = string> = Record<K, StatusEntry>;

// ---------------------------------------------------------------------------
// Chapter Status
// ---------------------------------------------------------------------------

export type ChapterStatus = "active" | "dormant" | "merged" | "abandoned" | "frozen";

const chapterStatusMap: StatusMap<ChapterStatus> = {
	active: { color: "green", icon: "●", i18nKey: "status.chapterActive" },
	dormant: { color: "yellow", icon: "◐", i18nKey: "status.chapterDormant" },
	merged: { color: "blue", icon: "✓", i18nKey: "status.chapterMerged" },
	abandoned: { color: "gray", icon: "✗", i18nKey: "status.chapterAbandoned" },
	frozen: { color: "cyan", icon: "❄", i18nKey: "status.chapterFrozen" },
};

// ---------------------------------------------------------------------------
// Chapter Role
// ---------------------------------------------------------------------------

export type ChapterRole = "trunk" | "branch" | "exploration" | "review";

const chapterRoleMap: StatusMap<ChapterRole> = {
	trunk: { color: "indigo", icon: "🏠", i18nKey: "status.roleTrunk" },
	branch: { color: "gray", icon: "", i18nKey: "status.roleBranch" },
	exploration: { color: "violet", icon: "🔬", i18nKey: "status.roleExploration" },
	review: { color: "yellow", icon: "🔍", i18nKey: "status.roleReview" },
};

// ---------------------------------------------------------------------------
// Narrator Status
// ---------------------------------------------------------------------------

export type NarratorStatus = "idle" | "working" | "waiting" | "archived";

const narratorStatusMap: StatusMap<NarratorStatus> = {
	idle: { color: "gray", icon: "○", i18nKey: "status.narratorIdle" },
	working: { color: "blue", icon: "◉", i18nKey: "status.narratorWorking" },
	waiting: { color: "yellow", icon: "◔", i18nKey: "status.narratorWaiting" },
	archived: { color: "dark", icon: "◌", i18nKey: "status.narratorArchived" },
};

// ---------------------------------------------------------------------------
// Narrator Substatus
// ---------------------------------------------------------------------------

export type NarratorSubstatus =
	| "unread"
	| "error"
	| "interrupted"
	| "suspended"
	| "reasoning"
	| "compacting"
	| "checking_interrupt"
	| "planning"
	| "retrying"
	| "queued";

const narratorSubstatusMap: StatusMap<NarratorSubstatus> = {
	unread: { color: "green", icon: "●", i18nKey: "status.narratorUnread" },
	error: { color: "red", icon: "✗", i18nKey: "status.narratorError" },
	interrupted: { color: "orange", icon: "⊘", i18nKey: "status.narratorInterrupted" },
	suspended: { color: "yellow", icon: "◔", i18nKey: "status.narratorSuspended" },
	reasoning: { color: "grape", icon: "◉", i18nKey: "status.narratorReasoning" },
	compacting: { color: "orange", icon: "◉", i18nKey: "status.narratorCompacting" },
	checking_interrupt: { color: "cyan", icon: "◉", i18nKey: "status.narratorCheckingInterrupt" },
	planning: { color: "green", icon: "◉", i18nKey: "status.narratorPlanning" },
	retrying: { color: "yellow", icon: "◔", i18nKey: "status.narratorRetrying" },
	queued: { color: "yellow", icon: "◔", i18nKey: "status.narratorQueued" },
};

/**
 * Resolve the effective display color/icon for a narrator given its status + substatus tags.
 * Substatus tags override the base status color when present, with a defined priority order.
 *
 * NOTE: This handles the full set of substatus tags (including transient ones like
 * reasoning/compacting/queued) for the detailed narrator panel. The Ruler view
 * (server/routes/ruler.ts resolveNarratorDisplayStatus) uses a smaller subset of
 * persistent tags only, since Pixi rendering doesn't need transient state granularity.
 */
export function getEffectiveNarratorDisplay(status: string, substatus?: string[]): StatusEntry {
	if (substatus?.length) {
		// Priority order (highest first)
		const priority: NarratorSubstatus[] = [
			"error",
			"retrying",
			"checking_interrupt",
			"compacting",
			"suspended",
			"reasoning",
			"planning",
			"queued",
			"interrupted",
			"unread",
		];
		for (const tag of priority) {
			if (substatus.includes(tag)) {
				return narratorSubstatusMap[tag];
			}
		}
	}
	return lookup(narratorStatusMap, status);
}

// ---------------------------------------------------------------------------
// Container Status
// ---------------------------------------------------------------------------

export type ContainerStatus = "created" | "running" | "paused" | "stopped" | "removed";

const containerStatusMap: StatusMap<ContainerStatus> = {
	created: { color: "gray", icon: "○", i18nKey: "status.containerCreated" },
	running: { color: "green", icon: "●", i18nKey: "status.containerRunning" },
	paused: { color: "yellow", icon: "◔", i18nKey: "status.containerPaused" },
	stopped: { color: "red", icon: "■", i18nKey: "status.containerStopped" },
	removed: { color: "gray", icon: "✗", i18nKey: "status.containerRemoved" },
};

// ---------------------------------------------------------------------------
// Tool Call Status
// ---------------------------------------------------------------------------

export type ToolCallStatus = "initializing" | "pending" | "running" | "success" | "fail";

const toolCallStatusMap: StatusMap<ToolCallStatus> = {
	initializing: { color: "gray", icon: "○", i18nKey: "status.toolInitializing" },
	pending: { color: "yellow", icon: "◔", i18nKey: "status.toolPending" },
	running: { color: "blue", icon: "◉", i18nKey: "status.toolRunning" },
	success: { color: "green", icon: "✓", i18nKey: "status.toolSuccess" },
	fail: { color: "red", icon: "✗", i18nKey: "status.toolFail" },
};

// ---------------------------------------------------------------------------
// Project Status
// ---------------------------------------------------------------------------

export type ProjectStatus = "active" | "archived";

const projectStatusMap: StatusMap<ProjectStatus> = {
	active: { color: "green", icon: "●", i18nKey: "status.projectActive" },
	archived: { color: "gray", icon: "◌", i18nKey: "status.projectArchived" },
};

// ---------------------------------------------------------------------------
// Edge Type
// ---------------------------------------------------------------------------

export type EdgeType = "fork" | "merge" | "dependency" | "cherry_pick" | "review";

const edgeTypeMap: StatusMap<EdgeType> = {
	fork: { color: "#4c6ef5", icon: "", i18nKey: "status.edgeFork" },
	merge: { color: "#40c057", icon: "", i18nKey: "status.edgeMerge" },
	dependency: { color: "#fd7e14", icon: "", i18nKey: "status.edgeDependency" },
	cherry_pick: { color: "#7950f2", icon: "", i18nKey: "status.edgeCherryPick" },
	review: { color: "#fab005", icon: "", i18nKey: "status.edgeReview" },
};

// ---------------------------------------------------------------------------
// Git File Status
// ---------------------------------------------------------------------------

export type GitFileStatus =
	| "M"
	| "A"
	| "D"
	| "R"
	| "??"
	| "added"
	| "deleted"
	| "modified"
	| "renamed";

const gitFileStatusMap: StatusMap<GitFileStatus> = {
	M: { color: "yellow", icon: "~", i18nKey: "status.gitModified" },
	A: { color: "green", icon: "+", i18nKey: "status.gitAdded" },
	D: { color: "red", icon: "-", i18nKey: "status.gitDeleted" },
	R: { color: "blue", icon: "→", i18nKey: "status.gitRenamed" },
	"??": { color: "gray", icon: "?", i18nKey: "status.gitUntracked" },
	added: { color: "green", icon: "+", i18nKey: "status.gitAdded" },
	deleted: { color: "red", icon: "-", i18nKey: "status.gitDeleted" },
	modified: { color: "yellow", icon: "~", i18nKey: "status.gitModified" },
	renamed: { color: "blue", icon: "→", i18nKey: "status.gitRenamed" },
};

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

const FALLBACK: StatusEntry = { color: "gray", icon: "?", i18nKey: "" };

// ---------------------------------------------------------------------------
// Lookup helper
// ---------------------------------------------------------------------------

function lookup<K extends string>(map: StatusMap<K>, key: string): StatusEntry {
	return (map as Record<string, StatusEntry>)[key] ?? FALLBACK;
}

// ---------------------------------------------------------------------------
// Registry API
// ---------------------------------------------------------------------------

export const statusRegistry = {
	chapterStatus: (s: string) => lookup(chapterStatusMap, s),
	chapterRole: (s: string) => lookup(chapterRoleMap, s),
	narratorStatus: (s: string) => lookup(narratorStatusMap, s),
	narratorSubstatus: (s: string) => lookup(narratorSubstatusMap, s),
	/** Resolve effective display for a narrator given status + substatus tags */
	narratorEffective: getEffectiveNarratorDisplay,
	containerStatus: (s: string) => lookup(containerStatusMap, s),
	toolCallStatus: (s: string) => lookup(toolCallStatusMap, s),
	projectStatus: (s: string) => lookup(projectStatusMap, s),
	edgeType: (s: string) => lookup(edgeTypeMap, s),
	gitFileStatus: (s: string) => lookup(gitFileStatusMap, s),

	/** Raw maps for iteration (e.g. legend rendering) */
	maps: {
		chapterStatus: chapterStatusMap,
		chapterRole: chapterRoleMap,
		narratorStatus: narratorStatusMap,
		narratorSubstatus: narratorSubstatusMap,
		containerStatus: containerStatusMap,
		toolCallStatus: toolCallStatusMap,
		projectStatus: projectStatusMap,
		edgeType: edgeTypeMap,
		gitFileStatus: gitFileStatusMap,
	},
} as const;

// ---------------------------------------------------------------------------
// Backward-compatible color-only maps (re-exported from constants.ts)
// ---------------------------------------------------------------------------

function colorOnly<K extends string>(map: StatusMap<K>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [k, v] of Object.entries(map) as [K, StatusEntry][]) {
		result[k] = v.color;
	}
	return result;
}

export const CHAPTER_STATUS_COLORS = colorOnly(chapterStatusMap);
export const CHAPTER_ROLE_ICONS: Record<string, string> = {
	trunk: chapterRoleMap.trunk.icon,
	branch: chapterRoleMap.branch.icon,
	exploration: chapterRoleMap.exploration.icon,
	review: chapterRoleMap.review.icon,
};
export const NARRATOR_STATUS_COLORS = colorOnly(narratorStatusMap);
export const NARRATOR_SUBSTATUS_COLORS = colorOnly(narratorSubstatusMap);
export const CONTAINER_STATUS_COLORS = colorOnly(containerStatusMap);
export const EDGE_TYPE_COLORS = colorOnly(edgeTypeMap);
export const TOOL_CALL_STATUS_COLORS = colorOnly(toolCallStatusMap);
