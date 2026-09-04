/**
 * Reconcile a persisted arrangement against authoritative membership.
 *
 * # The inversion this implements
 *
 * The layout blob used to BE the panel set: whatever `fromJSON` restored was what
 * the workspace contained. That made a lost or truncated layout write indistinguishable
 * from "the user closed those panels", and it is why a narrator could be listed under
 * a workspace in the sidebar while no panel rendered in either presentation mode.
 *
 * Here the member list from the server decides WHAT exists and the layout only decides
 * WHERE things sit:
 *
 *   - a layout entry naming a panel that is not a member is dropped;
 *   - a member the layout does not mention is appended (the caller adds it live);
 *   - a dependent panel (tool / subagent / file / knowledge) survives only while its
 *     host narrator is still a member.
 *
 * So a damaged layout costs POSITIONS, never a panel. This module is deliberately free
 * of React and dockview imports so that guarantee can be tested directly.
 */

import { type WorkspacePanel, workspacePanelDomId } from "@shared/workspace-panels";
import type { Direction, SerializedDockview } from "dockview-react";
import type { PanelSpec } from "./dockview-layout";

/**
 * Identity of a member, used to match it to a layout entry or a live panel.
 *
 * Identity, not dockview panel id: a layout written under an older convention (or by
 * another client version) stores narrator panels under synthetic `dvp_*` ids, and those
 * must still be recognised as that narrator's cell without a data migration.
 */
export function memberIdentity(panel: WorkspacePanel): string {
	if (panel.kind === "narrator" && panel.narratorId) return `narrator:${panel.narratorId}`;
	return `panel:${panel.id}`;
}

/**
 * Identity of a LIVE dockview panel, from its params and its id.
 *
 * Exported because the membership-sync effect must ask the same question this module
 * asks when reconciling: "is this live panel the same thing as this member?". An
 * earlier version of that effect matched on `panelDomId` instead, which broke every
 * restored layout — a narrator panel persisted under a synthetic `dvp_*` id (what
 * seeded and migrated layouts contain) did not equal `narratorId`, so the effect saw
 * every member as missing AND every restored panel as a non-member: it re-added each
 * one into the active group and closed the originals, collapsing a multi-pane layout
 * into a single pane of tabs. Identity has to be computed in exactly one place.
 */
export function livePanelIdentity(
	params: Record<string, unknown> | undefined,
	panelId: string,
): string | null {
	if (!params) return null;
	return layoutEntryIdentity(params, panelId);
}

/**
 * The same identity, derived from a serialized layout entry's params.
 *
 * `plugin` is deliberately NOT here. In the reconcile path plugin params never
 * reach this function (every plugin panel is a dependent or a surface-owned one —
 * `dependentHostNarratorId` always resolves it), and a non-membership kind that
 * did slip through must answer null so it is dropped rather than matched.
 */
function layoutEntryIdentity(params: Record<string, unknown>, panelId: string): string | null {
	const panelType = params.panelType;
	if (panelType === "narrator") {
		const narratorId = params.narratorId;
		return typeof narratorId === "string" && narratorId ? `narrator:${narratorId}` : null;
	}
	if (panelType === "terminal" || panelType === "webview") {
		// A layout written before membership rows existed has no row id to name, so the
		// only handle is the dockview panel id it was stored under.
		return `panel:${stripPanelIdPrefix(panelId)}`;
	}
	return null;
}

/** Undo `workspacePanelDomId`'s prefix so a stored id maps back to its row id. */
function stripPanelIdPrefix(panelId: string): string {
	return panelId.startsWith("wsp_") ? panelId.slice("wsp_".length) : panelId;
}

/**
 * The host narrator a dependent panel belongs to, or null if it is not dependent.
 *
 * Dependent panels are pruned with their host rather than kept: a tool panel whose
 * narrator cell is gone has no context to render in, which is the same rule
 * `pruneOrphanedClusters` already applies to the live layout.
 */
function dependentHostNarratorId(params: Record<string, unknown>): string | null {
	const panelType = params.panelType;
	if (panelType === "narrator-tool") {
		const narratorId = params.narratorId;
		return typeof narratorId === "string" ? narratorId : null;
	}
	if (panelType === "subagent" || panelType === "file" || panelType === "knowledge") {
		const hostNarratorId = params.hostNarratorId;
		return typeof hostNarratorId === "string" ? hostNarratorId : null;
	}
	if (panelType === "plugin") {
		// A workspace plugin panel binds to an owning narrator
		// (`binding.kind === "workspace-narrator"`), which makes it a dependent, not a
		// member. A workspace-wide binding has no owner, so it is kept unconditionally:
		// it belongs to the surface itself.
		const binding = params.binding as { kind?: unknown; ownerNarratorId?: unknown } | undefined;
		if (binding?.kind === "workspace-narrator" && typeof binding.ownerNarratorId === "string") {
			return binding.ownerNarratorId;
		}
		return PLUGIN_PANEL_WITHOUT_OWNER;
	}
	return null;
}

/**
 * Sentinel: a dependent panel with no owning narrator, which must never be pruned.
 *
 * Distinct from `null` (= "this is a member, reconcile it") so a workspace-scoped
 * plugin panel is neither treated as stale membership nor tied to a narrator's lifetime.
 */
const PLUGIN_PANEL_WITHOUT_OWNER = "\u0000no-owner";

export interface WorkspacePanelPlan {
	/**
	 * The layout to hand to `fromJSON`, PRUNED of non-member entries, or null when
	 * nothing usable is left. Null means "build the surface from `appended` alone",
	 * which yields a complete surface with a default arrangement — not an empty one.
	 */
	layout: SerializedDockview | null;
	/** Members the layout did not place; the caller adds these via `addPanel`. */
	appended: WorkspacePanel[];
	/** Panel ids dropped from the layout, for diagnostics. */
	droppedPanelIds: string[];
}

/**
 * Build the render plan for a workspace.
 *
 * `layout` may be anything previously persisted (current envelope, an older raw
 * `SerializedDockview`, or corrupt); anything unusable is treated as absent, which
 * degrades to "every member present, default arrangement".
 */
export function reconcileLayoutWithPanels(input: {
	panels: readonly WorkspacePanel[];
	layout: SerializedDockview | null | undefined;
}): WorkspacePanelPlan {
	const members = [...input.panels].sort((a, b) => a.sortOrder - b.sortOrder);
	const byIdentity = new Map(members.map((panel) => [memberIdentity(panel), panel]));
	const memberNarratorIds = new Set(
		members
			.filter((panel) => panel.kind === "narrator" && panel.narratorId)
			.map((panel) => panel.narratorId as string),
	);

	const rawPanels = readLayoutPanels(input.layout);
	if (!rawPanels) {
		return { layout: null, appended: members, droppedPanelIds: [] };
	}

	const placedIdentities = new Set<string>();
	const droppedPanelIds: string[] = [];
	for (const [panelId, entry] of Object.entries(rawPanels)) {
		const params = (entry as { params?: unknown } | null)?.params;
		if (!params || typeof params !== "object") {
			droppedPanelIds.push(panelId);
			continue;
		}
		const record = params as Record<string, unknown>;

		const hostNarratorId = dependentHostNarratorId(record);
		if (hostNarratorId !== null) {
			// Owned by the surface rather than a narrator → always kept.
			if (hostNarratorId === PLUGIN_PANEL_WITHOUT_OWNER) continue;
			if (!memberNarratorIds.has(hostNarratorId)) droppedPanelIds.push(panelId);
			continue;
		}

		const identity = layoutEntryIdentity(record, panelId);
		if (!identity || !byIdentity.has(identity)) {
			droppedPanelIds.push(panelId);
			continue;
		}
		placedIdentities.add(identity);
	}

	const appended = members.filter((panel) => !placedIdentities.has(memberIdentity(panel)));

	// Every entry was dropped: restoring the husk would produce an empty surface (the
	// exact symptom being fixed), so discard it and place every member instead.
	if (placedIdentities.size === 0) {
		return { layout: null, appended: members, droppedPanelIds };
	}

	// Prune rather than discard. Throwing the whole layout away because ONE stale
	// entry survived would reset an arrangement the user built by hand — a visible
	// regression every time a narrator is removed elsewhere.
	return {
		layout:
			droppedPanelIds.length === 0
				? (input.layout as SerializedDockview)
				: pruneLayout(input.layout as SerializedDockview, new Set(droppedPanelIds)),
		appended,
		droppedPanelIds,
	};
}

/**
 * Remove named panels from a serialized layout, including their grid leaves.
 *
 * Dockview's `fromJSON` throws when a grid leaf references a panel id that is not in
 * `panels`, and that throw is what used to clear the surface entirely. So the grid
 * tree has to be rewritten in step with the panel map: leaves naming a dropped panel
 * lose that id, branches that end up empty collapse, and a group left with no views
 * is removed.
 *
 * Operates on a `structuredClone`; the caller's layout is never mutated.
 */
function pruneLayout(
	layout: SerializedDockview,
	dropped: ReadonlySet<string>,
): SerializedDockview | null {
	let clone: SerializedDockview;
	try {
		clone = structuredClone(layout);
	} catch {
		// A layout holding something non-cloneable cannot be trusted as a restore
		// source; the caller's member-only fallback is the safe answer.
		return null;
	}

	const panels = (clone as unknown as { panels: Record<string, unknown> }).panels;
	for (const panelId of dropped) delete panels[panelId];
	if (Object.keys(panels).length === 0) return null;

	const grid = (clone as unknown as { grid?: { root?: unknown } }).grid;
	if (!grid?.root) return null;
	const prunedRoot = pruneGridNode(grid.root, dropped);
	if (!prunedRoot) return null;
	grid.root = prunedRoot;

	// An active group that no longer exists would leave dockview activating nothing.
	const activeGroup = (clone as unknown as { activeGroup?: unknown }).activeGroup;
	if (typeof activeGroup === "string" && !gridContainsGroup(grid.root, activeGroup)) {
		delete (clone as unknown as { activeGroup?: unknown }).activeGroup;
	}
	return clone;
}

/** Prune one grid node, returning null when it holds nothing renderable. */
function pruneGridNode(node: unknown, dropped: ReadonlySet<string>): unknown | null {
	if (!node || typeof node !== "object") return null;
	const record = node as Record<string, unknown>;

	if (record.type === "branch") {
		if (!Array.isArray(record.data)) return null;
		const children = record.data
			.map((child) => pruneGridNode(child, dropped))
			.filter((child): child is unknown => child !== null);
		if (children.length === 0) return null;
		return { ...record, data: children };
	}

	if (record.type !== "leaf") return null;
	const data = record.data as Record<string, unknown> | undefined;
	if (!data) return null;
	const views = Array.isArray(data.views) ? data.views : [];
	const keptViews = views.filter((view) => typeof view === "string" && !dropped.has(view));
	if (keptViews.length === 0) return null;
	const activeView =
		typeof data.activeView === "string" && keptViews.includes(data.activeView)
			? data.activeView
			: keptViews[0];
	return { ...record, data: { ...data, views: keptViews, activeView } };
}

function gridContainsGroup(node: unknown, groupId: string): boolean {
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (record.type === "branch") {
		return (
			Array.isArray(record.data) && record.data.some((child) => gridContainsGroup(child, groupId))
		);
	}
	const data = record.data as Record<string, unknown> | undefined;
	return data?.id === groupId;
}

/**
 * Extract the `panels` map from a persisted layout, or null when unusable.
 *
 * Accepts both the current envelope's inner layout and a bare `SerializedDockview`,
 * because both shapes exist in stored data.
 *
 * A `grid.root` branch is REQUIRED, not merely nice to have: `fromJSON` rejects a
 * layout without it, and that rejection is what clears the surface. Validating it
 * here means a structurally broken blob is classified as "absent" (members get placed
 * with a default arrangement) instead of reaching dockview and blanking the workspace.
 */
function readLayoutPanels(
	layout: SerializedDockview | null | undefined,
): Record<string, unknown> | null {
	if (!layout || typeof layout !== "object") return null;
	const panels = (layout as { panels?: unknown }).panels;
	if (!panels || typeof panels !== "object") return null;
	const record = panels as Record<string, unknown>;
	if (Object.keys(record).length === 0) return null;
	const root = (layout as { grid?: { root?: unknown } }).grid?.root;
	if (!root || typeof root !== "object") return null;
	if ((root as { type?: unknown }).type !== "branch") return null;
	return record;
}

/** The dockview panel id a member should be added under. */
export function panelDomId(panel: WorkspacePanel): string {
	return workspacePanelDomId(panel);
}

// ── Seed materialisation ─────────────────────────────────────────────────────

/**
 * One step of a seed-envelope materialisation, in spec order.
 *
 * `position` is undefined for the first placed panel (it owns the empty surface);
 * later steps carry the spec's `direction` with the reference resolved to the
 * already-placed member's dom id.
 */
export interface SeedPlacementStep {
	member: WorkspacePanel;
	/** Dom id the panel should be added under (`panelDomId(member)`). */
	domId: string;
	position?: { direction: Direction; referenceDomId: string };
}

export interface SeedMaterialisationPlan {
	steps: SeedPlacementStep[];
	/** Members the seed does not mention; the caller places them at default positions. */
	appended: WorkspacePanel[];
}

/**
 * Turn a seed envelope's specs into an ordered placement plan against membership.
 *
 * The seed is written at workspace creation (a sidebar drag) before any DockviewApi
 * exists, and its whole point is the `placement` — which half of the surface each of
 * the two narrators gets. Resolving `relative.referenceId` needs a map from the
 * seed's temporary `dvp_*` ids to the dom ids members are actually added under,
 * which is built as the plan is walked in spec order.
 *
 * Matching is by identity, not position: a narrator spec names its member by
 * `narratorId`. Non-narrator specs and specs naming a non-member are skipped, and
 * every unmatched member lands in `appended` — the "every member is placed"
 * invariant holds exactly as in the dockview restore path.
 */
export function planSeedMaterialisation(
	specs: readonly PanelSpec[],
	members: readonly WorkspacePanel[],
): SeedMaterialisationPlan {
	const sorted = [...members].sort((a, b) => a.sortOrder - b.sortOrder);
	const placed = new Set<string>();
	const domIdBySpecId = new Map<string, string>();
	const steps: SeedPlacementStep[] = [];

	for (const spec of specs) {
		const member = memberForSpec(spec, sorted);
		if (!member) continue;
		const identity = memberIdentity(member);
		if (placed.has(identity)) continue;
		placed.add(identity);

		const domId = panelDomId(member);
		let position: SeedPlacementStep["position"];
		if (spec.placement.kind === "relative") {
			const referenceDomId = domIdBySpecId.get(spec.placement.referenceId);
			// A dangling reference degrades to a default-position append rather than
			// dropping the panel: position data is expendable, membership is not.
			if (referenceDomId) {
				position = { direction: spec.placement.direction, referenceDomId };
			}
		}
		steps.push({ member, domId, position });
		domIdBySpecId.set(spec.id, domId);
	}

	const appended = sorted.filter((member) => !placed.has(memberIdentity(member)));
	return { steps, appended };
}

/**
 * The member a seed spec refers to, or null when the spec cannot be honoured.
 *
 * Only narrator specs are resolvable: the seed's other kinds (if a future creator
 * emits them) have no row id to match against, and inventing one here is exactly
 * what `panelRowId` exists to prevent.
 */
function memberForSpec(spec: PanelSpec, members: readonly WorkspacePanel[]): WorkspacePanel | null {
	const params = spec.params as { panelType?: unknown; narratorId?: unknown } | undefined;
	if (params?.panelType !== "narrator" || typeof params.narratorId !== "string") return null;
	return (
		members.find(
			(member) => member.kind === "narrator" && member.narratorId === params.narratorId,
		) ?? null
	);
}

// ── Stale-layout refresh decision ────────────────────────────────────────────

export type SurfaceRefreshDecision = "rebuild" | "adopt-baseline" | "ignore";

/**
 * Decide what a mounted surface should do when the workspace query delivers a
 * DIFFERENT layout than the one the surface was built from.
 *
 * This is the guard that was missing when the query cache went stale: a refetch
 * can deliver a layout written by another session (or by this one before a
 * cache-less save), and blindly honouring it would either clobber the user's
 * in-progress arrangement or — worse — let the stale arrangement be persisted
 * back over the newer one on the next layout change.
 *
 *   - "ignore": the incoming tree IS the surface's baseline (our own save echoed
 *     back through the cache) — nothing to do.
 *   - "adopt-baseline": the user has local edits; the surface keeps them and the
 *     next persist will make the server agree. The baseline still advances so a
 *     later identical refetch is "ignore".
 *   - "rebuild": no local edits, so the server layout is strictly newer
 *     information — rebuild the surface from it.
 */
export function decideSurfaceRefresh(input: {
	localEdit: boolean;
	builtTree: string | null;
	incomingTree: string | null | undefined;
}): SurfaceRefreshDecision {
	const incoming = input.incomingTree ?? null;
	if (incoming === input.builtTree) return "ignore";
	return input.localEdit ? "adopt-baseline" : "rebuild";
}
