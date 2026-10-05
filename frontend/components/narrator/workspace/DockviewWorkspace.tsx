/**
 * Dockview-backed workspace surface.
 *
 * Composes the reusable <DockviewSurface> (theme +
 * swap/merge/split drag semantics) and layers on the workspace-specific
 * concerns: narrator join/leave lifecycle, sidebar drag-and-drop bridging, and
 * director (maximize) mode.
 *
 * # Membership is authoritative; the layout is arrangement
 *
 * The panel set comes from the `panels` prop (server rows in `workspace_panels`),
 * never from the persisted layout. The layout is consulted only for positions, and
 * every failure path — corrupt blob, `fromJSON` throwing, entries naming panels that
 * are no longer members — still ends with every member placed.
 *
 * That inversion is the fix for a workspace showing fewer panels than its sidebar
 * group listed: previously the layout WAS the panel set, so a layout that never
 * received a panel (or failed to restore) rendered a workspace missing it, with no
 * way to tell that apart from the user having closed it.
 */

import { Box } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { WorkspacePanel } from "@shared/workspace-panels";
import { useQueryClient } from "@tanstack/react-query";
import {
	type DockviewApi,
	type DockviewDidDropEvent,
	type IDockviewPanel,
	positionToDirection,
} from "dockview-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef } from "react";
import { WorkspaceResourceTab } from "./WorkspaceResourceTab";
import "./workspace-resource.css";
import { useTranslation } from "react-i18next";
import { workspaceQueryKey } from "../../../hooks/useWorkspace";
import { api as apiClient, isWorkspaceLayoutConflict } from "../../../lib/api";
import { isNarratorSubject, type PanelDragState } from "../../../lib/panel-drag";
import { type DockviewDropTarget, DockviewSurface, intentToPosition } from "../../dockview";
import type { WebviewLeafConfig } from "../split-tree";
import { type DirectorLeaf, isDirectorRenderablePanel } from "./director-constants";
import { consumeWorkspaceDropPayload, WORKSPACE_DND_MIME } from "./dnd-bridge";
import {
	componentForParams,
	DEFAULT_DIRECTOR_STATE,
	nextWorkspacePanelId,
	resolveWorkspaceLayout,
	serializeWorkspaceLayout,
	type WorkspaceDirectorState,
} from "./dockview-layout";
import { type WorkspacePanelParams, workspacePanelComponents } from "./panels";
import {
	createWorkspaceDockStore,
	WorkspaceDockProvider,
	workspaceResourceOwner,
} from "./workspace-dock";
import {
	decideSurfaceRefresh,
	livePanelIdentity,
	memberIdentity,
	panelDomId,
	planSeedMaterialisation,
	reconcileLayoutWithPanels,
} from "./workspace-panel-set";

const SAVE_DEBOUNCE_MS = 500;

/**
 * Imperative handle for driving director mode from outside the workspace.
 *
 * All mutations flow through here so the persisted `director` state (mode /
 * primary panel / ratio) stays in sync with what the director overlay shows.
 * `closePanel` is the only one that actually removes a dockview panel.
 */
export interface DirectorControl {
	setMode: (mode: "grid" | "director") => void;
	/** Promote a panel to primary in director mode. */
	setPrimary: (panelId: string) => void;
	/** Persist the primary/rail ratio. */
	setRatio: (ratio: number) => void;
	/**
	 * Open a child session as a temporary resource without leaving Director.
	 * `messageId` optionally scrolls that session to one message.
	 */
	openSubagentPanel: (
		hostNarratorId: string,
		subagentNarratorId: string,
		messageId?: string,
	) => void;
	/** Close a dockview panel by id (goes through dockview's normal removal). */
	closePanel: (panelId: string) => void;
	/** Update a dockview panel's params (e.g. edited webview/plugin state). */
	updatePanelParams: (panelId: string, params: WorkspacePanelParams) => void;
	/**
	 * Update a webview member's config from the director overlay.
	 *
	 * Separate from `updatePanelParams` so the caller does not have to restate the
	 * panel's identity: it must keep `panelRowId`, and rebuilding the params object
	 * externally is how that gets dropped. Also persists the config to the membership
	 * row, since it is row state rather than arrangement.
	 */
	updateWebviewConfig: (panelId: string, config: WebviewLeafConfig) => void;
	/** Update a dockview panel title while Director owns the visible chrome. */
	updatePanelTitle: (panelId: string, title: string) => void;
}

interface DockviewWorkspaceProps {
	workspaceId: string;
	/**
	 * Authoritative membership from the server.
	 *
	 * This — not the layout — decides which panels the surface contains. The layout is
	 * consulted only for positions, so a lost or corrupt layout write can cost an
	 * arrangement but can never make a narrator disappear.
	 */
	panels: readonly WorkspacePanel[];
	/** Raw `workspaces.tree` string from the server (envelope or legacy). */
	treeJson: string | null | undefined;
	/** Optimistic-concurrency token for layout writes. */
	layoutRevision: number;
	/** Notify parent when the live narrator id set changes (for recent-tab sync). */
	onNarratorIdsChange?: (ids: string[]) => void;
	/**
	 * Await a refetch of authoritative membership after this surface changed it.
	 *
	 * Returning a promise matters: membership is this component's input, so the caller
	 * has to re-read it before the surface can be considered converged.
	 */
	onMembershipChanged?: () => Promise<unknown>;
	/** Notify parent of the live panel list (for the director overlay). */
	onPanelsChange?: (leaves: DirectorLeaf[]) => void;
	/** Called once the DockviewApi is ready. */
	onApiReady?: (api: DockviewApi) => void;
	/** Director state changes (mode / primary panel / ratio) for toolbar + overlay. */
	onDirectorStateChange?: (state: WorkspaceDirectorState) => void;
	/**
	 * Imperative handle to drive director mode. Mutations here keep the internal
	 * `directorRef` and layout persistence in sync; director mode is a pure
	 * overlay and never mutates the dockview layout (except `closePanel`).
	 */
	directorControlRef?: RefObject<DirectorControl | null>;
	/** Rendered inside the shared resource provider, below native floating panels. */
	directorOverlay?: ReactNode;
}

/** Extract the live narrator ids from the current Dockview layout. */
function collectLiveNarratorIds(api: DockviewApi): string[] {
	const ids: string[] = [];
	for (const panel of api.panels) {
		const params = panel.params as WorkspacePanelParams | undefined;
		if (params?.panelType === "narrator" && params.narratorId) ids.push(params.narratorId);
	}
	return ids;
}

/**
 * Whether a live panel is MEMBERSHIP (a row in `workspace_panels`).
 *
 * Narrower than `isDirectorRenderablePanel`, and the difference is load-bearing: a
 * plugin panel is director-renderable but is a narrator-owned resource, so no row is
 * ever created for it. Using the director predicate here made the membership sync see
 * every live plugin panel as a stale member and CLOSE it.
 */
function isMembershipPanel(params: WorkspacePanelParams): boolean {
	return (
		params.panelType === "narrator" ||
		params.panelType === "terminal" ||
		params.panelType === "webview"
	);
}

/**
 * Map a membership row onto the dockview params its panel component expects.
 *
 * Returns null for a row that cannot be rendered (a narrator row with no narrator id,
 * or a config-carrying kind whose config failed to parse). Skipping is right: the
 * alternative is mounting a panel with no identity, which renders as an empty cell the
 * user can neither use nor understand.
 */
function paramsForMember(member: WorkspacePanel): WorkspacePanelParams | null {
	if (member.kind === "narrator") {
		return member.narratorId ? { panelType: "narrator", narratorId: member.narratorId } : null;
	}
	const config = member.config;
	if (!config || typeof config !== "object") return null;
	// The stored config IS the params object for these kinds (that is how it was
	// captured), so `panelType` is re-asserted rather than trusted from storage.
	//
	// `panelRowId` comes from the row and is written AFTER the spread, never read from
	// storage: `WorkspaceMemberRowRef` makes it required precisely so a panel cannot
	// exist without its row, but spreading `config` alone satisfied the type only through
	// the cast below. Configs recovered from an older layout carry no `panelRowId` at all,
	// so `updateWebviewConfig` was building `/panels/undefined` — the write 404'd behind a
	// console.warn while the panel showed the edit as applied until the next open.
	return {
		...(config as Record<string, unknown>),
		panelType: member.kind,
		panelRowId: member.id,
	} as WorkspacePanelParams;
}

/** Snapshot the live panels as director leaves (id + params + title). */
function collectPanels(api: DockviewApi): DirectorLeaf[] {
	const leaves: DirectorLeaf[] = [];
	for (const panel of api.panels) {
		const params = panel.params as WorkspacePanelParams | undefined;
		if (!params) continue;
		// Cluster secondary panels are resources, not top-level director cells.
		if (!isDirectorRenderablePanel(params) || workspaceResourceOwner(params)) continue;
		leaves.push({ id: panel.api.id, params, title: panel.api.title ?? "" });
	}
	return leaves;
}

export function DockviewWorkspace({
	workspaceId,
	panels,
	treeJson,
	layoutRevision,
	onNarratorIdsChange,
	onMembershipChanged,
	onPanelsChange,
	onApiReady,
	onDirectorStateChange,
	directorControlRef,
	directorOverlay,
}: DockviewWorkspaceProps) {
	const { t } = useTranslation("narrators");
	const qc = useQueryClient();
	const apiRef = useRef<DockviewApi | null>(null);
	// Per-workspace dock store (shards tool-panel coordination by narratorId).
	// Created once, bound to this surface's api ref.
	const dockStoreRef = useRef<ReturnType<typeof createWorkspaceDockStore> | null>(null);
	if (!dockStoreRef.current) dockStoreRef.current = createWorkspaceDockStore(apiRef);
	const apiDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const directorRef = useRef<WorkspaceDirectorState>({ ...DEFAULT_DIRECTOR_STATE });
	const surfaceRootRef = useRef<HTMLDivElement>(null);
	const durableActiveGroupRef = useRef<string | null>(null);
	const observedArrangementRef = useRef<string | null>(null);
	const serializeCurrentLayout = useCallback(
		(api: DockviewApi) =>
			serializeWorkspaceLayout(
				api,
				directorRef.current,
				dockStoreRef.current?.getTemporaryPanelIds(),
				durableActiveGroupRef.current,
			),
		[],
	);
	/**
	 * Whether the user has edited the arrangement on THIS mount.
	 *
	 * This is the guard against a stale-query-cache clobber: when a refetch delivers
	 * a layout that differs from what the surface shows, a local edit means "keep
	 * the surface, the next persist makes the server agree", while no local edit
	 * means the server layout is strictly newer and the surface rebuilds from it.
	 * Local-first lasts only for this mount; remounting re-adopts server state.
	 */
	const localEditRef = useRef(false);
	/**
	 * The tree string the surface was last built from (or saved as).
	 *
	 * Compared against the incoming `treeJson` prop so a refetch that delivers the
	 * SAME layout (including our own save echoed through the query cache) does not
	 * trigger a rebuild. String equality is sufficient: the tree is serialized
	 * deterministically by `serializeWorkspaceLayout`.
	 */
	const builtTreeRef = useRef<string | null>(null);
	/**
	 * Suppresses the `onDidLayoutChange` handler while a rebuild is in flight.
	 *
	 * Rebuilding calls `fromJSON`, which fires layout-change events; without the
	 * flag those would set `localEditRef` (making every later server-side change
	 * invisible) and persist the rebuilt layout straight back (a pointless write
	 * that also bumps the revision). Both handlers check this before doing work.
	 */
	const suppressLayoutEventsRef = useRef(false);
	/** Narrator ids we have joined (via panels) and must leave on unmount. */
	const joinedNarratorIdsRef = useRef<Set<string>>(new Set());
	/** One save-failure notice per mount, so a failing debounce cannot spam. */
	const saveFailureNotifiedRef = useRef(false);

	// Keep latest treeJson without forcing effect re-runs on every keystroke.
	const treeJsonRef = useRef(treeJson);
	treeJsonRef.current = treeJson;
	/** Latest membership, read by the ready path and the unmount cleanup. */
	const panelsRef = useRef(panels);
	panelsRef.current = panels;
	/**
	 * Revision this client believes the server holds.
	 *
	 * A ref, not state: it is advanced by every successful save and by a 409's
	 * `currentRevision`, and re-rendering the whole surface on a bookkeeping value
	 * would be pure waste. Seeded from the prop, then owned locally — a refetch must
	 * not roll it backwards mid-flight.
	 */
	const layoutRevisionRef = useRef(layoutRevision);
	if (layoutRevisionRef.current < layoutRevision) layoutRevisionRef.current = layoutRevision;

	/**
	 * Surface a layout-save failure instead of dropping it.
	 *
	 * This used to be a bare `.catch(() => {})`, which is how a rejected save
	 * became invisible: the user keeps arranging panels, the server still holds the
	 * previous layout, and the next visit silently restores the older arrangement
	 * with no indication that anything was lost. The size is included because the
	 * most likely rejection is the server's `tree` byte ceiling, and knowing the
	 * payload size is what makes that diagnosable.
	 *
	 * Only the ARRANGEMENT is at stake here — membership lives in `workspace_panels`
	 * — which is why the wording says the layout was not saved rather than implying
	 * a panel was lost.
	 */
	const reportLayoutSaveFailure = useCallback(
		(id: string, serialized: string, error: unknown) => {
			const bytes = new TextEncoder().encode(serialized).byteLength;
			console.warn("[workspace] failed to persist layout", { workspaceId: id, bytes, error });
			if (saveFailureNotifiedRef.current) return;
			saveFailureNotifiedRef.current = true;
			notifications.show({
				color: "red",
				title: t("workspaceLayoutSaveFailedTitle"),
				message: t("workspaceLayoutSaveFailedMessage", { kb: Math.round(bytes / 1024) }),
			});
		},
		[t],
	);

	/**
	 * Reflect a successful layout save in the query cache.
	 *
	 * Without this the `["workspace", id]` entry keeps the tree from the last FETCH
	 * while the server holds a newer one — and since the entry survives unmount for
	 * `gcTime`, a quick leave-and-return mounts with the stale tree, restores the
	 * stale arrangement, and persists it straight back over the newer one on the
	 * next layout change. That round-trip is exactly how "my split layout never
	 * survives reopening the workspace" happened. The cache entry mirrors what the
	 * single-workspace GET returns (`layout` alongside `tree`).
	 */
	const commitSavedLayout = useCallback(
		(serialized: string, revision: number) => {
			layoutRevisionRef.current = revision;
			builtTreeRef.current = serialized;
			qc.setQueryData(workspaceQueryKey(workspaceId), (old: unknown) => {
				if (!old || typeof old !== "object") return old;
				return {
					...(old as Record<string, unknown>),
					tree: serialized,
					layout: serialized,
					layoutRevision: revision,
					updatedAt: new Date().toISOString(),
				};
			});
		},
		[qc, workspaceId],
	);

	/**
	 * Save the arrangement, rebasing once if another session saved first.
	 *
	 * A conflict is not an error worth showing: the layout carries positions only, so
	 * the worst case is that this client's arrangement yields to the other one. The
	 * single retry uses the revision the 409 carried, so recovery costs no extra read.
	 * Giving up after one retry is deliberate — an unbounded loop between two open tabs
	 * would keep re-saving on every drag frame.
	 */
	const saveLayout = useCallback(
		async (serialized: string) => {
			try {
				const result = await apiClient.saveWorkspaceLayout(
					workspaceId,
					serialized,
					layoutRevisionRef.current,
				);
				commitSavedLayout(serialized, result.layoutRevision);
			} catch (error) {
				if (isWorkspaceLayoutConflict(error)) {
					layoutRevisionRef.current = error.data.currentRevision;
					try {
						const retry = await apiClient.saveWorkspaceLayout(
							workspaceId,
							serialized,
							layoutRevisionRef.current,
						);
						commitSavedLayout(serialized, retry.layoutRevision);
					} catch (retryError) {
						if (isWorkspaceLayoutConflict(retryError)) {
							layoutRevisionRef.current = retryError.data.currentRevision;
							return;
						}
						reportLayoutSaveFailure(workspaceId, serialized, retryError);
					}
					return;
				}
				reportLayoutSaveFailure(workspaceId, serialized, error);
			}
		},
		[workspaceId, reportLayoutSaveFailure, commitSavedLayout],
	);

	const persist = useCallback(() => {
		const api = apiRef.current;
		if (!api) return;
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			const serialized = serializeCurrentLayout(api);
			if (serialized !== builtTreeRef.current) void saveLayout(serialized);
		}, SAVE_DEBOUNCE_MS);
	}, [saveLayout, serializeCurrentLayout]);

	// ── Director mode (pure overlay; never mutates the dockview layout) ──
	// All director mutations flow through the imperative handle so the persisted
	// `director` state stays in sync. Entering/leaving director mode and picking
	// a primary panel do NOT add/remove dockview panels, so they never trigger
	// the "workspace empty → navigate away" path (only closePanel can).
	const commitDirector = useCallback(
		(next: WorkspaceDirectorState) => {
			directorRef.current = next;
			// Tell the dock store so the underlying panel adapters unmount their
			// content while the director overlay hosts the live instances.
			dockStoreRef.current?.setDirectorActive(next.mode === "director");
			onDirectorStateChange?.(directorRef.current);
			persist();
		},
		[persist, onDirectorStateChange],
	);

	const setMode = useCallback(
		(mode: "grid" | "director") => {
			const api = apiRef.current;
			const primaryPanelId =
				mode === "director"
					? (directorRef.current.primaryPanelId ?? (api ? collectPanels(api)[0]?.id : null) ?? null)
					: directorRef.current.primaryPanelId;
			commitDirector({ ...directorRef.current, mode, primaryPanelId });
		},
		[commitDirector],
	);

	const setPrimary = useCallback(
		(panelId: string) => {
			commitDirector({ ...directorRef.current, primaryPanelId: panelId });
		},
		[commitDirector],
	);

	const setRatio = useCallback(
		(ratio: number) => {
			commitDirector({ ...directorRef.current, primaryRatio: ratio });
		},
		[commitDirector],
	);

	if (dockStoreRef.current)
		dockStoreRef.current.onRevealGrid = () => {
			if (directorRef.current.mode !== "grid") setMode("grid");
		};
	const openSubagentPanel = useCallback(
		(hostNarratorId: string, subagentNarratorId: string, messageId?: string) => {
			dockStoreRef.current?.openSubagentPanel(hostNarratorId, subagentNarratorId, messageId);
		},
		[],
	);

	const closePanel = useCallback((panelId: string) => {
		apiRef.current?.getPanel(panelId)?.api.close();
	}, []);

	const updatePanelParams = useCallback((panelId: string, params: WorkspacePanelParams) => {
		apiRef.current?.getPanel(panelId)?.api.updateParameters(params);
	}, []);

	const updateWebviewConfig = useCallback(
		(panelId: string, config: WebviewLeafConfig) => {
			const panel = apiRef.current?.getPanel(panelId);
			const current = panel?.params as WorkspacePanelParams | undefined;
			if (!panel || current?.panelType !== "webview") return;
			// Spread the live params so `panelRowId` survives; rebuilding the object from
			// scratch is exactly how identity gets lost.
			panel.api.updateParameters({ ...current, webviewConfig: config });
			// Refuse to build a URL out of a missing row id. `panelRowId` is required by the
			// type, but these params can arrive from a restored layout, so the value is only
			// as trustworthy as whatever wrote it: interpolating `undefined` produced a
			// request to `/panels/undefined`, which 404s into the catch below and reads as a
			// transient failure rather than the wiring bug it is.
			if (!current.panelRowId) {
				console.error("[workspace] webview panel has no membership row; config not saved", {
					workspaceId,
					panelId,
				});
				return;
			}
			// The config lives on the membership row, so it has to be persisted there —
			// the layout blob is arrangement only and would drop it.
			void apiClient
				.updateWorkspacePanelConfig(workspaceId, current.panelRowId, {
					panelType: "webview",
					webviewConfig: config,
				})
				.catch((error) => {
					console.warn("[workspace] failed to persist webview config", {
						workspaceId,
						panelRowId: current.panelRowId,
						error,
					});
				});
		},
		[workspaceId],
	);

	const updatePanelTitle = useCallback((panelId: string, title: string) => {
		apiRef.current?.getPanel(panelId)?.api.setTitle(title);
	}, []);

	useEffect(() => {
		if (!directorControlRef) return;
		directorControlRef.current = {
			setMode,
			setPrimary,
			setRatio,
			openSubagentPanel,
			closePanel,
			updatePanelParams,
			updateWebviewConfig,
			updatePanelTitle,
		};
		return () => {
			directorControlRef.current = null;
		};
	}, [
		directorControlRef,
		setMode,
		setPrimary,
		setRatio,
		openSubagentPanel,
		closePanel,
		updatePanelParams,
		updateWebviewConfig,
		updatePanelTitle,
	]);

	const syncNarratorIds = useCallback(() => {
		const api = apiRef.current;
		if (!api) return;
		// Close tool panels whose owning narrator cell is gone and reclaim dead
		// sharded state before recomputing, so orphans don't linger or accumulate.
		dockStoreRef.current?.pruneOrphanedClusters(api);
		// Refresh each narrator's open-tool set so cluster toolbars reflect the
		// live layout (open/close/drag of tool tabs).
		dockStoreRef.current?.refreshOpenToolTypes(api);
		const ids = collectLiveNarratorIds(api);
		onNarratorIdsChange?.(ids);
		onPanelsChange?.(collectPanels(api));
		joinedNarratorIdsRef.current = new Set(ids);
	}, [onNarratorIdsChange, onPanelsChange]);

	/**
	 * Add one member as a live dockview panel.
	 *
	 * Focuses an existing panel rather than adding a second one: membership is unique
	 * per narrator by database constraint, and the surface must reflect that.
	 */
	const addMemberPanel = useCallback((api: DockviewApi, member: WorkspacePanel) => {
		// Search by IDENTITY before adding. `getPanel(panelDomId(member))` is not enough:
		// a restored layout may already hold this member's cell under a different id (a
		// synthetic `dvp_*`), and adding a second panel for it is how a restored
		// arrangement got duplicated into the active group.
		const identity = memberIdentity(member);
		const existing = api.panels.find(
			(panel) =>
				livePanelIdentity(
					panel.params as unknown as Record<string, unknown> | undefined,
					panel.api.id,
				) === identity,
		);
		if (existing) {
			existing.api.setActive();
			return;
		}
		const params = paramsForMember(member);
		if (!params) return;
		api.addPanel({
			id: panelDomId(member),
			component: componentForParams(params),
			params,
			position: dockStoreRef.current?.getMemberPosition(durableActiveGroupRef.current) ?? {
				direction: "right",
			},
		});
	}, []);

	/**
	 * Panel ids this component closed ITSELF, which must not be detached from
	 * membership.
	 *
	 * `onDidRemovePanel` cannot tell "the user clicked the tab's ✕" from "the
	 * membership sync closed a panel whose row is already gone". Without this the
	 * second case would issue a DELETE for a row that no longer exists, and — worse —
	 * the reconciliation that prunes a stale panel during `buildSurface` would delete
	 * the very membership it is trying to render.
	 */
	const selfClosedPanelIdsRef = useRef<Set<string>>(new Set());

	/** Close a panel without letting `onDidRemovePanel` treat it as a user removal. */
	const closePanelInternally = useCallback((panel: { api: { id: string; close(): void } }) => {
		selfClosedPanelIdsRef.current.add(panel.api.id);
		panel.api.close();
	}, []);

	/**
	 * Remove a user-closed member panel from server-side membership.
	 *
	 * Only TOP-LEVEL panels are membership; dependent panels (tools, subagent sessions,
	 * file/knowledge viewers) are arrangement and are pruned by `pruneOrphanedClusters`,
	 * so closing one must NOT touch membership.
	 */
	const detachClosedMemberPanel = useCallback(
		async (panel: { api: { id: string }; params?: unknown }) => {
			if (selfClosedPanelIdsRef.current.delete(panel.api.id)) return;
			const params = panel.params as WorkspacePanelParams | undefined;
			if (!params || !isMembershipPanel(params)) return;
			const identity = livePanelIdentity(
				params as unknown as Record<string, unknown>,
				panel.api.id,
			);
			if (!identity) return;
			const member = panelsRef.current.find((candidate) => memberIdentity(candidate) === identity);
			// No row means this panel was never membership (e.g. it predates the row, or was
			// already removed elsewhere) — nothing to detach.
			if (!member) return;
			try {
				await apiClient.removeWorkspacePanel(workspaceId, member.id);
				await onMembershipChanged?.();
			} catch (error) {
				// The row survived, so the panel will legitimately reappear on the next
				// refresh. Saying so is better than leaving the user thinking it closed.
				console.warn("[workspace] failed to remove panel from membership", {
					workspaceId,
					panelId: member.id,
					error,
				});
				notifications.show({ color: "red", message: t("workspaceRemovePanelFailed") });
			}
		},
		[workspaceId, onMembershipChanged, t],
	);

	/** Latest `detachClosedMemberPanel`, for the once-registered removal listener. */
	const detachClosedMemberPanelRef = useRef(detachClosedMemberPanel);
	detachClosedMemberPanelRef.current = detachClosedMemberPanel;

	/**
	 * Materialise a narrator dropped onto this surface, as MEMBERSHIP.
	 *
	 * The drop handlers used to call `api.addPanel` directly. That produced a panel with
	 * no row, and the membership sync then closed it on the next `panels` change — the
	 * narrator appeared, then vanished a moment later with nothing logged. Dropping onto
	 * the sidebar's workspace row always went through this endpoint; only the canvas drop
	 * skipped it, so the two paths disagreed about what a drop means.
	 *
	 * The row is created first and the panel is left to the membership sync, which is what
	 * makes the surface converge on server state instead of a local guess. Placement is
	 * applied afterwards via `moveTo`, because the row carries `sortOrder` but no
	 * arrangement — waiting for the panel to appear is the only way to position it.
	 */
	const addDroppedNarrator = useCallback(
		async (
			api: DockviewApi,
			narratorId: string,
			place?: (panel: IDockviewPanel) => void,
		): Promise<void> => {
			try {
				await apiClient.addWorkspacePanel(workspaceId, { kind: "narrator", narratorId });
				await onMembershipChanged?.();
			} catch (error) {
				console.warn("[workspace] failed to add dropped narrator to membership", {
					workspaceId,
					narratorId,
					error,
				});
				notifications.show({ color: "red", message: t("workspaceAddPanelFailed") });
				return;
			}
			if (!place) return;
			// `onMembershipChanged` resolves once the refetch lands, but the sync effect that
			// turns the new row into a panel runs in a later commit. One frame is enough to
			// let that happen; if it has not, the panel keeps the default position rather
			// than the drop point — a cosmetic loss, not a missing panel.
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => resolve());
			});
			const panel = api.panels.find((candidate) => {
				const params = candidate.params as WorkspacePanelParams | undefined;
				return params?.panelType === "narrator" && params.narratorId === narratorId;
			});
			if (panel) place(panel);
		},
		[workspaceId, onMembershipChanged, t],
	);

	/**
	 * Build the surface from MEMBERSHIP, using the layout only for positions.
	 *
	 * The old code restored the layout and treated whatever came back as the panel
	 * set; when `fromJSON` threw it fell back to `resolveWorkspaceLayout(null)`, which
	 * yields ZERO panels — a blank workspace, which is the symptom this redesign
	 * removes. Here every failure path still ends with every member placed.
	 *
	 * Callers must ensure the surface is EMPTY first (initial mount, or
	 * `rebuildSurface` having closed every panel): the seed branch's `addPanel`
	 * calls do not dedupe against live panels.
	 */
	const buildSurface = useCallback(
		(api: DockviewApi) => {
			const members = panelsRef.current;
			const treeJson = treeJsonRef.current;
			const resolved = resolveWorkspaceLayout(treeJson);
			directorRef.current = resolved.director;
			// Seed the store's director flag from the restored state so underlying
			// panels start unmounted when a workspace reopens in director mode.
			dockStoreRef.current?.setDirectorActive(resolved.director.mode === "director");
			// Record the baseline the surface is being built from, so the stale-refresh
			// effect can tell "a refetch delivered this same tree" (nothing to do)
			// from "the server holds a different layout" (maybe rebuild).
			builtTreeRef.current = treeJson ?? null;

			if (resolved.kind === "seed") {
				// A freshly created workspace (sidebar drag). The seed carries PLACEMENT
				// only — honour it, or the two narrators collapse into one tab group
				// and the split the user just dragged is lost on first open.
				const seedPlan = planSeedMaterialisation(resolved.specs, members);
				for (const step of seedPlan.steps) {
					const params = paramsForMember(step.member);
					if (!params) continue;
					// The seed blob is persisted user data (it can arrive via a project-db
					// import), so an individual placement may be malformed even though the
					// plan builder sanitized references. One bad step must not abort the
					// loop: buildSurface runs before the layout listeners are registered,
					// so a throw here would leave a half-placed surface with no
					// persistence, no membership detach and no drag acceptance.
					try {
						api.addPanel({
							id: step.domId,
							component: componentForParams(params),
							params,
							position: step.position
								? {
										direction: step.position.direction,
										referencePanel: step.position.referenceDomId,
									}
								: undefined,
						});
					} catch (error) {
						console.warn("[workspace] seed placement failed; appending member instead", {
							workspaceId,
							member: step.member,
							error,
						});
						addMemberPanel(api, step.member);
					}
				}
				for (const member of seedPlan.appended) {
					addMemberPanel(api, member);
				}
				return;
			}

			const plan = reconcileLayoutWithPanels({
				panels: members,
				layout: resolved.kind === "dockview" ? resolved.layout : null,
			});
			if (plan.droppedPanelIds.length > 0) {
				console.warn("[workspace] dropped layout entries with no matching member", {
					workspaceId,
					droppedPanelIds: plan.droppedPanelIds,
				});
			}

			let restored = false;
			if (plan.layout) {
				try {
					api.fromJSON(plan.layout);
					restored = true;
				} catch (error) {
					// Dockview clears the surface before rethrowing, so the only safe
					// continuation is to place every member from scratch.
					console.warn("[workspace] layout restore failed; placing members instead", {
						workspaceId,
						error,
					});
				}
			}

			for (const member of restored ? plan.appended : members) {
				addMemberPanel(api, member);
			}
		},
		[workspaceId, addMemberPanel],
	);

	// ── Ready: build the surface from membership, wire events ──
	const handleReady = useCallback(
		(api: DockviewApi) => {
			apiRef.current = api;
			buildSurface(api);
			durableActiveGroupRef.current = api.activeGroup?.id ?? null;
			observedArrangementRef.current = serializeCurrentLayout(api);

			// Director mode is a pure overlay owned by the route; just report the
			// restored state so the toolbar + overlay reflect it.
			onDirectorStateChange?.(directorRef.current);
			syncNarratorIds();
			onApiReady?.(api);

			// Persist on any structural layout change (debounced).
			const disposables = [
				api.onDidLayoutChange(() => {
					// A rebuild (stale-refresh) runs `fromJSON`, which fires this event;
					// the suppression flag keeps that from being misread as a user edit.
					if (suppressLayoutEventsRef.current) return;
					dockStoreRef.current?.reconcileTemporaryResources();
					if (
						api.activePanel &&
						!dockStoreRef.current?.isTemporary(api.activePanel.id) &&
						api.activePanel.api.location.type === "grid"
					)
						durableActiveGroupRef.current = api.activePanel.group.id;
					const serialized = serializeCurrentLayout(api);
					if (serialized !== observedArrangementRef.current) {
						observedArrangementRef.current = serialized;
						localEditRef.current = true;
						persist();
					}
					syncNarratorIds();
				}),
				api.onDidActivePanelChange(({ panel }) => {
					if (
						panel &&
						!dockStoreRef.current?.isTemporary(panel.id) &&
						panel.api.location.type === "grid"
					) {
						durableActiveGroupRef.current = panel.group.id;
					}
				}),
				api.onDidAddPanel(() => syncNarratorIds()),
				api.onDidRemovePanel((panel) => {
					dockStoreRef.current?.forgetResource(panel.id);
					// A closed MEMBER panel has to be removed from membership, or the surface
					// and the server disagree: the row survives, and the next `panels` refresh
					// re-adds the panel the user just closed. ("The panel won't close / it
					// comes back" — the membership row is the authority, so closing has to
					// change the authority.)
					//
					// Called through a ref because this listener is registered once, in
					// `onReady`: capturing the callback directly would pin the first render's
					// `panels`, and detaching resolves the panel against that list.
					void detachClosedMemberPanelRef.current?.(panel);
					syncNarratorIds();
				}),
				// Accept our own native sidebar payload if it surfaces via HTML5 DnD.
				api.onUnhandledDragOver((e) => {
					const dt = "dataTransfer" in e.nativeEvent ? e.nativeEvent.dataTransfer : null;
					if (dt?.types.includes(WORKSPACE_DND_MIME)) e.accept();
				}),
			];
			apiDisposablesRef.current = disposables;
		},
		[
			persist,
			syncNarratorIds,
			onApiReady,
			onDirectorStateChange,
			buildSurface,
			serializeCurrentLayout,
		],
	);

	/**
	 * Rebuild the surface in place from the latest props.
	 *
	 * Used when a refetch delivers a different layout than the surface was built
	 * from and the user has no local edits to protect. Every live panel is closed
	 * through `closePanelInternally` so `onDidRemovePanel` does not detach the
	 * panel from membership, and layout events are suppressed so the rebuild's
	 * `fromJSON` is not misread as a user edit (which would set `localEditRef`
	 * and persist the rebuilt layout straight back).
	 */
	const rebuildSurface = useCallback(
		(api: DockviewApi) => {
			const temporaryResources = dockStoreRef.current?.captureTemporaryResources() ?? [];
			suppressLayoutEventsRef.current = true;
			try {
				for (const panel of [...api.panels]) closePanelInternally(panel);
				buildSurface(api);
				durableActiveGroupRef.current = api.activeGroup?.id ?? null;
				dockStoreRef.current?.restoreTemporaryResources(temporaryResources);
				observedArrangementRef.current = serializeCurrentLayout(api);
			} finally {
				suppressLayoutEventsRef.current = false;
			}
			// The per-event syncs were suppressed above; reconcile once, explicitly.
			syncNarratorIds();
		},
		[buildSurface, closePanelInternally, syncNarratorIds, serializeCurrentLayout],
	);

	/**
	 * Stale-cache guard: adopt a server-side layout delivered by a refetch.
	 *
	 * `buildSurface` runs once at mount against whatever the query cache held —
	 * which, for a workspace revisited within `gcTime`, is the tree from the
	 * PREVIOUS visit unless a save updated the cache in between. When the fresh
	 * fetch lands with a different tree this effect decides what to do (see
	 * `decideSurfaceRefresh`): without it the stale arrangement stayed on screen,
	 * and the next layout change persisted it back over the newer one — the
	 * round-trip that made split layouts "never survive reopening".
	 */
	useEffect(() => {
		const api = apiRef.current;
		if (!api) return;
		const decision = decideSurfaceRefresh({
			localEdit: localEditRef.current,
			builtTree: builtTreeRef.current,
			incomingTree: treeJson,
		});
		if (decision === "ignore") return;
		if (decision === "adopt-baseline") {
			// Local edits win on this mount; advance the baseline so a later
			// identical refetch is recognised as "ignore".
			builtTreeRef.current = treeJson ?? null;
			return;
		}
		rebuildSurface(api);
	}, [treeJson, rebuildSurface]);

	/**
	 * Reflect server-side membership changes onto a surface that is already mounted.
	 *
	 * Additions are placed; removals are closed. Both directions matter: a panel added
	 * from the sidebar arrives as a membership change, and a panel removed in another
	 * session must not linger here. The surface converges on the member list without
	 * anyone having to guess from the layout.
	 */
	useEffect(() => {
		const api = apiRef.current;
		if (!api) return;

		// Index the LIVE surface by identity, not by expected dom id.
		//
		// A restored layout stores a narrator cell under whatever id it was persisted
		// with — often a synthetic `dvp_*` from a seeded or migrated layout, not the
		// narrator id. Comparing against `panelDomId` therefore matched nothing: every
		// member looked absent and every restored panel looked like a non-member, so this
		// effect re-added each one into the active group and closed the originals,
		// flattening a multi-pane arrangement into one pane of tabs.
		const liveByIdentity = new Map<string, (typeof api.panels)[number]>();
		for (const panel of api.panels) {
			const params = panel.params as WorkspacePanelParams | undefined;
			if (!params || !isMembershipPanel(params)) continue;
			const identity = livePanelIdentity(
				params as unknown as Record<string, unknown>,
				panel.api.id,
			);
			if (identity) liveByIdentity.set(identity, panel);
		}

		const memberIdentities = new Set<string>();
		for (const member of panels) {
			const identity = memberIdentity(member);
			memberIdentities.add(identity);
			if (!liveByIdentity.has(identity)) addMemberPanel(api, member);
		}
		for (const [identity, panel] of liveByIdentity) {
			// Internal close: this panel's row is already gone, so detaching again would
			// DELETE a row that does not exist (and, during a prune, could delete a row we
			// are in the middle of rendering).
			if (!memberIdentities.has(identity)) closePanelInternally(panel);
		}
	}, [panels, addMemberPanel, closePanelInternally]);

	// ── External drop from sidebar (native HTML5 payload) ──
	const handleDidDrop = useCallback(
		(event: DockviewDidDropEvent, api: DockviewApi) => {
			const payload = consumeWorkspaceDropPayload(event.nativeEvent);
			if (!payload) return;

			const params = payload.params;

			// If a panel for this narrator already exists, just focus it.
			if (params.panelType === "narrator") {
				const narratorId = params.narratorId;
				const existing = api.panels.find((p) => {
					const pp = p.params as WorkspacePanelParams | undefined;
					return pp?.panelType === "narrator" && pp.narratorId === narratorId;
				});
				if (existing) {
					existing.api.setActive();
					return;
				}
				// A narrator is membership: create the row and let the sync add the panel.
				// `moveTo` takes the drop `Position` directly; `positionToDirection` below is
				// for `addPanel`, which speaks `Direction` instead.
				const referenceGroup = event.group ?? undefined;
				const position = event.position;
				void addDroppedNarrator(api, narratorId, (panel) => {
					if (referenceGroup) panel.api.moveTo({ group: referenceGroup, position });
					panel.api.setActive();
				});
				return;
			}

			// Non-narrator payloads (tool/plugin cells) are arrangement, not membership —
			// they own no row, so they are added to the layout directly.
			api.addPanel({
				id: payload.id ?? nextWorkspacePanelId(),
				component: componentForParams(params),
				title: payload.title,
				params,
				position: {
					direction: positionToDirection(event.position),
					referenceGroup: event.group ?? undefined,
				},
			});
		},
		[addDroppedNarrator],
	);

	// ── Sidebar recent-tab drop (panel-drag singleton) ──
	// Existing panels are handled generically by DockviewSurface; here we only
	// materialise a recent-tab narrator that has no live panel yet.
	const handleDropSubject = useCallback(
		(drag: PanelDragState, target: DockviewDropTarget, api: DockviewApi) => {
			const narratorId = drag.id;
			// Only a real narrator subject can be materialised as a narrator panel;
			// tool/webview panel drags are handled generically by DockviewSurface.
			if (!narratorId || !isNarratorSubject(drag)) return;
			const group = api.groups.find((g) => g.id === target.groupId);
			if (!group) return;

			// A sidebar narrator has no live panel to swap; treat swap as merge.
			// Only a `Position` is needed now: both the existing-panel branch and the
			// membership branch place via `moveTo`, so the `Direction` that `addPanel`
			// wanted is gone along with the bare `addPanel` call.
			const position = target.intent === "swap" ? "center" : intentToPosition(target.intent);

			// Already open? move it to the target instead of duplicating.
			const existing = api.panels.find((p) => {
				const pp = p.params as WorkspacePanelParams | undefined;
				return pp?.panelType === "narrator" && pp.narratorId === narratorId;
			});
			if (existing) {
				existing.api.moveTo({ group, position });
				existing.api.setActive();
				return;
			}

			// Membership first, panel second — see `addDroppedNarrator`. Adding the panel here
			// left it rowless, and the membership sync closed it moments later.
			void addDroppedNarrator(api, narratorId, (panel) => {
				// Re-resolve the group: the sync's `addPanel` can have re-grouped the surface
				// between the drop and this callback, which would make the captured handle stale.
				const liveGroup = api.groups.find((g) => g.id === target.groupId) ?? group;
				panel.api.moveTo({ group: liveGroup, position });
				panel.api.setActive();
			});
		},
		[addDroppedNarrator],
	);

	useEffect(() => {
		const root = surfaceRootRef.current;
		if (!root) return;
		const onEscape = (event: KeyboardEvent) => {
			// React's delegated handlers run after this native ancestor listener. Let
			// editors/menus consume the event before deciding whether to dismiss.
			queueMicrotask(() => dockStoreRef.current?.closeFocusedTemporaryResource(event));
		};
		root.addEventListener("keydown", onEscape);
		return () => root.removeEventListener("keydown", onEscape);
	}, []);
	// Director hides only the ordinary grid, never the floating resource ancestors.
	useEffect(() => {
		const root = surfaceRootRef.current;
		const api = apiRef.current;
		if (!root || !api) return;
		const previous = new Map<HTMLElement, { inert: boolean; aria: string | null }>();
		let frame = 0;
		const restore = (element: HTMLElement) => {
			const saved = previous.get(element);
			if (!saved) return;
			element.inert = saved.inert;
			if (saved.aria === null) element.removeAttribute("aria-hidden");
			else element.setAttribute("aria-hidden", saved.aria);
			previous.delete(element);
		};
		const sync = () => {
			for (const element of previous.keys()) {
				if (
					!directorOverlay ||
					element.classList.contains("dv-render-overlay-float") ||
					!element.isConnected
				)
					restore(element);
			}
			if (!directorOverlay) return;
			for (const element of root.querySelectorAll<HTMLElement>(
				".dv-grid-view.dv-dockview, .dv-render-overlay:not(.dv-render-overlay-float)",
			)) {
				if (!previous.has(element))
					previous.set(element, {
						inert: element.inert,
						aria: element.getAttribute("aria-hidden"),
					});
				element.inert = true;
				element.setAttribute("aria-hidden", "true");
			}
		};
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(sync);
		};
		sync();
		const subscription = api.onDidLayoutChange(schedule);
		return () => {
			subscription.dispose();
			cancelAnimationFrame(frame);
			for (const element of previous.keys()) restore(element);
		};
	}, [directorOverlay]);
	// ── Cleanup: leave narrators, dispose listeners, flush save ──
	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			const api = apiRef.current;
			if (api) {
				// Flush a final save (best-effort). No user-facing notice: the component is
				// unmounting, so a toast would land on whatever page the user navigated to.
				// The log line still records it, and only the arrangement is at stake.
				try {
					const serialized = serializeCurrentLayout(api);
					apiClient
						.saveWorkspaceLayout(workspaceId, serialized, layoutRevisionRef.current)
						.then((result) => {
							// Keep the cache in step even on the way out: the entry survives
							// unmount for `gcTime`, and a quick return mounts from it.
							commitSavedLayout(serialized, result.layoutRevision);
						})
						.catch((error) => {
							// A conflict here is expected and harmless: another session's
							// arrangement simply wins, and no panel is lost either way.
							if (isWorkspaceLayoutConflict(error)) return;
							console.warn("[workspace] failed to flush layout on unmount", {
								workspaceId,
								bytes: new TextEncoder().encode(serialized).byteLength,
								error,
							});
						});
				} catch (error) {
					console.warn("[workspace] failed to serialize layout on unmount", {
						workspaceId,
						error,
					});
				}
				for (const d of apiDisposablesRef.current) d.dispose();
				apiDisposablesRef.current = [];
				dockStoreRef.current?.disposeTemporaryResourceChrome();
			}
			// Leave every narrator this surface joined. Sourced from MEMBERSHIP rather
			// than by re-parsing the layout blob: the layout may omit a member (that is
			// the whole premise here), and a missed `leaveNarrator` leaks a subscription.
			const ids = new Set(joinedNarratorIdsRef.current);
			for (const member of panelsRef.current) {
				if (member.kind === "narrator" && member.narratorId) ids.add(member.narratorId);
			}
			for (const nId of ids) apiClient.leaveNarrator(nId).catch(() => {});
		};
	}, [workspaceId, commitSavedLayout, serializeCurrentLayout]);

	return (
		<WorkspaceDockProvider store={dockStoreRef.current} workspaceId={workspaceId}>
			<Box
				ref={surfaceRootRef}
				className={`workspace-resource-surface${directorOverlay ? " workspace-resource-director" : ""}`}
				style={{ position: "relative", height: "100%", width: "100%" }}
			>
				<DockviewSurface
					apiRef={apiRef}
					components={workspacePanelComponents}
					tabComponents={{ "workspace-resource": WorkspaceResourceTab }}
					floatingGroupBounds="boundedWithinViewport"
					onReady={handleReady}
					onDidDrop={handleDidDrop}
					onDropSubject={handleDropSubject}
					// Identifies this workspace's surface on panel drags, so only it treats
					// its own panel ids as local (see DockviewSurfaceProps.surfaceId).
					surfaceId={`workspace:${workspaceId}`}
					// Preserve panel component instances (live narrator sessions, terminals,
					// webviews) when panels are dragged/rearranged across groups.
					defaultRenderer="always"
				/>
				{directorOverlay && (
					<Box
						className="workspace-resource-director-overlay"
						style={{ position: "absolute", inset: 0 }}
					>
						{directorOverlay}
					</Box>
				)}
			</Box>
		</WorkspaceDockProvider>
	);
}
