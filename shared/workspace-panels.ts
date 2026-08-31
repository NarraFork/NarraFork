/**
 * Workspace membership vocabulary, shared by the server and the frontend.
 *
 * A workspace's TOP-LEVEL panels are its membership, stored as rows in
 * `workspace_panels`. The serialized dockview layout only records where those
 * panels sit. Keeping the vocabulary here means the two sides cannot disagree
 * about which kinds are membership and which are arrangement — a disagreement
 * that would reappear as "the sidebar lists it but nothing renders".
 */

/**
 * Panel kinds that constitute membership.
 *
 * These are exactly the panels that can stand on their own and that BOTH
 * presentation modes (grid and director) render as top-level cells. Dependent
 * panels — `narrator-tool`, `subagent`, `file`, `knowledge` — are deliberately
 * NOT here: each exists only as a resource of a member (identified by its
 * `hostNarratorId`), the sidebar never lists them, and reopening one is a single
 * click. They remain in the layout blob.
 */
export const WORKSPACE_PANEL_KINDS = ["narrator", "terminal", "webview"] as const;

/**
 * Why `plugin` is NOT a membership kind, despite being director-renderable.
 *
 * A plugin panel opened inside a workspace binds as `workspace-narrator`, carrying an
 * `ownerNarratorId` (`PluginContributionPicker.tsx:279`). It is therefore a resource OF
 * a narrator — the same category as a tool or subagent panel — and it is recreated by
 * user action rather than restored as a standalone cell.
 *
 * Treating it as membership was actively harmful: no code path creates a row for it, so
 * the membership sync would classify every live plugin panel as a stale member and
 * CLOSE it. Its params are also `.strict()`-validated by
 * `pluginDockPanelParamsSchema`, so it cannot carry a `panelRowId` without a protocol
 * change.
 */
export const NON_MEMBERSHIP_DIRECTOR_PANEL_TYPES = ["plugin"] as const;

export type WorkspacePanelKind = (typeof WORKSPACE_PANEL_KINDS)[number];

export function isWorkspacePanelKind(value: unknown): value is WorkspacePanelKind {
	return typeof value === "string" && (WORKSPACE_PANEL_KINDS as readonly string[]).includes(value);
}

/**
 * Upper bound on one workspace's membership.
 *
 * A workspace is a hand-assembled surface, so a few dozen panels is already
 * unusual. The cap exists so a runaway client (or a loop in a plugin) cannot grow
 * one workspace without limit, and so the per-workspace read stays small.
 */
export const WORKSPACE_PANEL_MAX = 64;

/**
 * Byte ceiling for one panel's `configJson`.
 *
 * Matches the plugin `viewState` allowance (16 KiB) because a plugin panel's view
 * state is the largest thing that legitimately lands here. Measured in UTF-8
 * BYTES: a character count would let CJK content store ~3x the stated size, which
 * is the same unit confusion that made the old layout ceiling decorative.
 */
export const WORKSPACE_PANEL_CONFIG_MAX_BYTES = 16 * 1024;

/** One membership row, as returned by the API. */
export interface WorkspacePanel {
	id: string;
	kind: WorkspacePanelKind;
	/** Present only when `kind === "narrator"`. */
	narratorId: string | null;
	/**
	 * Panel params for terminal / webview / plugin kinds, already parsed.
	 * `null` for narrator panels, whose only identity is `narratorId`.
	 */
	config: unknown;
	sortOrder: number;
}

/**
 * What a client sends to create a panel.
 *
 * A discriminated union, because the two shapes carry different identity: a narrator
 * panel IS its `narratorId` and has no config, while the other kinds are identified by
 * the row they create and carry params. One loose shape would permit a "narrator panel
 * with a config", which the service would then have to reject at runtime.
 */
export type WorkspacePanelInput =
	| { kind: "narrator"; narratorId: string }
	| { kind: Exclude<WorkspacePanelKind, "narrator">; config: unknown };

/**
 * Stable dockview panel id for a membership row.
 *
 * A narrator panel keeps using the narrator id, which is what every existing
 * persisted layout already contains and what the tool-placement code looks up
 * (`api.getPanel(narratorId)`). It is unique per workspace by database
 * constraint, so it cannot collide. Other kinds are keyed by their row id, since
 * a workspace may legitimately hold several terminals or webviews.
 *
 * Reconciliation still matches layout entries to members by IDENTITY rather than
 * by this id, so a layout written under an older convention is handled without a
 * migration.
 */
export function workspacePanelDomId(
	panel: Pick<WorkspacePanel, "id" | "kind" | "narratorId">,
): string {
	if (panel.kind === "narrator" && panel.narratorId) return panel.narratorId;
	return `wsp_${panel.id}`;
}
