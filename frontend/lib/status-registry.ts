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
	/**
	 * Shade to use when this status is painted as a small solid accent (status
	 * dot, loader, `variant="dot"` badge) instead of as a filled background
	 * behind white text.
	 *
	 * Saturated hues stay legible at Mantine's default step, but a desaturated
	 * neutral like `slate` resolves to a near-background color there (dark
	 * `primaryShade` is 8) and the accent disappears. Leave undefined to keep the
	 * call site's own default step.
	 */
	accentShade?: number;
	/**
	 * Render this status with a filled/solid glyph rather than an outline.
	 *
	 * Surfaces like the sidebar tab icons signal "nothing is happening" with a
	 * hollow shape and "something is happening" with a filled one. A state that is
	 * genuinely occupied — even if the user cannot act on it — must be filled, or
	 * it stays indistinguishable from idle however the hue is tuned.
	 */
	solidAccent?: boolean;
	/**
	 * The SHAPE a surface should draw for this state, when it can draw one.
	 *
	 * ── WHY SHAPE AND NOT JUST COLOUR ─────────────────────────────────────────
	 * The narrator palette ran out of usable hues. Measured hue distances: teal sits
	 * only 31° from green (success) and 46° from blue (working); cyan is 21° from blue;
	 * violet 27° from indigo; pink 21° from red. Every remaining slot collides with a
	 * state it has to be told apart from, so adding one more colour could not fix
	 * anything — two states that matter were always going to look alike.
	 *
	 * Shape carries the distinction alongside colour: reflecting uses an indigo shield
	 * for automated self-review; yellow/orange alerts signal user attention.
	 *
	 * ⚠️ NOT the `icon` field above. That one holds Unicode glyphs (`◉` / `◔` / …) which
	 * NOTHING renders — every consumer reads only `color` / `solidAccent`. Rather than
	 * revive a dead field with a second meaning, `shape` is a small closed vocabulary the
	 * drawing surfaces map to their own icon sets (Tabler in React, geometry in Pixi).
	 * Leave it undefined for states with no special shape; the surface keeps its default.
	 */
	shape?: StatusShape;
};

/**
 * The closed vocabulary of status shapes.
 *
 * Deliberately semantic rather than pictorial: a surface picks its own glyph, so the
 * sidebar can use Tabler's filled check while the Pixi ruler draws geometry, without
 * either one hard-coding the mapping twice.
 */
export type StatusShape =
	/** Finished as intended — the reader needs nothing from this. */
	| "check"
	/** A reflection gate is deliberating; the reader MAY intervene (approve/reject/take over). */
	| "shield"
	/** Blocked on the reader — nothing proceeds until they act. */
	| "alert";

type StatusMap<K extends string = string> = Record<K, StatusEntry>;

/**
 * The subset of {@link StatusEntry} the accent helpers need, so callers that
 * carry a color + shade without the icon/i18n fields (e.g. the narrator status
 * bar's derived display) can use them too.
 */
export type StatusAccent = Pick<StatusEntry, "color" | "accentShade">;

// ---------------------------------------------------------------------------
// Chapter Status
// ---------------------------------------------------------------------------

/**
 * `frozen` is kept on the display side only.
 *
 * The server stopped producing it (see the note on `chapters.status` in
 * `server/db/schema.ts`), but this map is what renders a status badge, and a
 * missing entry would throw on any row that still carries the old value — from a
 * project database written by an older build, for instance. Rendering it costs
 * one line; crashing the graph on unexpected data costs a lot more.
 */
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
	/**
	 * Blocked on the user — a permission prompt or a question. `alert` because nothing
	 * proceeds until they act, which is precisely what distinguishes this from the other
	 * waiting-ish substatuses below (`retrying` / `queued` / `model_unavailable` all wait
	 * on the MACHINE and deliberately keep the default shape).
	 */
	waiting: { color: "yellow", icon: "◔", i18nKey: "status.narratorWaiting", shape: "alert" },
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
	| "manual_override"
	| "taken_over"
	| "reflecting"
	| "reasoning"
	| "compacting"
	| "background_compacting"
	| "planning"
	| "retrying"
	| "queued"
	| "model_unavailable"
	| "quota_exhausted";

const narratorSubstatusMap: StatusMap<NarratorSubstatus> = {
	/**
	 * A finished turn the reader has not seen yet. `check` because the work COMPLETED —
	 * this is the only narrator state that reports a finished result, so it owns the tick.
	 */
	unread: { color: "green", icon: "●", i18nKey: "status.narratorUnread", shape: "check" },
	error: { color: "red", icon: "✗", i18nKey: "status.narratorError" },
	interrupted: { color: "orange", icon: "⊘", i18nKey: "status.narratorInterrupted" },
	suspended: { color: "yellow", icon: "◔", i18nKey: "status.narratorSuspended" },
	manual_override: { color: "orange", icon: "◔", i18nKey: "status.narratorManualOverride" },
	taken_over: { color: "grape", icon: "◉", i18nKey: "status.narratorTakenOver" },
	/** Automated self-review: distinct from yellow/orange user-attention states. */
	reflecting: {
		color: "indigo",
		icon: "◉",
		i18nKey: "status.narratorReflecting",
		solidAccent: true,
		shape: "shield",
	},
	reasoning: { color: "grape", icon: "◉", i18nKey: "status.narratorReasoning" },
	compacting: { color: "orange", icon: "◉", i18nKey: "status.narratorCompacting" },
	background_compacting: {
		color: "orange",
		icon: "◐",
		i18nKey: "status.narratorBackgroundCompacting",
	},
	planning: { color: "green", icon: "◉", i18nKey: "status.narratorPlanning" },
	retrying: { color: "yellow", icon: "◔", i18nKey: "status.narratorRetrying" },
	queued: { color: "yellow", icon: "◔", i18nKey: "status.narratorQueued" },
	/*
	 * Parked until an unavailable model recovers. Deliberately NOT yellow/orange:
	 * the user has nothing to act on, so it must not read as "needs attention".
	 * `slate` is the blue-toned neutral registered in the app theme; shade 5 is
	 * the tuned accent step that separates it from idle gray without looking like
	 * an actively working narrator (see the palette comment in main.tsx).
	 *
	 * `solidAccent` matters as much as the hue: several surfaces distinguish idle
	 * from busy by outline-vs-filled glyph, so a hollow blue-gray dot still reads
	 * as idle no matter how the color is tuned.
	 */
	model_unavailable: {
		color: "slate",
		icon: "◉",
		i18nKey: "status.narratorModelUnavailable",
		accentShade: 5,
		solidAccent: true,
	},
	/*
	 * Parked until an exhausted Kimi quota window resets. Same reasoning as
	 * `model_unavailable` above — the machine is waiting, the user has nothing to
	 * unblock — and deliberately the same palette, because the two are one situation
	 * (a self-recovering block) seen from two causes. Only the label differs, so a
	 * reader can tell "the model is out" from "the allowance is spent".
	 */
	quota_exhausted: {
		color: "slate",
		icon: "◉",
		i18nKey: "status.narratorQuotaExhausted",
		accentShade: 5,
		solidAccent: true,
	},
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
			// The actual reason the turn is stalled, so it outranks secondary
			// bookkeeping tags (compacting/queued) but yields to error/retrying,
			// which describe a more specific failure. `quota_exhausted` sits beside
			// `model_unavailable` for the same reason: both name why the turn cannot
			// proceed.
			"model_unavailable",
			"quota_exhausted",
			"compacting",
			"background_compacting",
			"suspended",
			"taken_over",
			"manual_override",
			"reflecting",
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

/**
 * Build a Mantine `color` prop for a status painted as a small solid accent
 * (status dot, loader, `variant="dot"` badge).
 *
 * Returns `"slate.5"`-style shorthand when the entry pins an accent shade, and
 * the bare color name otherwise so existing call sites keep their own default.
 */
export function statusAccentColor(entry: StatusAccent): string {
	return entry.accentShade === undefined ? entry.color : `${entry.color}.${entry.accentShade}`;
}

/**
 * Same as {@link statusAccentColor} but as a raw CSS variable, for call sites
 * that build a `background`/`color` string instead of passing a Mantine prop.
 *
 * `fallbackShade` is the step to use when the entry does not pin one — pass
 * whatever the call site already hardcoded so its appearance is unchanged.
 */
export function statusAccentVar(entry: StatusAccent, fallbackShade: number | "filled"): string {
	return `var(--mantine-color-${entry.color}-${entry.accentShade ?? fallbackShade})`;
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

export type ToolCallStatus =
	| "initializing"
	| "pending"
	| "running"
	| "success"
	| "fail"
	| "cancelled";

const toolCallStatusMap: StatusMap<ToolCallStatus> = {
	initializing: { color: "gray", icon: "○", i18nKey: "status.toolInitializing" },
	pending: { color: "yellow", icon: "◔", i18nKey: "status.toolPending" },
	running: { color: "blue", icon: "◉", i18nKey: "status.toolRunning" },
	success: { color: "green", icon: "✓", i18nKey: "status.toolSuccess" },
	fail: { color: "red", icon: "✗", i18nKey: "status.toolFail" },
	cancelled: { color: "orange", icon: "⊘", i18nKey: "status.toolCancelled" },
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

/**
 * Every edge type that can REACH the canvas, which is the full `chapter_edges.type` enum —
 * including the two nothing creates any more.
 *
 * `dependency` edges were user-drawn and the feature was removed; `cherry_pick` edges were
 * never created by anything. Both stay here because rows of either kind may still sit in an
 * existing database, and a graph that cannot colour a row it loaded would render a default
 * grey line instead of a labelled one.
 *
 * ⚠️ Wider than {@link QueryableEdgeType}: this is a DISPLAY vocabulary, not a request one.
 */
export type EdgeType = "fork" | "merge" | "dependency" | "cherry_pick" | "review";

/**
 * The subset `GET /api/chapter-edges?type=` accepts.
 *
 * The route validates against exactly these three (the types operations still produce) and
 * answers anything else with a 400 — so passing a display-only type from {@link EdgeType} to
 * a query is a request error, not an empty result. Kept as its own type so that mistake is a
 * compile error at the call site rather than a runtime 400.
 */
export type QueryableEdgeType = "fork" | "merge" | "review";

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
	| "C"
	| "U"
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
	C: { color: "blue", icon: "⧉", i18nKey: "status.gitCopied" },
	// A merge conflict needs its own colour: it is the one status that blocks a
	// commit, so it must not read as an ordinary edit.
	U: { color: "orange", icon: "!", i18nKey: "status.gitUnmerged" },
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
	/** Mantine `color` prop for a status rendered as a small solid accent */
	accentColor: statusAccentColor,
	/** Raw CSS variable for a status rendered as a small solid accent */
	accentVar: statusAccentVar,
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
