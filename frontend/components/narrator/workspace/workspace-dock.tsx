/**
 * Per-narrator dock coordination for the multi-narrator workspace surface.
 *
 * The single-narrator focus page wraps its whole dockview surface in ONE
 * `NarratorDockProvider`, because every panel there belongs to the same
 * narrator. The workspace hosts MANY narrators on one dockview surface, so a
 * single provider can't work. Instead this module keeps a small store that
 * shards the same coordination state (published file-mod / details / browser
 * props, chat↔terminal bridges, and the open-tool set) by narratorId, and
 * exposes `useWorkspaceNarratorDockValue(narratorId)` which assembles a
 * `NarratorDockContextValue` bound to one narrator. Both the narrator cell and
 * its tool panels render inside `NarratorDockContext.Provider` fed by that
 * value, so `NarratorPanel` and the shared tool adapters behave exactly like on
 * the focus page — but their tool panels open as dockview sibling tabs scoped
 * to the right narrator.
 *
 * Tool panels use a narrator-namespaced dockview id (`wtool_<nid>_<type>`) so
 * several clusters never collide, and `resolveToolPlacement` reuses the focus
 * page's "first tool splits right ~1/3, the rest tab into that group" rule
 * (referencing the narrator's own cell instead of a `chat` panel).
 */

import type { FileReference, FileReferenceEditorSelection } from "@shared/file-reference";
import type { DockviewApi } from "dockview-react";
import {
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { useNarrator } from "../../../hooks/useNarrator";
import { PluginUiSurfaceProvider } from "../../plugins/PluginUiSurfaceContext";
import { filePanelIdentity, type NarratorToolPanelType } from "../dock/dock-panel-types";
import type { NarratorBrowserInfo, NarratorDockContextValue } from "../dock/NarratorDockContext";
import type {
	FileModPanelExternalProps,
	NarratorDetailsPanelExternalProps,
} from "../narrator-panel-types";
import { focusMessagePanel } from "../panels/focus-message-panel";
import {
	type FileOpenOptions,
	type FilePanelParams,
	type KnowledgeEntryScope,
	nextHighlightRequestId,
} from "../panels/panel-kind";
import { resolveFileBrowserPosition, resolveToolPlacement } from "../panels/tool-placement";
import type { ToolEditReference } from "../tool-call/tool-edit-reference";
import { PANEL_COMPONENT, type WorkspacePanelParams } from "./panel-types";

/** The published + bridged state we shard per narrator. */
interface NarratorDockShard {
	fileModProps: FileModPanelExternalProps | null;
	fileReferenceSelection: FileReferenceEditorSelection | null;
	detailsProps: NarratorDetailsPanelExternalProps | null;
	browserInfo: NarratorBrowserInfo;
	openToolTypes: ReadonlySet<NarratorToolPanelType>;
}

const EMPTY_TOOL_TYPES: ReadonlySet<NarratorToolPanelType> = new Set();

function emptyShard(): NarratorDockShard {
	return {
		fileModProps: null,
		fileReferenceSelection: null,
		detailsProps: null,
		browserInfo: { sessionCount: 0, visualChange: null },
		openToolTypes: EMPTY_TOOL_TYPES,
	};
}

/**
 * Stable shared empty shard for the (defensive) no-store path so
 * `useSyncExternalStore`'s getSnapshot returns a cached reference instead of a
 * fresh object on every call (which would violate its snapshot contract and
 * trip React's "getSnapshot should be cached" guard).
 */
const EMPTY_SHARD: NarratorDockShard = emptyShard();

/** Chat↔tool imperative bridges, kept per narrator (refs, not reactive). */
interface NarratorDockBridges {
	appendChatInput: ((text: string) => void) | null;
	writeTerminalStdin: ((text: string) => void) | null;
	scrollToMessage: ((messageId: string) => void) | null;
	/**
	 * Submit text as a real user message through the narrator's own composer path
	 * (used by the user-chat panel's "send to narrator"). See the note on the same
	 * field in `dock/NarratorDockContext.tsx`: going through the composer is what
	 * preserves busy-narrator buffering and slash-command handling.
	 */
	submitToNarrator: ((text: string) => void) | null;
	addFileReference: ((reference: FileReference) => void) | null;
}

/** Stable dockview panel id for a narrator-scoped tool panel. */
export function workspaceToolPanelId(narratorId: string, type: NarratorToolPanelType): string {
	return `wtool_${narratorId}_${type}`;
}

/** Stable panel id for one child session inside a narrator cluster. */
export function workspaceSubagentPanelId(
	hostNarratorId: string,
	subagentNarratorId: string,
): string {
	return `wsubagent_${hostNarratorId}_${subagentNarratorId}`;
}

/**
 * Stable panel id for one file viewer inside a narrator cluster. Uses the SAME
 * path hash as the focus dock (`hashFilePath`) so both surfaces agree on when a
 * file is already open; the raw path is unsafe in an id (separators, spaces,
 * length) and lives in the panel params instead.
 */
export function workspaceFilePanelId(
	hostNarratorId: string,
	filePath: string,
	deviceId = "local",
	toolEdit?: ToolEditReference,
	fileNarratorId?: string,
): string {
	return `wfile_${hostNarratorId}_${filePanelIdentity(filePath, deviceId, toolEdit, fileNarratorId === hostNarratorId ? undefined : fileNarratorId)}`;
}

/**
 * Stable panel id for one knowledge entry viewer inside a narrator cluster.
 * EntryId is a nanoid (safe chars, bounded length) so embedded directly.
 */
export function workspaceKnowledgePanelId(hostNarratorId: string, entryId: string): string {
	return `wknowledge_${hostNarratorId}_${entryId}`;
}

/**
 * A subscribable store that shards dock coordination state by narratorId. Uses
 * plain `useSyncExternalStore` semantics: each shard has a stable snapshot
 * object that is replaced (never mutated) on change so React can bail out of
 * updates for untouched narrators.
 */
export class WorkspaceDockStore {
	readonly apiRef: RefObject<DockviewApi | null>;
	private shards = new Map<string, NarratorDockShard>();
	private bridges = new Map<string, NarratorDockBridges>();
	private listeners = new Map<string, Set<() => void>>();
	// Director mode is a full-surface overlay (DirectorLayout) that hosts the live
	// panel instances itself. While it is active the underlying dockview panels
	// must render nothing so a narrator/terminal is never mounted twice (which
	// would double its WS subscription / xterm instance). This flag is surface-wide,
	// so it has its own listener set rather than the per-narrator shard listeners.
	private directorActive = false;
	private directorListeners = new Set<() => void>();

	constructor(apiRef: RefObject<DockviewApi | null>) {
		this.apiRef = apiRef;
	}

	subscribeDirector = (cb: () => void): (() => void) => {
		this.directorListeners.add(cb);
		return () => {
			this.directorListeners.delete(cb);
		};
	};

	getDirectorActive = (): boolean => this.directorActive;

	setDirectorActive(active: boolean): void {
		if (this.directorActive === active) return;
		this.directorActive = active;
		for (const fn of this.directorListeners) fn();
	}

	private emit(narratorId: string) {
		const set = this.listeners.get(narratorId);
		if (!set) return;
		for (const fn of set) fn();
	}

	subscribe = (narratorId: string, cb: () => void): (() => void) => {
		let set = this.listeners.get(narratorId);
		if (!set) {
			set = new Set();
			this.listeners.set(narratorId, set);
		}
		set.add(cb);
		return () => {
			set?.delete(cb);
			if (set && set.size === 0) this.listeners.delete(narratorId);
		};
	};

	getSnapshot = (narratorId: string): NarratorDockShard => {
		// Return the shared empty shard on miss WITHOUT storing it: getSnapshot is
		// called during render (useSyncExternalStore) and must be side-effect free
		// and return a stable reference. Real shards are only created in `patch`.
		return this.shards.get(narratorId) ?? EMPTY_SHARD;
	};

	private patch(narratorId: string, patch: Partial<NarratorDockShard>) {
		const prev = this.getSnapshot(narratorId);
		this.shards.set(narratorId, { ...prev, ...patch });
		this.emit(narratorId);
	}

	setFileModProps(narratorId: string, props: FileModPanelExternalProps | null) {
		if (this.getSnapshot(narratorId).fileModProps === props) return;
		this.patch(narratorId, { fileModProps: props });
	}

	setDetailsProps(narratorId: string, props: NarratorDetailsPanelExternalProps | null) {
		if (this.getSnapshot(narratorId).detailsProps === props) return;
		this.patch(narratorId, { detailsProps: props });
	}

	setBrowserInfo(narratorId: string, info: NarratorBrowserInfo) {
		const cur = this.getSnapshot(narratorId).browserInfo;
		if (cur.sessionCount === info.sessionCount && cur.visualChange === info.visualChange) return;
		this.patch(narratorId, { browserInfo: info });
	}

	private getBridges(narratorId: string): NarratorDockBridges {
		let b = this.bridges.get(narratorId);
		if (!b) {
			b = {
				appendChatInput: null,
				writeTerminalStdin: null,
				scrollToMessage: null,
				submitToNarrator: null,
				addFileReference: null,
			};
			this.bridges.set(narratorId, b);
		}
		return b;
	}

	setFileReferenceSelection(narratorId: string, selection: FileReferenceEditorSelection | null) {
		if (this.getSnapshot(narratorId).fileReferenceSelection === selection) return;
		this.patch(narratorId, { fileReferenceSelection: selection });
	}

	registerAddFileReference(narratorId: string, fn: (reference: FileReference) => void): () => void {
		const b = this.getBridges(narratorId);
		b.addFileReference = fn;
		return () => {
			if (b.addFileReference === fn) b.addFileReference = null;
		};
	}

	addFileReference(narratorId: string, reference: FileReference) {
		this.getBridges(narratorId).addFileReference?.(reference);
	}

	registerAppendChatInput(narratorId: string, fn: (text: string) => void): () => void {
		const b = this.getBridges(narratorId);
		b.appendChatInput = fn;
		return () => {
			if (b.appendChatInput === fn) b.appendChatInput = null;
		};
	}

	appendChatInput(narratorId: string, text: string) {
		this.getBridges(narratorId).appendChatInput?.(text);
	}

	registerWriteTerminalStdin(narratorId: string, fn: (text: string) => void): () => void {
		const b = this.getBridges(narratorId);
		b.writeTerminalStdin = fn;
		return () => {
			if (b.writeTerminalStdin === fn) b.writeTerminalStdin = null;
		};
	}

	writeTerminalStdin(narratorId: string, text: string) {
		this.getBridges(narratorId).writeTerminalStdin?.(text);
	}

	registerScrollToMessage(narratorId: string, fn: (messageId: string) => void): () => void {
		const b = this.getBridges(narratorId);
		b.scrollToMessage = fn;
		return () => {
			if (b.scrollToMessage === fn) b.scrollToMessage = null;
		};
	}

	registerSubmitToNarrator(narratorId: string, fn: (text: string) => void): () => void {
		const b = this.getBridges(narratorId);
		b.submitToNarrator = fn;
		return () => {
			if (b.submitToNarrator === fn) b.submitToNarrator = null;
		};
	}

	submitToNarrator(narratorId: string, text: string) {
		this.getBridges(narratorId).submitToNarrator?.(text);
	}

	scrollToMessage(narratorId: string, messageId: string) {
		this.getBridges(narratorId).scrollToMessage?.(messageId);
	}

	/**
	 * Recompute every narrator's open-tool set from the live layout. Called on
	 * layout change / add / remove by DockviewWorkspace.
	 */
	refreshOpenToolTypes(api: DockviewApi) {
		const byNarrator = new Map<string, Set<NarratorToolPanelType>>();
		for (const panel of api.panels) {
			const params = panel.params as WorkspacePanelParams | undefined;
			if (params?.panelType !== "narrator-tool") continue;
			let set = byNarrator.get(params.narratorId);
			if (!set) {
				set = new Set();
				byNarrator.set(params.narratorId, set);
			}
			set.add(params.toolType);
		}
		// Update shards for narrators whose tool set changed (add + clear).
		const touched = new Set<string>([...byNarrator.keys(), ...this.shards.keys()]);
		for (const narratorId of touched) {
			const next = byNarrator.get(narratorId) ?? EMPTY_TOOL_TYPES;
			const cur = this.getSnapshot(narratorId).openToolTypes;
			if (!sameToolSet(cur, next)) this.patch(narratorId, { openToolTypes: next });
		}
	}

	/**
	 * Reconcile per-narrator coordination state with the live layout. Any
	 * narrator that no longer has a cell (its `chat`/narrator panel was closed or
	 * dragged out) has its lingering tool panels closed and its sharded state
	 * (shard / bridges / listeners) released, so long-lived workspaces don't
	 * accumulate dead narrator entries. Returns true when it closed a panel.
	 */
	pruneOrphanedClusters(api: DockviewApi): boolean {
		const narratorsWithCell = new Set<string>();
		const secondaryHostIds = new Set<string>();
		for (const panel of api.panels) {
			const params = panel.params as WorkspacePanelParams | undefined;
			if (params?.panelType === "narrator") narratorsWithCell.add(params.narratorId);
			else if (params?.panelType === "narrator-tool") secondaryHostIds.add(params.narratorId);
			else if (params?.panelType === "subagent") secondaryHostIds.add(params.hostNarratorId);
			else if (params?.panelType === "file") secondaryHostIds.add(params.hostNarratorId);
			else if (params?.panelType === "knowledge") secondaryHostIds.add(params.hostNarratorId);
		}

		// Close every secondary panel whose owning narrator cell is gone.
		let closedAny = false;
		for (const panel of [...api.panels]) {
			const params = panel.params as WorkspacePanelParams | undefined;
			const hostNarratorId =
				params?.panelType === "narrator-tool"
					? params.narratorId
					: params?.panelType === "subagent" ||
							params?.panelType === "file" ||
							params?.panelType === "knowledge"
						? params.hostNarratorId
						: null;
			if (hostNarratorId && !narratorsWithCell.has(hostNarratorId)) {
				panel.api.close();
				closedAny = true;
			}
		}

		// Release sharded state for narrators that have neither a cell nor a secondary panel.
		for (const narratorId of [...this.shards.keys(), ...this.bridges.keys()]) {
			if (narratorsWithCell.has(narratorId) || secondaryHostIds.has(narratorId)) continue;
			// A live subscriber (its own useSyncExternalStore) would still hold a
			// listener; only reclaim when nothing is listening for this narrator.
			if (this.listeners.get(narratorId)?.size) continue;
			this.shards.delete(narratorId);
			this.bridges.delete(narratorId);
		}
		return closedAny;
	}

	openToolPanel(
		narratorId: string,
		type: NarratorToolPanelType,
		chapterId: string | null | undefined,
	) {
		const api = this.apiRef.current;
		if (!api) return;
		const id = workspaceToolPanelId(narratorId, type);
		const existing = api.getPanel(id);
		if (existing) {
			existing.api.setActive();
			return;
		}

		// The narrator's own cell is the cluster protagonist. Locate it by params
		// (the panel id is not always the narratorId — seeded/migrated layouts use
		// synthetic `dvp_*` ids), plus any existing secondary panel for THIS narrator
		// to stack alongside; otherwise split a new secondary group to its right.
		const narratorPanel = api.panels.find((p) => {
			const params = p.params as WorkspacePanelParams | undefined;
			return params?.panelType === "narrator" && params.narratorId === narratorId;
		});
		const existingSecondary = findClusterSecondary(api, narratorId);

		const params: WorkspacePanelParams = {
			panelType: "narrator-tool",
			toolType: type,
			narratorId,
			chapterId,
		};
		const placement = resolveToolPlacement({
			hasSecondaryGroup: !!existingSecondary?.group,
			hasChatPanel: !!narratorPanel,
			surfaceWidth: api.width,
		});

		if (placement.mode === "within-secondary" && existingSecondary?.group) {
			api.addPanel({
				id,
				component: PANEL_COMPONENT.narratorTool,
				params,
				position: { referenceGroup: existingSecondary.group },
			});
			return;
		}

		if (placement.mode === "split-right" && narratorPanel) {
			api.addPanel({
				id,
				component: PANEL_COMPONENT.narratorTool,
				params,
				initialWidth: placement.initialWidth,
				position: { referencePanel: narratorPanel.id, direction: "right" },
			});
			return;
		}

		// Defensive fallback (narrator cell not found by id).
		api.addPanel({ id, component: PANEL_COMPONENT.narratorTool, params });
	}

	openSubagentPanel(hostNarratorId: string, subagentNarratorId: string, messageId?: string) {
		const api = this.apiRef.current;
		if (!api || !subagentNarratorId) return;
		// A message can point to any primary already present in this workspace.
		// Resolve by narrator identity, not panel id or the caller's host identity.
		const primary = api.panels.find((panel) => {
			const params = panel.params as WorkspacePanelParams | undefined;
			return params?.panelType === "narrator" && params.narratorId === subagentNarratorId;
		});
		if (primary) {
			focusMessagePanel(api, primary, messageId, (id) =>
				this.scrollToMessage(subagentNarratorId, id),
			);
			return;
		}
		const id = workspaceSubagentPanelId(hostNarratorId, subagentNarratorId);
		const existing = api.getPanel(id);
		if (existing) {
			existing.api.setActive();
			// Re-ask an already-open panel to jump. The request token is what makes a
			// second click work; see `nextHighlightRequestId`.
			if (messageId) {
				existing.api.updateParameters({
					panelType: "subagent",
					hostNarratorId,
					subagentNarratorId,
					highlightMessageId: messageId,
					highlightRequestId: nextHighlightRequestId(),
				} satisfies WorkspacePanelParams);
			}
			return;
		}

		const narratorPanel = api.panels.find((panel) => {
			const params = panel.params as WorkspacePanelParams | undefined;
			return params?.panelType === "narrator" && params.narratorId === hostNarratorId;
		});
		const existingSecondary = findClusterSecondary(api, hostNarratorId);
		const params: WorkspacePanelParams = {
			panelType: "subagent",
			hostNarratorId,
			subagentNarratorId,
			// One-shot jump request, delivered as a param because the panel does not exist
			// yet; stripped before the layout is persisted (see stripIdentityFromLayout).
			...(messageId
				? { highlightMessageId: messageId, highlightRequestId: nextHighlightRequestId() }
				: {}),
		};
		const placement = resolveToolPlacement({
			hasSecondaryGroup: !!existingSecondary?.group,
			hasChatPanel: !!narratorPanel,
			surfaceWidth: api.width,
		});

		if (placement.mode === "within-secondary" && existingSecondary?.group) {
			api.addPanel({
				id,
				component: PANEL_COMPONENT.subagent,
				params,
				position: { referenceGroup: existingSecondary.group },
			});
			return;
		}

		if (placement.mode === "split-right" && narratorPanel) {
			api.addPanel({
				id,
				component: PANEL_COMPONENT.subagent,
				params,
				initialWidth: placement.initialWidth,
				position: { referencePanel: narratorPanel.id, direction: "right" },
			});
			return;
		}

		api.addPanel({ id, component: PANEL_COMPONENT.subagent, params });
	}

	/**
	 * Open (or focus) a read-only file viewer inside one narrator's cluster. Same
	 * placement rule as the other secondary panels; multi-instance, keyed by path.
	 */
	openFilePanel(
		hostNarratorId: string,
		filePath: string,
		fileName?: string,
		options: FileOpenOptions = {},
	) {
		const api = this.apiRef.current;
		if (!api || !filePath) return;
		const deviceId = options.deviceId ?? "local";
		const fileNarratorId =
			options.fileNarratorId === hostNarratorId ? undefined : options.fileNarratorId;
		const navigation = {
			deviceId,
			fileNarratorId,
			toolEdit: options.toolEdit,
			selection: options.selection,
			highlightRequestId: options.highlightRequestId ?? nextHighlightRequestId(),
		};
		const id = workspaceFilePanelId(
			hostNarratorId,
			filePath,
			deviceId,
			options.toolEdit,
			fileNarratorId,
		);
		const existing = api.getPanel(id);
		if (existing) {
			existing.api.updateParameters({
				...(existing.params as FilePanelParams),
				panelType: "file",
				hostNarratorId,
				filePath,
				...navigation,
				referenceOrigin:
					(existing.params as FilePanelParams)?.referenceOrigin === true ||
					options.referenceOrigin === true,
				...(fileName ? { fileName } : {}),
			});
			existing.api.setActive();
			return;
		}

		const narratorPanel = api.panels.find((panel) => {
			const params = panel.params as WorkspacePanelParams | undefined;
			return params?.panelType === "narrator" && params.narratorId === hostNarratorId;
		});
		const existingSecondary = findClusterSecondary(api, hostNarratorId);
		const params: WorkspacePanelParams = {
			panelType: "file",
			hostNarratorId,
			filePath,
			...navigation,
			referenceOrigin: options.referenceOrigin === true,
			...(fileName ? { fileName } : {}),
		};
		const browserPosition = resolveFileBrowserPosition(api, options.sourcePanelId);
		if (browserPosition) {
			api.addPanel({ id, component: PANEL_COMPONENT.file, params, position: browserPosition });
			return;
		}
		const placement = resolveToolPlacement({
			hasSecondaryGroup: !!existingSecondary?.group,
			hasChatPanel: !!narratorPanel,
			surfaceWidth: api.width,
		});

		if (placement.mode === "within-secondary" && existingSecondary?.group) {
			api.addPanel({
				id,
				component: PANEL_COMPONENT.file,
				params,
				position: { referenceGroup: existingSecondary.group },
			});
			return;
		}

		if (placement.mode === "split-right" && narratorPanel) {
			api.addPanel({
				id,
				component: PANEL_COMPONENT.file,
				params,
				initialWidth: placement.initialWidth,
				position: { referencePanel: narratorPanel.id, direction: "right" },
			});
			return;
		}

		api.addPanel({ id, component: PANEL_COMPONENT.file, params });
	}

	/**
	 * Open (or focus) a knowledge entry panel inside one narrator's cluster.
	 * Same placement rule as file/subagent panels; multi-instance, keyed by entry.
	 */
	openKnowledgePanel(
		hostNarratorId: string,
		entryId: string,
		scope: "global" | "personal" = "global",
	) {
		const api = this.apiRef.current;
		if (!api || !entryId) return;
		const id = workspaceKnowledgePanelId(hostNarratorId, entryId);
		const existing = api.getPanel(id);
		if (existing) {
			existing.api.setActive();
			return;
		}

		const narratorPanel = api.panels.find((panel) => {
			const params = panel.params as WorkspacePanelParams | undefined;
			return params?.panelType === "narrator" && params.narratorId === hostNarratorId;
		});
		const existingSecondary = findClusterSecondary(api, hostNarratorId);
		const params: WorkspacePanelParams = {
			panelType: "knowledge",
			hostNarratorId,
			entryId,
			scope,
		};
		const placement = resolveToolPlacement({
			hasSecondaryGroup: !!existingSecondary?.group,
			hasChatPanel: !!narratorPanel,
			surfaceWidth: api.width,
		});

		if (placement.mode === "within-secondary" && existingSecondary?.group) {
			api.addPanel({
				id,
				component: PANEL_COMPONENT.knowledge,
				params,
				position: { referenceGroup: existingSecondary.group },
			});
			return;
		}

		if (placement.mode === "split-right" && narratorPanel) {
			api.addPanel({
				id,
				component: PANEL_COMPONENT.knowledge,
				params,
				initialWidth: placement.initialWidth,
				position: { referencePanel: narratorPanel.id, direction: "right" },
			});
			return;
		}

		api.addPanel({ id, component: PANEL_COMPONENT.knowledge, params });
	}

	closeToolPanel(narratorId: string, type: NarratorToolPanelType) {
		this.apiRef.current?.getPanel(workspaceToolPanelId(narratorId, type))?.api.close();
	}

	toggleToolPanel(
		narratorId: string,
		type: NarratorToolPanelType,
		chapterId: string | null | undefined,
	) {
		if (this.apiRef.current?.getPanel(workspaceToolPanelId(narratorId, type))) {
			this.closeToolPanel(narratorId, type);
		} else {
			this.openToolPanel(narratorId, type, chapterId);
		}
	}
}

/**
 * Any already-open secondary panel of one narrator's cluster (tool / subagent /
 * file). Used to decide whether a newly-opened secondary stacks as a tab in the
 * existing group or splits a fresh one to the cell's right.
 */
function findClusterSecondary(api: DockviewApi, hostNarratorId: string) {
	return api.panels.find((panel) => {
		const params = panel.params as WorkspacePanelParams | undefined;
		if (!params) return false;
		if (params.panelType === "narrator-tool") return params.narratorId === hostNarratorId;
		if (
			params.panelType === "subagent" ||
			params.panelType === "file" ||
			params.panelType === "knowledge"
		) {
			return params.hostNarratorId === hostNarratorId;
		}
		return false;
	});
}

function sameToolSet(
	a: ReadonlySet<NarratorToolPanelType>,
	b: ReadonlySet<NarratorToolPanelType>,
): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) if (!b.has(v)) return false;
	return true;
}

/** Public handle type for the workspace dock store (opaque to consumers). */
export type WorkspaceDockStoreHandle = WorkspaceDockStore;

/** Create a workspace dock store bound to a surface's live DockviewApi ref. */
export function createWorkspaceDockStore(
	apiRef: RefObject<DockviewApi | null>,
): WorkspaceDockStoreHandle {
	return new WorkspaceDockStore(apiRef);
}

const WorkspaceDockCtx = createContext<WorkspaceDockStore | null>(null);

/**
 * The surface's workspace id, for descendants that must write to `workspace_panels`.
 *
 * `WorkspaceDockProvider` already received this to build the plugin-ui host context, but
 * that shape is opaque to ordinary panels. A panel adapter that edits row-owned state
 * (a webview's config) needs the id to persist it, and without it the edit reached only
 * the layout blob — where it is dropped whenever the layout is discarded.
 */
const WorkspaceIdCtx = createContext<string | null>(null);

/**
 * Provide a per-workspace dock store to narrator cells + tool panels (all React
 * descendants of `<DockviewReact>`). The store is created + owned by
 * `DockviewWorkspace` (which also drives `refreshOpenToolTypes` on layout
 * changes), so it is passed in rather than created here.
 */
export function WorkspaceDockProvider({
	store,
	workspaceId,
	children,
}: {
	store: WorkspaceDockStoreHandle;
	workspaceId: string;
	children: ReactNode;
}) {
	return (
		<PluginUiSurfaceProvider
			hostContext={{ surface: "workspace", workspaceId, presentation: "grid" }}
		>
			<WorkspaceIdCtx.Provider value={workspaceId}>
				<WorkspaceDockCtx.Provider value={store}>{children}</WorkspaceDockCtx.Provider>
			</WorkspaceIdCtx.Provider>
		</PluginUiSurfaceProvider>
	);
}

/** Access the workspace dock store, or null when outside a provider. */
export function useWorkspaceDock(): WorkspaceDockStore | null {
	return useContext(WorkspaceDockCtx);
}

/**
 * The enclosing workspace's id, or null on the focus page (no workspace surface).
 *
 * Null is a meaningful answer, not a missing one: the same panel adapters render inside a
 * single narrator's dock, where there is no membership row to write to.
 */
export function useWorkspaceId(): string | null {
	return useContext(WorkspaceIdCtx);
}

/**
 * Subscribe to whether director mode (the full-surface overlay) is active.
 * The underlying dockview panel adapters use this to render nothing while the
 * overlay holds the live panel instances, preventing a double mount.
 */
export function useWorkspaceDirectorActive(): boolean {
	const store = useWorkspaceDock();
	return useSyncExternalStore(
		useCallback((cb: () => void) => (store ? store.subscribeDirector(cb) : () => {}), [store]),
		useCallback(() => (store ? store.getDirectorActive() : false), [store]),
	);
}

/**
 * Assemble a `NarratorDockContextValue` bound to one narrator, backed by the
 * shared workspace store. Feed it into `NarratorDockContext.Provider` around
 * both the narrator cell and its tool panels so they coordinate exactly like
 * the focus page. Returns null when rendered outside a `WorkspaceDockProvider`.
 */
export function useWorkspaceNarratorDockValue(narratorId: string): NarratorDockContextValue | null {
	const store = useWorkspaceDock();

	const shard = useSyncExternalStore(
		useCallback(
			(cb: () => void) => (store ? store.subscribe(narratorId, cb) : () => {}),
			[store, narratorId],
		),
		useCallback(() => (store ? store.getSnapshot(narratorId) : EMPTY_SHARD), [store, narratorId]),
	);

	// Chapter id (for the git tool). Subagents have no chapter; standalone
	// narrators return undefined — both fine, the git adapter degrades.
	const { data: narrator } = useNarrator(narratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON entity
	const chapterId = (narrator as any)?.chapterId as string | null | undefined;
	const chapterIdRef = useRef<string | null | undefined>(chapterId);
	chapterIdRef.current = chapterId;

	// Stable methods (keyed on store + narrator only, NOT on the reactive shard)
	// so consumers that key effects on callback identity — e.g. NarratorPanel's
	// file-mod / details / browser publish effects — don't re-run on every shard
	// update. Mirrors the focus page's stable `useState` setters.
	const methods = useMemo(() => {
		if (!store) return null;
		return {
			setFileModProps: (props: FileModPanelExternalProps | null) =>
				store.setFileModProps(narratorId, props),
			setDetailsProps: (props: NarratorDetailsPanelExternalProps | null) =>
				store.setDetailsProps(narratorId, props),
			setBrowserInfo: (info: NarratorBrowserInfo) => store.setBrowserInfo(narratorId, info),
			setFileReferenceSelection: (selection: FileReferenceEditorSelection | null) =>
				store.setFileReferenceSelection(narratorId, selection),
			registerAddFileReference: (fn: (reference: FileReference) => void) =>
				store.registerAddFileReference(narratorId, fn),
			addFileReference: (reference: FileReference) => store.addFileReference(narratorId, reference),
			registerAppendChatInput: (fn: (text: string) => void) =>
				store.registerAppendChatInput(narratorId, fn),
			appendChatInput: (text: string) => store.appendChatInput(narratorId, text),
			registerWriteTerminalStdin: (fn: (text: string) => void) =>
				store.registerWriteTerminalStdin(narratorId, fn),
			writeTerminalStdin: (text: string) => store.writeTerminalStdin(narratorId, text),
			registerScrollToMessage: (fn: (messageId: string) => void) =>
				store.registerScrollToMessage(narratorId, fn),
			scrollToMessage: (messageId: string) => store.scrollToMessage(narratorId, messageId),
			registerSubmitToNarrator: (fn: (text: string) => void) =>
				store.registerSubmitToNarrator(narratorId, fn),
			submitToNarrator: (text: string) => store.submitToNarrator(narratorId, text),
			refreshOpenToolTypes: () => {
				const api = store.apiRef.current;
				if (api) store.refreshOpenToolTypes(api);
			},
			openToolPanel: (type: NarratorToolPanelType) =>
				store.openToolPanel(narratorId, type, chapterIdRef.current),
			openSubagentPanel: (subagentNarratorId: string, messageId?: string) =>
				store.openSubagentPanel(narratorId, subagentNarratorId, messageId),
			openFilePanel: (filePath: string, fileName?: string, options?: FileOpenOptions) =>
				store.openFilePanel(narratorId, filePath, fileName, options),
			openKnowledgePanel: (entryId: string, scope?: KnowledgeEntryScope) =>
				store.openKnowledgePanel(narratorId, entryId, scope),
			closeToolPanel: (type: NarratorToolPanelType) => store.closeToolPanel(narratorId, type),
			toggleToolPanel: (type: NarratorToolPanelType) =>
				store.toggleToolPanel(narratorId, type, chapterIdRef.current),
		};
	}, [store, narratorId]);

	return useMemo<NarratorDockContextValue | null>(() => {
		if (!store || !methods) return null;
		return {
			narratorId,
			chapterId,
			// Workspace does not wire page-level navigation or deep-link highlight.
			onForkFromMessage: null,
			highlightMessageId: undefined,
			onBack: null,
			onMinimize: null,
			apiRef: store.apiRef,
			fileModProps: shard.fileModProps,
			fileReferenceSelection: shard.fileReferenceSelection,
			detailsProps: shard.detailsProps,
			browserInfo: shard.browserInfo,
			openToolTypes: shard.openToolTypes,
			...methods,
		};
	}, [store, methods, narratorId, chapterId, shard]);
}
