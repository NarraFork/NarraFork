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
 * Resources use narrator-namespaced panel ids so clusters never collide. New
 * resources share a temporary native floating group; only an explicit pin or
 * drag changes the durable grid. Pin targets are selected relative to the
 * source, independently of resource ownership.
 */

import type { FileReference, FileReferenceEditorSelection } from "@shared/file-reference";
import type { AddPanelOptions, DockviewApi, IDockviewPanel } from "dockview-react";
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
import type { PluginContributionPick } from "../../plugins/PluginContributionPicker";
import { buildPluginDockPanelOpenRequest } from "../../plugins/PluginContributionPicker";
import type { PluginUiSessionContext } from "../../plugins/PluginUiSurfaceContext";
import { PluginUiSurfaceProvider } from "../../plugins/PluginUiSurfaceContext";
import { filePanelIdentity, type NarratorToolPanelType } from "../dock/dock-panel-types";
import type { NarratorBrowserInfo, NarratorDockContextValue } from "../dock/NarratorDockContext";
import type { NarratorDetailsPanelExternalProps } from "../narrator-panel-types";
import { focusMessagePanel } from "../panels/focus-message-panel";
import {
	type FileOpenOptions,
	type FilePanelParams,
	type KnowledgeEntryScope,
	nextHighlightRequestId,
} from "../panels/panel-kind";
import type { ToolEditReference } from "../tool-call/tool-edit-reference";
import { PANEL_COMPONENT, type WorkspacePanelParams } from "./panel-types";
import {
	floatingResourceBounds,
	rankResourceTargets,
	resourceSplitDirection,
} from "./resource-placement";

/** The published + bridged state we shard per narrator. */
interface NarratorDockShard {
	fileReferenceSelection: FileReferenceEditorSelection | null;
	detailsProps: NarratorDetailsPanelExternalProps | null;
	browserInfo: NarratorBrowserInfo;
	openToolTypes: ReadonlySet<NarratorToolPanelType>;
}

const EMPTY_TOOL_TYPES: ReadonlySet<NarratorToolPanelType> = new Set();

function emptyShard(): NarratorDockShard {
	return {
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
	private temporary = new Map<
		string,
		{ hostNarratorId: string; sourcePanelId?: string; opener: Element | null }
	>();
	private resourceRevision = 0;
	private resourceListeners = new Set<() => void>();
	/** Bound by the surface; a successful pin reveals the saved grid. */
	onRevealGrid: (() => void) | null = null;

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
		const narratorsWithCell = new Set(
			api.panels.flatMap((panel) =>
				panel.params?.panelType === "narrator" ? [panel.params.narratorId as string] : [],
			),
		);
		let closedAny = false;
		for (const panel of [...api.panels]) {
			const host = workspaceResourceOwner(panel.params as WorkspacePanelParams | undefined);
			if (host && !narratorsWithCell.has(host)) {
				this.forgetResource(panel.id);
				panel.api.close();
				closedAny = true;
			}
		}
		for (const narratorId of new Set([...this.shards.keys(), ...this.bridges.keys()])) {
			if (narratorsWithCell.has(narratorId) || this.listeners.get(narratorId)?.size) continue;
			this.shards.delete(narratorId);
			this.bridges.delete(narratorId);
		}
		return closedAny;
	}

	subscribeResources = (cb: () => void): (() => void) => {
		this.resourceListeners.add(cb);
		return () => {
			this.resourceListeners.delete(cb);
		};
	};
	getResourceRevision = (): number => this.resourceRevision;
	private emitResources() {
		this.resourceRevision++;
		for (const cb of this.resourceListeners) cb();
	}
	getTemporaryPanelIds(): ReadonlySet<string> {
		return new Set(this.temporary.keys());
	}
	isTemporary(id: string): boolean {
		return this.temporary.has(id);
	}

	/** Keep transient descriptions across an externally requested layout rebuild. */
	captureTemporaryResources() {
		const api = this.apiRef.current;
		if (!api) return [];
		return [...this.temporary].flatMap(([id, origin]) => {
			const panel = api.getPanel(id);
			return panel
				? [
						{
							id,
							origin,
							component: panel.view.contentComponent,
							params: panel.params,
							title: panel.api.title,
						},
					]
				: [];
		});
	}
	restoreTemporaryResources(
		resources: ReturnType<WorkspaceDockStore["captureTemporaryResources"]>,
	) {
		const api = this.apiRef.current;
		if (!api) return;
		for (const resource of resources) {
			if (!this.narratorPanel(resource.origin.hostNarratorId)) continue;
			this.openResource(
				resource.origin.hostNarratorId,
				{
					id: resource.id,
					component: resource.component,
					params: resource.params,
					title: resource.title,
				},
				resource.origin.sourcePanelId,
			);
		}
	}

	private narratorPanel(narratorId: string) {
		return this.apiRef.current?.panels.find(
			(panel) => panel.params?.panelType === "narrator" && panel.params.narratorId === narratorId,
		);
	}
	private sourcePanel(id: string) {
		const origin = this.temporary.get(id);
		if (!origin) return undefined;
		const api = this.apiRef.current;
		const explicit = origin.sourcePanelId ? api?.getPanel(origin.sourcePanelId) : undefined;
		if (explicit?.api.location.type === "grid") return explicit;
		const narrator = this.narratorPanel(origin.hostNarratorId);
		return narrator?.api.location.type === "grid" ? narrator : undefined;
	}
	activateResource(panel: IDockviewPanel) {
		if (panel.api.location.type !== "floating") this.onRevealGrid?.();
		panel.api.setActive();
	}

	private openResource(
		hostNarratorId: string,
		request: Pick<AddPanelOptions, "id" | "component" | "params" | "title">,
		sourcePanelId?: string,
	) {
		const api = this.apiRef.current;
		if (!api) return;
		const existing = api.getPanel(request.id);
		if (existing) {
			this.activateResource(existing);
			return;
		}
		const narrator = this.narratorPanel(hostNarratorId);
		if (!narrator) return;
		// The caller's host, not global activePanel: Director's active narrator
		// can differ from the hidden grid's last focused resource.
		const source = sourcePanelId ? api.getPanel(sourcePanelId) : narrator;
		this.temporary.set(request.id, {
			hostNarratorId,
			sourcePanelId: source?.api.location.type === "grid" ? source.id : narrator.id,
			opener: typeof document === "undefined" ? null : document.activeElement,
		});
		const floating = api.panels.find(
			(panel) => this.isTemporary(panel.id) && panel.api.location.type === "floating",
		);
		try {
			api.addPanel({
				...request,
				tabComponent: "workspace-resource",
				renderer: "always",
				...(floating
					? { position: { referenceGroup: floating.group } }
					: {
							floating:
								floatingResourceBounds(api.width, api.height, narrator.group.api.boundingBox) ??
								true,
						}),
			});
			this.emitResources();
		} catch (error) {
			this.temporary.delete(request.id);
			this.emitResources();
			throw error;
		}
	}

	openPluginPanel(
		hostNarratorId: string,
		pick: PluginContributionPick,
		hostContext: PluginUiSessionContext,
	) {
		const api = this.apiRef.current;
		if (!api) return;
		const existing = api.panels.find((panel) => {
			const params = panel.params as WorkspacePanelParams | undefined;
			return (
				params?.panelType === "plugin" &&
				params.binding?.kind === "workspace-narrator" &&
				params.binding.workspaceId === hostContext.workspaceId &&
				workspaceResourceOwner(params) === hostNarratorId &&
				params.pluginId === pick.pluginId &&
				params.contributionId === pick.contributionId
			);
		});
		if (existing) {
			this.activateResource(existing);
			return;
		}
		const { position: _position, ...request } = buildPluginDockPanelOpenRequest({
			pick,
			hostContext,
			panels: [],
		});
		this.openResource(hostNarratorId, request);
	}

	/** Membership additions must never inherit a transient floating activeGroup. */
	getMemberPosition(preferredGroupId?: string | null): AddPanelOptions["position"] {
		const api = this.apiRef.current;
		const preferred = api?.panels.find(
			(panel) => panel.group.id === preferredGroupId && panel.api.location.type === "grid",
		);
		const grid = preferred ?? api?.panels.find((panel) => panel.api.location.type === "grid");
		return grid ? { referenceGroup: grid.group } : { direction: "right" };
	}
	getPinTargets(id: string) {
		const api = this.apiRef.current;
		const source = this.sourcePanel(id);
		const rect = source?.group.api.boundingBox;
		if (!api || !source || !rect) return [];
		const candidates = api.groups.flatMap((group) => {
			const bounds = group.api.boundingBox;
			return group.api.location.type === "grid" &&
				group.api.isVisible &&
				!group.api.locked &&
				bounds &&
				group !== source.group &&
				!group.api.isMaximized()
				? [{ id: group.id, ...bounds }]
				: [];
		});
		return rankResourceTargets({ id: source.group.id, ...rect }, candidates).flatMap(
			(candidate) => {
				const group = api.panels.find((panel) => panel.group.id === candidate.id)?.group;
				return group ? [{ group, title: group.activePanel?.api.title ?? group.id }] : [];
			},
		);
	}
	canCreateResourceSplit(id: string): boolean {
		const source = this.sourcePanel(id);
		const rect = source?.group.api.boundingBox;
		return (
			!!source && !source.group.api.isMaximized() && !!rect && resourceSplitDirection(rect) !== null
		);
	}
	pinResource(id: string, targetGroupId?: string, createSplit = false): boolean {
		const api = this.apiRef.current;
		const panel = api?.getPanel(id);
		if (!api || !panel || !this.isTemporary(id)) return false;
		const source = this.sourcePanel(id);
		const target = targetGroupId
			? this.getPinTargets(id).find((entry) => entry.group.id === targetGroupId)
			: this.getPinTargets(id)[0];
		if (!source) return false;
		const direction =
			source.group.api.boundingBox && resourceSplitDirection(source.group.api.boundingBox);
		try {
			if (createSplit && direction && this.canCreateResourceSplit(id)) {
				panel.api.moveTo({
					group: source.group,
					position: direction === "below" ? "bottom" : "right",
				});
			} else if (!createSplit && target) {
				panel.api.moveTo({ group: target.group, position: "center" });
			} else return false;
			this.temporary.delete(id);
			this.onRevealGrid?.();
			panel.api.setActive();
			this.emitResources();
			return true;
		} catch (error) {
			console.warn("[workspace] failed to pin resource", { id, error });
			return false;
		}
	}

	/** Native drag into a grid is an explicit pin, not a new default placement. */
	reconcileTemporaryResources() {
		const api = this.apiRef.current;
		if (!api) return;
		let changed = false;
		let reveal = false;
		for (const id of this.temporary.keys()) {
			const panel = api.getPanel(id);
			if (!panel || panel.api.location.type !== "floating") {
				this.temporary.delete(id);
				changed = true;
				if (panel) reveal = true;
			}
		}
		if (reveal) this.onRevealGrid?.();
		if (changed) this.emitResources();
	}
	/** Only an unconsumed Escape inside a temporary, non-editor surface dismisses it. */
	closeFocusedTemporaryResource(event: KeyboardEvent): boolean {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey
		)
			return false;
		const target = event.target;
		if (
			!(target instanceof Element) ||
			target.closest(
				"input, textarea, select, [contenteditable], .xterm, .monaco-editor, [role=menu], [role=dialog]:not(.dv-resize-container)",
			)
		)
			return false;
		const panel = this.apiRef.current?.panels.find(
			(candidate) =>
				this.isTemporary(candidate.id) &&
				candidate.api.isVisible &&
				candidate.api.location.type === "floating" &&
				(candidate.view.content.element.contains(target) ||
					candidate.group.element.contains(target)),
		);
		if (!panel) return false;
		panel.api.close();
		return true;
	}
	forgetResource(id: string) {
		const origin = this.temporary.get(id);
		if (!this.temporary.delete(id)) return;
		this.emitResources();
		if (origin?.opener?.isConnected && "focus" in origin.opener)
			(origin.opener as HTMLElement).focus();
	}
	openToolPanel(
		narratorId: string,
		type: NarratorToolPanelType,
		chapterId: string | null | undefined,
		sourcePanelId?: string,
	) {
		this.openResource(
			narratorId,
			{
				id: workspaceToolPanelId(narratorId, type),
				component: PANEL_COMPONENT.narratorTool,
				params: { panelType: "narrator-tool", toolType: type, narratorId, chapterId },
			},
			sourcePanelId,
		);
	}

	openSubagentPanel(
		hostNarratorId: string,
		subagentNarratorId: string,
		messageId?: string,
		sourcePanelId?: string,
	) {
		const api = this.apiRef.current;
		if (!api || !subagentNarratorId) return;
		const primary = api.panels.find((panel) => {
			const params = panel.params as WorkspacePanelParams | undefined;
			return params?.panelType === "narrator" && params.narratorId === subagentNarratorId;
		});
		if (primary) {
			this.activateResource(primary);
			focusMessagePanel(api, primary, messageId, (id) =>
				this.scrollToMessage(subagentNarratorId, id),
			);
			return;
		}
		const params: WorkspacePanelParams = {
			panelType: "subagent",
			hostNarratorId,
			subagentNarratorId,
			...(messageId
				? { highlightMessageId: messageId, highlightRequestId: nextHighlightRequestId() }
				: {}),
		};
		const existing = api.getPanel(workspaceSubagentPanelId(hostNarratorId, subagentNarratorId));
		if (existing) {
			if (messageId) existing.api.updateParameters(params);
			this.activateResource(existing);
			return;
		}
		this.openResource(
			hostNarratorId,
			{
				id: workspaceSubagentPanelId(hostNarratorId, subagentNarratorId),
				component: PANEL_COMPONENT.subagent,
				params,
			},
			sourcePanelId,
		);
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
		const id = workspaceFilePanelId(
			hostNarratorId,
			filePath,
			deviceId,
			options.toolEdit,
			fileNarratorId,
		);
		const existing = api.getPanel(id);
		const params: WorkspacePanelParams = {
			...(existing?.params as FilePanelParams | undefined),
			panelType: "file",
			hostNarratorId,
			filePath,
			deviceId,
			fileNarratorId,
			toolEdit: options.toolEdit,
			selection: options.selection,
			highlightRequestId: options.highlightRequestId ?? nextHighlightRequestId(),
			referenceOrigin:
				(existing?.params as FilePanelParams | undefined)?.referenceOrigin === true ||
				options.referenceOrigin === true,
			...(fileName ? { fileName } : {}),
		};
		if (existing) {
			existing.api.updateParameters(params);
			this.activateResource(existing);
			return;
		}
		this.openResource(
			hostNarratorId,
			{ id, component: PANEL_COMPONENT.file, params },
			options.sourcePanelId,
		);
	}

	/**
	 * Open (or focus) a knowledge entry panel inside one narrator's cluster.
	 * Same placement rule as file/subagent panels; multi-instance, keyed by entry.
	 */
	openKnowledgePanel(
		hostNarratorId: string,
		entryId: string,
		scope: "global" | "personal" = "global",
		sourcePanelId?: string,
	) {
		if (!entryId) return;
		this.openResource(
			hostNarratorId,
			{
				id: workspaceKnowledgePanelId(hostNarratorId, entryId),
				component: PANEL_COMPONENT.knowledge,
				params: { panelType: "knowledge", hostNarratorId, entryId, scope },
			},
			sourcePanelId,
		);
	}

	closeToolPanel(narratorId: string, type: NarratorToolPanelType) {
		this.apiRef.current?.getPanel(workspaceToolPanelId(narratorId, type))?.api.close();
	}

	/**
	 * Same contract as `NarratorDockContext.toggleToolPanel`: open if closed,
	 * focus an open-but-background tab, close only when it is already active.
	 */
	toggleToolPanel(
		narratorId: string,
		type: NarratorToolPanelType,
		chapterId: string | null | undefined,
		sourcePanelId?: string,
	) {
		const existing = this.apiRef.current?.getPanel(workspaceToolPanelId(narratorId, type));
		if (!existing) {
			this.openToolPanel(narratorId, type, chapterId, sourcePanelId);
			return;
		}
		if (
			!existing.api.isActive ||
			(this.directorActive && existing.api.location.type !== "floating")
		) {
			this.activateResource(existing);
			return;
		}
		this.closeToolPanel(narratorId, type);
	}
}

/** Resource ownership is independent of its current layout group. */
export function workspaceResourceOwner(params: WorkspacePanelParams | undefined): string | null {
	if (!params) return null;
	if (params.panelType === "narrator-tool") return params.narratorId;
	if (
		params.panelType === "subagent" ||
		params.panelType === "file" ||
		params.panelType === "knowledge"
	)
		return params.hostNarratorId;
	if (params.panelType === "plugin" && params.binding?.kind === "workspace-narrator")
		return params.binding.ownerNarratorId;
	return null;
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
export function useWorkspaceNarratorDockValue(
	narratorId: string,
	sourcePanelId?: string,
): NarratorDockContextValue | null {
	const store = useWorkspaceDock();

	const shard = useSyncExternalStore(
		useCallback(
			(cb: () => void) => (store ? store.subscribe(narratorId, cb) : () => {}),
			[store, narratorId],
		),
		useCallback(() => (store ? store.getSnapshot(narratorId) : EMPTY_SHARD), [store, narratorId]),
	);

	// Legacy chapter association for the git tool. The adapter now resolves the
	// narrator's actual workspace, so standalone and subagent narrators are supported.
	const { data: narrator } = useNarrator(narratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON entity
	const chapterId = (narrator as any)?.chapterId as string | null | undefined;
	const chapterIdRef = useRef<string | null | undefined>(chapterId);
	chapterIdRef.current = chapterId;

	// Stable methods (keyed on store + narrator only, NOT on the reactive shard)
	// so consumers that key effects on callback identity — e.g. NarratorPanel's
	// details / browser publish effects — don't re-run on every shard
	// update. Mirrors the focus page's stable `useState` setters.
	const methods = useMemo(() => {
		if (!store) return null;
		return {
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
				store.openToolPanel(narratorId, type, chapterIdRef.current, sourcePanelId),
			openSubagentPanel: (subagentNarratorId: string, messageId?: string) =>
				store.openSubagentPanel(narratorId, subagentNarratorId, messageId, sourcePanelId),
			openFilePanel: (filePath: string, fileName?: string, options?: FileOpenOptions) =>
				store.openFilePanel(narratorId, filePath, fileName, {
					...options,
					sourcePanelId: options?.sourcePanelId ?? sourcePanelId,
				}),
			openKnowledgePanel: (entryId: string, scope?: KnowledgeEntryScope) =>
				store.openKnowledgePanel(narratorId, entryId, scope, sourcePanelId),
			closeToolPanel: (type: NarratorToolPanelType) => store.closeToolPanel(narratorId, type),
			toggleToolPanel: (type: NarratorToolPanelType) =>
				store.toggleToolPanel(narratorId, type, chapterIdRef.current, sourcePanelId),
		};
	}, [store, narratorId, sourcePanelId]);

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
			fileReferenceSelection: shard.fileReferenceSelection,
			detailsProps: shard.detailsProps,
			browserInfo: shard.browserInfo,
			openToolTypes: shard.openToolTypes,
			...methods,
		};
	}, [store, methods, narratorId, chapterId, shard]);
}
