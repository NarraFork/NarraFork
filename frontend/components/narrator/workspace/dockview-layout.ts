/**
 * Workspace ARRANGEMENT persistence for the Dockview-based workspace.
 *
 * The workspace row stores a JSON string in `workspaces.tree`: Dockview's native
 * `SerializedDockview` wrapped in a small versioned envelope that also carries
 * NarraFork's presentation state (director mode).
 *
 * It records POSITIONS only. Which panels a workspace contains is membership, owned by
 * `workspace_panels` and delivered separately — so a blob that is missing, stale or
 * corrupt costs an arrangement and never a panel. Reading legacy shapes (split-tree,
 * seed envelope) to recover MEMBERSHIP is the server's job, done once in
 * `recoverPanelsFromLayout`; this module only reads the seed envelope's PLACEMENT
 * (created before any DockviewApi existed) so a freshly created workspace opens with
 * the split the user dragged, and never migrates membership itself.
 */

import type { Direction, DockviewApi, SerializedDockview } from "dockview-react";
import {
	isSeedEnvelope,
	type SeedEnvelope,
	type PanelSpec as SharedPanelSpec,
	stripNavigationFromLayout,
} from "../panels/layout-envelope";
import {
	DEFAULT_DIRECTOR_PRIMARY_RATIO,
	normalizeDirectorPrimaryRatio,
} from "./director-constants";
import { PANEL_COMPONENT, type WorkspacePanelParams } from "./panel-types";

/** Current envelope schema version. */
export const WORKSPACE_LAYOUT_VERSION = 2 as const;

export type WorkspaceDirectorState = {
	mode: "grid" | "director";
	/** Panel id promoted to primary in director mode. */
	primaryPanelId: string | null;
	/** Primary panel's share of the surface in director mode (0.55–0.85). */
	primaryRatio: number;
};

export const DEFAULT_DIRECTOR_STATE: WorkspaceDirectorState = {
	mode: "grid",
	primaryPanelId: null,
	primaryRatio: DEFAULT_DIRECTOR_PRIMARY_RATIO,
};

/** Versioned envelope persisted to `workspaces.tree`. */
export interface WorkspaceLayoutEnvelope {
	version: typeof WORKSPACE_LAYOUT_VERSION;
	kind: "dockview";
	layout: SerializedDockview;
	director: WorkspaceDirectorState;
}

/** A panel to (re)create when there is no valid Dockview layout to restore. */
export type PanelSpec = SharedPanelSpec<WorkspacePanelParams>;

/** A workspace seed envelope (api-free initial layout, e.g. from a sidebar drag). */
export type WorkspaceSeedEnvelope = SeedEnvelope<WorkspacePanelParams>;

/**
 * Result of resolving a stored tree string.
 *
 * `none` means "no usable arrangement", NOT "no panels": membership is a separate,
 * authoritative input, so this outcome still renders every panel — just at default
 * positions. The old `panels` variant (a client-side legacy migration) is gone; see
 * `resolveWorkspaceLayout`.
 *
 * `seed` carries an api-free initial layout (written at workspace creation, before
 * any DockviewApi existed): the caller materialises it via `addPanel` honouring each
 * spec's `placement`, instead of collapsing every member into one tab group.
 */
export type ResolvedLayout =
	| { kind: "dockview"; layout: SerializedDockview; director: WorkspaceDirectorState }
	| { kind: "seed"; specs: PanelSpec[]; director: WorkspaceDirectorState }
	| { kind: "none"; director: WorkspaceDirectorState };

// ── Seed construction ──

/**
 * Build a workspace seed that places two narrator panels side by side (or
 * stacked). Used by the sidebar / narrator page when a drag creates a fresh
 * workspace before any DockviewApi exists — replaces emitting a legacy
 * split-tree that the workspace then had to migrate on read.
 */
export function twoNarratorWorkspaceSeed(
	firstNarratorId: string,
	secondNarratorId: string,
	direction: Direction,
): WorkspaceSeedEnvelope {
	const firstId = nextWorkspacePanelId();
	const secondId = nextWorkspacePanelId();
	return {
		kind: "seed",
		seed: [
			{
				id: firstId,
				params: { panelType: "narrator", narratorId: firstNarratorId },
				title: "Narrator",
				placement: { kind: "first" },
			},
			{
				id: secondId,
				params: { panelType: "narrator", narratorId: secondNarratorId },
				title: "Narrator",
				placement: { kind: "relative", referenceId: firstId, direction },
			},
		],
	};
}

// ── Serialization ──

/** Serialize the current Dockview layout + director state into the envelope string. */
export function serializeWorkspaceLayout(
	api: DockviewApi,
	director: WorkspaceDirectorState,
): string {
	const envelope: WorkspaceLayoutEnvelope = {
		version: WORKSPACE_LAYOUT_VERSION,
		kind: "dockview",
		layout: stripNavigationFromLayout(api.toJSON()),
		director,
	};
	return JSON.stringify(envelope);
}

// ── Resolution / migration ──

/** Type guard: does this parsed value look like a Dockview envelope? */
function isDockviewEnvelope(value: unknown): value is WorkspaceLayoutEnvelope {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return v.kind === "dockview" && !!v.layout && typeof v.layout === "object";
}

/** Type guard: does this look like a raw SerializedDockview (grid + panels)? */
function isSerializedDockview(value: unknown): value is SerializedDockview {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return !!v.grid && typeof v.grid === "object" && !!v.panels && typeof v.panels === "object";
}

/**
 * Resolve a stored tree string into a restorable ARRANGEMENT.
 *
 * Returns only what the layout blob legitimately carries now: a dockview layout to
 * position panels with, plus director presentation state. It no longer materialises a
 * panel LIST from legacy shapes (split-tree, seed envelope) — membership comes from
 * `workspace_panels`, and the server's `recoverPanelsFromLayout` is what reads those
 * legacy shapes, once, to backfill rows.
 *
 * Keeping a client-side legacy→panels path would have required inventing membership row
 * ids on the client, which is precisely what `panelRowId` exists to prevent.
 *
 * Order of precedence:
 *   1. Dockview envelope (current format) → restore verbatim.
 *   2. Raw SerializedDockview (defensive) → wrap with default director state.
 *   3. Seed envelope (api-free initial layout from workspace creation) → carried
 *      through as specs; the caller materialises the placement via `addPanel`.
 *      Membership still comes from `workspace_panels` — the seed only says WHERE
 *      the panels sit, matching the dockview branch's arrangement-only role.
 *   4. Anything else (legacy split-tree, corrupt) → no arrangement;
 *      the caller places every member at a default position.
 */
export function resolveWorkspaceLayout(treeJson: string | null | undefined): ResolvedLayout {
	if (treeJson) {
		try {
			const parsed = JSON.parse(treeJson);
			if (isDockviewEnvelope(parsed)) {
				return {
					kind: "dockview",
					layout: parsed.layout,
					director: normalizeDirector(parsed.director),
				};
			}
			if (isSerializedDockview(parsed)) {
				return { kind: "dockview", layout: parsed, director: DEFAULT_DIRECTOR_STATE };
			}
			if (isSeedEnvelope(parsed)) {
				return {
					kind: "seed",
					specs: (parsed as WorkspaceSeedEnvelope).seed,
					director: DEFAULT_DIRECTOR_STATE,
				};
			}
		} catch {
			// fall through to "no arrangement"
		}
	}

	// No usable arrangement. Membership still renders in full, at default positions.
	return { kind: "none", director: DEFAULT_DIRECTOR_STATE };
}

function normalizeDirector(value: unknown): WorkspaceDirectorState {
	if (!value || typeof value !== "object") return { ...DEFAULT_DIRECTOR_STATE };
	const v = value as Record<string, unknown>;
	return {
		mode: v.mode === "director" ? "director" : "grid",
		primaryPanelId: typeof v.primaryPanelId === "string" ? v.primaryPanelId : null,
		primaryRatio:
			typeof v.primaryRatio === "number"
				? normalizeDirectorPrimaryRatio(v.primaryRatio)
				: DEFAULT_DIRECTOR_PRIMARY_RATIO,
	};
}

// Monotonic counter appended to every generated panel id so ids never collide
// even when several are created within the same millisecond (Date.now() alone
// is not enough — two panels added back-to-back would otherwise share a base).
let panelIdCounter = 0;

/** Generate a unique dockview panel id (collision-proof within a session). */
export function nextWorkspacePanelId(): string {
	panelIdCounter += 1;
	return `dvp_${Date.now().toString(36)}_${panelIdCounter.toString(36)}`;
}

// ── Removed: client-side legacy migration ──
//
// `leafToParams` / `migrateLegacyTree` / `applyResolvedLayout` turned a legacy
// split-tree into a panel list and added those panels directly. All three are gone:
//
//   - Membership is server-owned, and `recoverPanelsFromLayout`
//     (`server/services/workspace-panel-service.ts`) already reads every legacy shape
//     — split-tree, seed envelope, raw dockview — once, to backfill rows. Migrating
//     again on the client produced panels with no membership row, which the surface
//     then pruned on the next open and closed in the meantime.
//   - Doing it here now requires inventing a `panelRowId` for terminal/webview panels,
//     which is exactly what that required field exists to make impossible.
//
// The arrangement-only remnant of this path is `resolveWorkspaceLayout` returning
// `kind: "none"`, after which the caller places every member at a default position.

/** Map panel params to the registered Dockview component name. */
export function componentForParams(params: WorkspacePanelParams): string {
	switch (params.panelType) {
		case "terminal":
			return PANEL_COMPONENT.terminal;
		case "webview":
			return PANEL_COMPONENT.webview;
		case "narrator-tool":
			return PANEL_COMPONENT.narratorTool;
		case "subagent":
			return PANEL_COMPONENT.subagent;
		case "file":
			return PANEL_COMPONENT.file;
		case "plugin":
			return PANEL_COMPONENT.plugin;
		default:
			return PANEL_COMPONENT.narrator;
	}
}

// ── Removed: collectNarratorIdsFromTree ──
//
// Read the layout blob to answer "which narrators are in this workspace". That
// question is now answered by membership (`workspace_panels`), and asking the layout
// was unsound for exactly the reason this whole area was redesigned: the layout can
// legitimately omit a member. Its one caller (the unmount `leaveNarrator` sweep) reads
// the member list instead, so a subscription is no longer leaked for a narrator the
// layout happened not to mention.

// ── Removed: pending-panel handoff ──
//
// There used to be a module-level `Map` here that let the sidebar queue "add this
// narrator panel" in MEMORY, to be drained when a `DockviewWorkspace` next mounted.
// It was the direct cause of the "listed in the sidebar but no panel renders" bug:
// the recent-tab row was persisted immediately while the panel existed only in this
// map, so any interruption between the two — navigating away, a reload, a failed
// layout save — left a sidebar child with no panel anywhere, permanently.
//
// Panels are now created through `POST /workspaces/:id/panels` BEFORE navigation, so
// the membership row and its sidebar projection commit in one server transaction and
// there is no in-memory intermediate state to lose.
