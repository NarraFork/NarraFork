/**
 * Workspace membership: the authoritative answer to "which panels are in this
 * workspace".
 *
 * # Why this service exists
 *
 * Membership used to be recorded in TWO independent places — the serialized
 * dockview layout in `workspaces.tree`, and `user_recent_tabs.workspace_id` —
 * written by two separate client requests with no atomicity between them. The
 * observable failure was a narrator listed under a workspace in the sidebar while
 * no panel rendered in either presentation mode: the tab row had been persisted
 * and the panel had only ever been queued in client memory, so any interruption
 * (navigating away, a failed layout save, a reload) left the two permanently out
 * of step. Nothing on the read path could tell that apart from "the user closed
 * that panel", so it could not be reconciled after the fact either.
 *
 * Here, `workspace_panels` rows are the single authority and the sidebar grouping
 * is a projection this service maintains in the SAME transaction. A caller cannot
 * write one half.
 *
 * # Invariants
 *
 * - Every mutation is scoped to a workspace the requesting user owns; a foreign
 *   or missing workspace is a `NotFoundError` (matching the existing routes, so
 *   existence is not leaked).
 * - A narrator has at most one panel per workspace, enforced by a unique index
 *   rather than by a client-side scan (which could not hold under concurrency).
 * - Membership never silently exceeds `WORKSPACE_PANEL_MAX`.
 */

import {
	isWorkspacePanelKind,
	WORKSPACE_PANEL_CONFIG_MAX_BYTES,
	WORKSPACE_PANEL_MAX,
	type WorkspacePanel,
	type WorkspacePanelInput,
	type WorkspacePanelKind,
} from "@shared/workspace-panels";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { userRecentTabs, workspacePanels, workspaces } from "../db/schema";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { applyWorkspaceMembershipProjection } from "./recent-tabs-service";

type WorkspacePanelRow = typeof workspacePanels.$inferSelect;

/** Gap between sort orders so a later insert can land between two panels. */
const SORT_ORDER_GAP = 1_000;

/**
 * Whether a stored row is still a membership kind.
 *
 * The column's enum retains `"plugin"` (dropping it would need a migration for a value
 * no code writes), but plugin panels are narrator-owned resources, not membership — see
 * `NON_MEMBERSHIP_DIRECTOR_PANEL_TYPES`. Rows of a retired kind are filtered out on read
 * rather than trusted, so a row written before that decision cannot resurface as a
 * member and get closed by the client's sync.
 */
function isMembershipRow(row: WorkspacePanelRow): boolean {
	return isWorkspacePanelKind(row.kind);
}

function rowToPanel(row: WorkspacePanelRow): WorkspacePanel {
	return {
		id: row.id,
		// Safe by construction: callers filter with `isMembershipRow` first.
		kind: row.kind as WorkspacePanelKind,
		narratorId: row.narratorId,
		config: parseConfig(row.configJson),
		sortOrder: row.sortOrder,
	};
}

/**
 * Parse a stored config, degrading to `null` rather than throwing.
 *
 * A row whose config cannot be parsed still identifies a real panel, and the
 * panel's kind is enough to render something. Failing the whole workspace read
 * because one webview's stored URL got corrupted would turn a cosmetic problem
 * into an unopenable workspace.
 */
function parseConfig(configJson: string | null): unknown {
	if (!configJson) return null;
	try {
		return JSON.parse(configJson);
	} catch {
		return null;
	}
}

function serializeConfig(config: unknown): string | null {
	if (config === undefined || config === null) return null;
	const json = JSON.stringify(config);
	if (json === undefined) return null;
	// UTF-8 bytes, matching how the value is actually stored.
	if (Buffer.byteLength(json, "utf8") > WORKSPACE_PANEL_CONFIG_MAX_BYTES) {
		throw new ValidationError(
			`Workspace panel config must not exceed ${WORKSPACE_PANEL_CONFIG_MAX_BYTES} UTF-8 bytes`,
			"WORKSPACE_PANEL_CONFIG_TOO_LARGE",
		);
	}
	return json;
}

/** Assert the workspace exists and belongs to this user, returning its row. */
async function requireOwnedWorkspace(userId: string, workspaceId: string) {
	const workspace = await db.query.workspaces.findFirst({
		where: and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)),
	});
	if (!workspace) throw new NotFoundError("Workspace", workspaceId);
	return workspace;
}

function readPanelRows(workspaceId: string): WorkspacePanelRow[] {
	return db
		.select()
		.from(workspacePanels)
		.where(eq(workspacePanels.workspaceId, workspaceId))
		.orderBy(asc(workspacePanels.sortOrder), asc(workspacePanels.id))
		.limit(WORKSPACE_PANEL_MAX)
		.all();
}

// ── Backfill ─────────────────────────────────────────────────────────────────

/**
 * One top-level panel recovered from a legacy layout blob.
 * `identity` is what makes two entries "the same panel" across sources.
 */
interface RecoveredPanel {
	kind: WorkspacePanelKind;
	narratorId: string | null;
	config: unknown;
}

/**
 * Extract top-level panels from a persisted dockview envelope.
 *
 * Tolerant by design: the blob may be a current envelope, a raw
 * `SerializedDockview`, a seed envelope, a legacy split-tree, or corrupt. Anything
 * unrecognized yields an empty list, and the caller then relies on the sidebar
 * projection alone — producing a workspace with all its panels present and a
 * default arrangement, which is the acceptable degradation.
 */
export function recoverPanelsFromLayout(treeJson: string | null | undefined): RecoveredPanel[] {
	if (!treeJson) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(treeJson);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object") return [];

	const root = parsed as Record<string, unknown>;
	// Current envelope, or a raw SerializedDockview.
	const layout = (root.kind === "dockview" ? root.layout : root) as
		| Record<string, unknown>
		| undefined;
	const panelMap = layout?.panels;
	if (panelMap && typeof panelMap === "object") {
		return recoverFromDockviewPanels(panelMap as Record<string, unknown>);
	}
	// Seed envelope: an api-free ordered panel list.
	if (root.kind === "seed" && Array.isArray(root.seed)) {
		return recoverFromSpecs(root.seed);
	}
	// Legacy split-tree.
	const treeRoot = (root.tree ?? root) as unknown;
	return recoverFromSplitTree(treeRoot);
}

function recoverFromDockviewPanels(panels: Record<string, unknown>): RecoveredPanel[] {
	const recovered: RecoveredPanel[] = [];
	for (const entry of Object.values(panels)) {
		const params = (entry as { params?: unknown } | null)?.params;
		const panel = recoverFromParams(params);
		if (panel) recovered.push(panel);
	}
	return recovered;
}

function recoverFromSpecs(specs: unknown[]): RecoveredPanel[] {
	const recovered: RecoveredPanel[] = [];
	for (const spec of specs) {
		const panel = recoverFromParams((spec as { params?: unknown } | null)?.params);
		if (panel) recovered.push(panel);
	}
	return recovered;
}

/** Map one panel's serialized params onto a membership kind, or skip it. */
function recoverFromParams(params: unknown): RecoveredPanel | null {
	if (!params || typeof params !== "object") return null;
	const record = params as Record<string, unknown>;
	const kind = record.panelType;
	if (!isWorkspacePanelKind(kind)) return null; // dependent panel → stays in the layout
	if (kind === "narrator") {
		const narratorId = record.narratorId;
		if (typeof narratorId !== "string" || !narratorId) return null;
		return { kind, narratorId, config: null };
	}
	return { kind, narratorId: null, config: record };
}

function recoverFromSplitTree(node: unknown): RecoveredPanel[] {
	if (!node || typeof node !== "object") return [];
	const record = node as Record<string, unknown>;
	if (record.type === "branch" && Array.isArray(record.children)) {
		return record.children.flatMap((child) => recoverFromSplitTree(child));
	}
	if (record.type !== "leaf") return [];
	// Legacy leaves default to "narrator" when panelType is absent.
	const panelType = typeof record.panelType === "string" ? record.panelType : "narrator";
	if (panelType === "narrator") {
		const narratorId = record.narratorId;
		if (typeof narratorId !== "string" || !narratorId) return [];
		return [{ kind: "narrator", narratorId, config: null }];
	}
	if (panelType === "terminal" && record.terminalConfig) {
		return [
			{
				kind: "terminal",
				narratorId: null,
				config: { panelType: "terminal", terminalConfig: record.terminalConfig },
			},
		];
	}
	if (panelType === "webview" && record.webviewConfig) {
		return [
			{
				kind: "webview",
				narratorId: null,
				config: { panelType: "webview", webviewConfig: record.webviewConfig },
			},
		];
	}
	return [];
}

/** Narrator ids the sidebar records as belonging to this workspace. */
function readProjectedNarratorIds(userId: string, workspaceId: string): string[] {
	const rows = db
		.select({ narratorId: userRecentTabs.representedNarratorId })
		.from(userRecentTabs)
		.where(
			and(
				eq(userRecentTabs.userId, userId),
				eq(userRecentTabs.workspaceId, workspaceId),
				isNotNull(userRecentTabs.representedNarratorId),
			),
		)
		.orderBy(asc(userRecentTabs.sortOrder), asc(userRecentTabs.tabKey))
		.limit(WORKSPACE_PANEL_MAX)
		.all();
	return rows
		.map((row) => row.narratorId)
		.filter((narratorId): narratorId is string => !!narratorId);
}

/**
 * Materialise membership rows for a workspace that has none yet.
 *
 * The source is the UNION of the layout blob and the sidebar projection, in that
 * order. The union is the point: it is the only merge that loses nothing, and it
 * is what repairs workspaces already damaged by the two-source design — a
 * narrator the sidebar knows about but the layout never received becomes a real
 * panel here, without this code having to guess whether it was "dropped" or
 * "deliberately closed".
 *
 * Runs at most once per workspace: the presence of any row disables it.
 */
function backfillPanelsInTransaction(
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction type is private to the driver.
	tx: any,
	userId: string,
	workspaceId: string,
	treeJson: string | null,
	now: Date,
): void {
	const recovered = recoverPanelsFromLayout(treeJson);
	const seenNarratorIds = new Set<string>();
	const toInsert: RecoveredPanel[] = [];

	for (const panel of recovered) {
		if (panel.kind === "narrator") {
			if (!panel.narratorId || seenNarratorIds.has(panel.narratorId)) continue;
			seenNarratorIds.add(panel.narratorId);
		}
		toInsert.push(panel);
		if (toInsert.length >= WORKSPACE_PANEL_MAX) break;
	}

	for (const narratorId of readProjectedNarratorIds(userId, workspaceId)) {
		if (seenNarratorIds.has(narratorId)) continue;
		if (toInsert.length >= WORKSPACE_PANEL_MAX) break;
		seenNarratorIds.add(narratorId);
		toInsert.push({ kind: "narrator", narratorId, config: null });
	}

	if (toInsert.length === 0) return;

	tx.insert(workspacePanels)
		.values(
			toInsert.map((panel, index) => ({
				id: generateId(),
				workspaceId,
				kind: panel.kind,
				narratorId: panel.narratorId,
				configJson: panel.config === null ? null : JSON.stringify(panel.config),
				sortOrder: (index + 1) * SORT_ORDER_GAP,
				createdAt: now,
				updatedAt: now,
			})),
		)
		.run();

	logger.info("Backfilled workspace panels from layout and sidebar projection", {
		workspaceId,
		recoveredFromLayout: recovered.length,
		total: toInsert.length,
	});
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * List a workspace's membership, materialising it on first read.
 *
 * Narrator panels whose narrator row is gone are filtered out defensively: the
 * FK cascade normally removes them, but a backfill from an old layout can name a
 * narrator that was deleted before this table existed.
 */
export async function listWorkspacePanels(
	userId: string,
	workspaceId: string,
): Promise<WorkspacePanel[]> {
	const workspace = await requireOwnedWorkspace(userId, workspaceId);
	let rows = readPanelRows(workspaceId);
	if (rows.length === 0) {
		const now = new Date();
		db.transaction((tx) => {
			// Re-check inside the transaction: two concurrent opens of the same
			// workspace would otherwise both backfill and double every panel.
			const existing = tx
				.select({ id: workspacePanels.id })
				.from(workspacePanels)
				.where(eq(workspacePanels.workspaceId, workspaceId))
				.limit(1)
				.all();
			if (existing.length > 0) return;
			backfillPanelsInTransaction(tx, userId, workspaceId, workspace.tree, now);
		});
		rows = readPanelRows(workspaceId);
	}
	return rows.filter(isMembershipRow).map(rowToPanel);
}

/**
 * Add a panel, or return the existing one when it is already a member.
 *
 * Idempotent for narrator panels because the caller's intent ("this narrator
 * should be in this workspace") is satisfied either way, and a duplicate would
 * be rejected by the unique index anyway. The membership row and its sidebar
 * projection commit together.
 */
export async function addWorkspacePanel(
	userId: string,
	workspaceId: string,
	input: WorkspacePanelInput,
): Promise<{ panel: WorkspacePanel; created: boolean }> {
	await requireOwnedWorkspace(userId, workspaceId);
	// Ensure membership exists before adding to it, so the first panel added to a
	// legacy workspace does not become its ONLY panel.
	const existingPanels = await listWorkspacePanels(userId, workspaceId);

	if (input.kind === "narrator") {
		const already = existingPanels.find(
			(panel) => panel.kind === "narrator" && panel.narratorId === input.narratorId,
		);
		if (already) return { panel: already, created: false };
	}

	if (existingPanels.length >= WORKSPACE_PANEL_MAX) {
		throw new ValidationError(
			`A workspace may hold at most ${WORKSPACE_PANEL_MAX} panels`,
			"WORKSPACE_PANEL_LIMIT_REACHED",
		);
	}

	const now = new Date();
	const id = generateId();
	const sortOrder = (existingPanels.at(-1)?.sortOrder ?? 0) + SORT_ORDER_GAP;
	const configJson = input.kind === "narrator" ? null : serializeConfig(input.config);
	// `kind` is pinned to the membership union rather than inferred: the column's enum is
	// wider (it still carries the retired `"plugin"`), and letting inference widen here
	// would silently allow a non-membership kind to be written.
	const kind: WorkspacePanelKind = input.kind;
	const row: typeof workspacePanels.$inferInsert = {
		id,
		workspaceId,
		kind,
		narratorId: input.kind === "narrator" ? input.narratorId : null,
		configJson,
		sortOrder,
		createdAt: now,
		updatedAt: now,
	};

	if (input.kind === "narrator") {
		// Membership row + sidebar projection in ONE transaction.
		await applyWorkspaceMembershipProjection(userId, {
			narratorId: input.narratorId,
			workspaceId,
			panelMembership: { action: "insert", row },
		});
	} else {
		db.insert(workspacePanels).values(row).run();
	}

	return {
		panel: {
			id,
			kind,
			narratorId: row.narratorId ?? null,
			config: parseConfig(configJson),
			sortOrder,
		},
		created: true,
	};
}

/**
 * Remove a panel and release its sidebar tab back to the top level.
 *
 * Releasing rather than deleting the tab: the narrator still exists and the user
 * may well want to keep working with it, just not inside this workspace.
 */
export async function removeWorkspacePanel(
	userId: string,
	workspaceId: string,
	panelId: string,
): Promise<void> {
	await requireOwnedWorkspace(userId, workspaceId);
	const row = db
		.select()
		.from(workspacePanels)
		.where(and(eq(workspacePanels.id, panelId), eq(workspacePanels.workspaceId, workspaceId)))
		.get();
	if (!row) throw new NotFoundError("Workspace panel", panelId);

	if (row.kind === "narrator" && row.narratorId) {
		await applyWorkspaceMembershipProjection(userId, {
			narratorId: row.narratorId,
			workspaceId: null,
			panelMembership: { action: "remove", panelId: row.id },
		});
		return;
	}
	db.delete(workspacePanels).where(eq(workspacePanels.id, panelId)).run();
}

/** Rejection code for a layout save that raced another client. */
export const WORKSPACE_LAYOUT_CONFLICT_CODE = "WORKSPACE_LAYOUT_CONFLICT";

/**
 * A layout save that lost a race.
 *
 * Carries the CURRENT revision so a client can rebase and retry in one round trip
 * instead of issuing a separate read — the retry is on an interactive path (the
 * user is dragging panels), so an extra request would be visible as lag.
 */
export class WorkspaceLayoutConflictError extends AppError {
	constructor(public readonly currentRevision: number) {
		super("Workspace layout changed in another session", 409, WORKSPACE_LAYOUT_CONFLICT_CODE);
	}
}

/**
 * Save the arrangement under optimistic concurrency.
 *
 * Only the arrangement: membership is not in this blob, so losing a layout write
 * costs panel POSITIONS and never a panel. That is the whole reason a conflict can
 * be answered with a plain 409 and a client-side retry — there is nothing here
 * whose loss would make a narrator unreachable.
 */
export async function saveWorkspaceLayout(
	userId: string,
	workspaceId: string,
	layout: string,
	expectedRevision: number,
): Promise<{ layoutRevision: number }> {
	await requireOwnedWorkspace(userId, workspaceId);
	const now = new Date();
	// Guard inside the UPDATE rather than as a read-then-write: two saves arriving
	// together would both pass a separate read and the second would still clobber.
	const updated = await db
		.update(workspaces)
		.set({ tree: layout, layoutRevision: expectedRevision + 1, updatedAt: now })
		.where(
			and(
				eq(workspaces.id, workspaceId),
				eq(workspaces.userId, userId),
				eq(workspaces.layoutRevision, expectedRevision),
			),
		)
		.returning({ layoutRevision: workspaces.layoutRevision });

	if (updated.length === 0) {
		const current = await db.query.workspaces.findFirst({
			where: and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)),
			columns: { layoutRevision: true },
		});
		throw new WorkspaceLayoutConflictError(current?.layoutRevision ?? 0);
	}
	return { layoutRevision: updated[0].layoutRevision };
}

/**
 * Update a non-narrator panel's config (edited webview URL, plugin view state).
 *
 * Narrator panels have no config: their whole identity is `narratorId`.
 */
export async function updateWorkspacePanelConfig(
	userId: string,
	workspaceId: string,
	panelId: string,
	config: unknown,
): Promise<WorkspacePanel> {
	await requireOwnedWorkspace(userId, workspaceId);
	const row = db
		.select()
		.from(workspacePanels)
		.where(and(eq(workspacePanels.id, panelId), eq(workspacePanels.workspaceId, workspaceId)))
		.get();
	if (!row) throw new NotFoundError("Workspace panel", panelId);
	if (row.kind === "narrator") {
		throw new ValidationError(
			"A narrator panel has no config to update",
			"WORKSPACE_PANEL_NOT_CONFIGURABLE",
		);
	}
	const configJson = serializeConfig(config);
	await db
		.update(workspacePanels)
		.set({ configJson, updatedAt: new Date() })
		.where(eq(workspacePanels.id, panelId));
	return { ...rowToPanel(row), config: parseConfig(configJson) };
}
