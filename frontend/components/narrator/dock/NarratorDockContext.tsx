/**
 * Page-level coordination context for the unified narrator dockview.
 *
 * In the dockview layout the chat panel and the tool panels (file modifications,
 * details, browser, terminal, git, spec) are *sibling* panels, not parent/child,
 * so they can no longer share state by prop-drilling. This context is the bridge:
 *
 *   - The chat panel (NarratorPanel) *publishes* the derived state that tool
 *     panels need (file-mod props, details props, browser session info).
 *   - Tool panels *subscribe* to that published state.
 *   - Imperative cross-panel actions (terminal → chat input, chat → terminal
 *     stdin) are registered as callbacks so either side can call the other
 *     without a shared React parent.
 *   - The chat toolbar *opens / closes / toggles* tool panels via the dockview
 *     api, without owning it.
 *
 * Everything is optional: outside a provider (workspace page, narraflow graph
 * embed) the publish hooks are no-ops and NarratorPanel keeps its legacy
 * prop-callback behaviour.
 */

import type { FileReference, FileReferenceEditorSelection } from "@shared/file-reference";
import type { DockviewApi } from "dockview-react";
import {
	createContext,
	type RefObject,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type PluginUiHostSurface,
	PluginUiSurfaceProvider,
} from "../../plugins/PluginUiSurfaceContext";
import type {
	FileModPanelExternalProps,
	NarratorDetailsPanelExternalProps,
} from "../narrator-panel-types";
import { focusMessagePanel } from "../panels/focus-message-panel";
import {
	type FileOpenOptions,
	type FilePanelParams,
	type KnowledgeEntryScope,
	type KnowledgePanelParams,
	nextHighlightRequestId,
	type SubagentPanelParams,
} from "../panels/panel-kind";
import { resolveFileBrowserPosition, resolveToolPlacement } from "../panels/tool-placement";
import {
	dockPanelId,
	fileDockPanelId,
	isNarratorToolPanelType,
	knowledgeDockPanelId,
	NARRATOR_DOCK_COMPONENT,
	type NarratorDockPanelParams,
	type NarratorToolPanelType,
	subagentDockPanelId,
} from "./dock-panel-types";

export interface NarratorBrowserInfo {
	sessionCount: number;
	visualChange: { sessionId: string; seq: number } | null;
}

/** Imperative bridges registered by whichever panel owns the capability. */
interface NarratorDockBridges {
	/** Registered by the chat panel; called by the terminal to append to chat input. */
	appendChatInput: ((text: string) => void) | null;
	/** Registered by the terminal panel; called by chat to write to terminal stdin. */
	writeTerminalStdin: ((text: string) => void) | null;
	/** Registered by the chat panel; called by the search panel to jump to a message. */
	scrollToMessage: ((messageId: string) => void) | null;
	/**
	 * Registered by the chat panel; called by the user-chat panel to SUBMIT text as
	 * a real user message.
	 *
	 * Deliberately the composer's own submit path rather than a direct REST call:
	 * that is where busy-narrator buffering, slash-command resolution and draft /
	 * attachment state live. Bypassing it would make a forward sent mid-turn start a
	 * new turn instead of queueing behind the current one.
	 */
	submitToNarrator: ((text: string) => void) | null;
	addFileReference: ((reference: FileReference) => void) | null;
}

export interface NarratorDockContextValue {
	narratorId: string;
	chapterId: string | null | undefined;

	/**
	 * The surrounding host already displays this narrator's title, so the chat panel
	 * must not render its own title row (nor its edit / generate actions).
	 *
	 * Set by a chapter node's embedded dock: the node header shows the title and owns
	 * those two actions, and the panel's copy was being squeezed to zero width by its
	 * own tool buttons.
	 *
	 * Optional so the hand-built context values (detached canvas panels, workspace
	 * shards) keep their current behaviour by simply not setting it — none of them has
	 * an outer header to show the title.
	 *
	 * Deliberately NOT derived from `pluginSurface === "graph"`: that flag identifies
	 * the host for PLUGINS, and using it to decide chat chrome would silently drop the
	 * title the moment a surface name is reused or renamed.
	 */
	hostOwnsTitle?: boolean;

	/**
	 * Chapter fork-from-message handler supplied by the page (route owns the
	 * mutation + notifications). Consumed by the chat panel; null when the
	 * narrator has no chapter. Panel params can't carry functions, so this is
	 * threaded through context rather than params.
	 */
	onForkFromMessage: ((messageId: string) => void) | null;

	/**
	 * Message id to scroll to + highlight on open (from search-result / deep-link
	 * navigation, e.g. `/narrators/$id#msg-<id>`). Consumed by the chat panel and
	 * forwarded to the message list. Threaded through context because the dock
	 * surface sits between the route and NarratorPanel.
	 */
	highlightMessageId: string | undefined;

	/** Optional page-level navigation controls forwarded to the root chat panel. */
	onBack: (() => void) | null;
	onMinimize: (() => void) | null;

	/** Live dockview api ref (bound by the surface once ready). */
	apiRef: RefObject<DockviewApi | null>;

	/** Published by chat, read by the file-modifications panel. */
	fileModProps: FileModPanelExternalProps | null;
	setFileModProps: (props: FileModPanelExternalProps | null) => void;

	/** Published by chat, read by the details panel. */
	detailsProps: NarratorDetailsPanelExternalProps | null;
	setDetailsProps: (props: NarratorDetailsPanelExternalProps | null) => void;

	/** Published by chat, read by the browser panel. */
	browserInfo: NarratorBrowserInfo;
	setBrowserInfo: (info: NarratorBrowserInfo) => void;

	/** Register the chat-input appender (returns an unregister fn). */
	registerAppendChatInput: (fn: (text: string) => void) => () => void;
	/** Append text to the chat input, if a chat panel is mounted. */
	appendChatInput: (text: string) => void;

	/** Register the terminal-stdin writer (returns an unregister fn). */
	registerWriteTerminalStdin: (fn: (text: string) => void) => () => void;
	/** Write text to the terminal, if a terminal panel is mounted. */
	writeTerminalStdin: (text: string) => void;

	/** Register the message-jump handler (returns an unregister fn). */
	registerScrollToMessage: (fn: (messageId: string) => void) => () => void;
	/**
	 * Scroll to + highlight a message in the chat panel.
	 *
	 * Optional because a surface may have no chat panel to jump to at all: a tool
	 * panel torn out onto the story-network canvas keeps working on its own, but
	 * "jump to this message" has nowhere to go once its source node is collapsed.
	 * Consumers must treat absence as "disable the control" rather than calling it
	 * through a `?.` that silently does nothing.
	 */
	scrollToMessage?: (messageId: string) => void;

	/** Register the user-message submitter (returns an unregister fn). */
	registerSubmitToNarrator: (fn: (text: string) => void) => () => void;
	/** Submit text as a user message through the chat panel's composer path. */
	submitToNarrator: (text: string) => void;

	/** Tool panel types currently present in the layout (for toolbar active state). */
	openToolTypes: ReadonlySet<NarratorToolPanelType>;
	/** Recompute `openToolTypes` from the live layout (called on layout change). */
	refreshOpenToolTypes: () => void;
	/** Open (or focus) a tool panel next to chat. */
	openToolPanel: (type: NarratorToolPanelType) => void;
	/**
	 * Open (or focus) a child narrator session in the shared secondary area.
	 *
	 * `messageId` scrolls that session to (and flashes) one message — used by rows
	 * that report a specific thing the child said, such as an injection bubble. It is
	 * delivered as a panel PARAMETER rather than through the `scrollToMessage` bridge
	 * because the panel usually does not exist yet at click time, so there is nothing
	 * registered to call; the panel consumes it once mounted.
	 *
	 * Optional for the same reason as `scrollToMessage`: a detached canvas panel has
	 * no secondary area of its own, so when its source node is collapsed there is
	 * nowhere to put the session. Absence means "disable the control".
	 */
	openSubagentPanel?: (subagentNarratorId: string, messageId?: string) => void;
	/**
	 * Open (or focus) a read-only file viewer for an absolute path. Multi-instance:
	 * one panel per path, keyed by a hash of the path (see `fileDockPanelId`).
	 */
	openFilePanel?: (filePath: string, fileName?: string, options?: FileOpenOptions) => void;
	/** Selection metadata only; never copy an unsaved buffer into a saved-file reference. */
	fileReferenceSelection?: FileReferenceEditorSelection | null;
	setFileReferenceSelection?: (selection: FileReferenceEditorSelection | null) => void;
	registerAddFileReference?: (fn: (reference: FileReference) => void) => () => void;
	addFileReference?: (reference: FileReference) => void;
	/**
	 * Open (or focus) a knowledge entry viewer/editor panel. Multi-instance: one
	 * panel per entry, keyed by entryId. `scope` determines which hooks are used
	 * (global shared base vs personal library).
	 *
	 * Optional for the same reason as `openSubagentPanel`: a detached canvas panel
	 * has no secondary area, so absence means "disable the control".
	 */
	openKnowledgePanel?: (entryId: string, scope?: KnowledgeEntryScope) => void;
	/** Close a tool panel if present. */
	closeToolPanel: (type: NarratorToolPanelType) => void;
	/** Toggle a tool panel open/closed. */
	toggleToolPanel: (type: NarratorToolPanelType) => void;
}

/**
 * The raw context. Exported so alternative surfaces (e.g. the multi-narrator
 * workspace) can supply their own per-narrator `NarratorDockContextValue`
 * without going through `NarratorDockProvider` (which owns a single narrator's
 * dockview api). `NarratorPanel` and the tool-panel adapters read this via
 * `useNarratorDockContext()`.
 */
export const NarratorDockContext = createContext<NarratorDockContextValue | null>(null);

/** Provider that owns the shared state for one narrator dockview surface. */
export function NarratorDockProvider({
	narratorId,
	chapterId,
	onForkFromMessage = null,
	highlightMessageId,
	onBack = null,
	onMinimize = null,
	hostOwnsTitle = false,
	pluginSurface = "focus",
	children,
}: {
	narratorId: string;
	chapterId?: string | null;
	onForkFromMessage?: ((messageId: string) => void) | null;
	highlightMessageId?: string;
	onBack?: (() => void) | null;
	onMinimize?: (() => void) | null;
	/** See `hostOwnsTitle` on {@link NarratorDockContextValue}. */
	hostOwnsTitle?: boolean;
	/**
	 * Which host surface plugins should see. Defaults to `"focus"` (the narrator
	 * page). A chapter node's embedded dock passes `"graph"`: the coordination
	 * model is identical — one surface, one narrator — but plugins get to tell the
	 * two apart, since a node's viewport is far smaller than a full page.
	 */
	pluginSurface?: PluginUiHostSurface;
	children: React.ReactNode;
}) {
	const apiRef = useRef<DockviewApi | null>(null);
	const [fileModProps, setFileModProps] = useState<FileModPanelExternalProps | null>(null);
	const [fileReferenceSelection, setFileReferenceSelection] =
		useState<FileReferenceEditorSelection | null>(null);
	const [detailsProps, setDetailsProps] = useState<NarratorDetailsPanelExternalProps | null>(null);
	const [browserInfo, setBrowserInfo] = useState<NarratorBrowserInfo>({
		sessionCount: 0,
		visualChange: null,
	});
	const [openToolTypes, setOpenToolTypes] = useState<ReadonlySet<NarratorToolPanelType>>(
		() => new Set(),
	);

	const bridgesRef = useRef<NarratorDockBridges>({
		appendChatInput: null,
		writeTerminalStdin: null,
		scrollToMessage: null,
		submitToNarrator: null,
		addFileReference: null,
	});

	// Keep chapterId in a ref so openToolPanel always uses the latest without
	// churning callback identity.
	const chapterIdRef = useRef<string | null | undefined>(chapterId);
	chapterIdRef.current = chapterId;

	const refreshOpenToolTypes = useCallback(() => {
		const api = apiRef.current;
		if (!api) return;
		const next = new Set<NarratorToolPanelType>();
		for (const panel of api.panels) {
			const params = panel.params as NarratorDockPanelParams | undefined;
			if (params && isNarratorToolPanelType(params.panelType)) next.add(params.panelType);
		}
		// Layout events also fire for moves/resizes; only publish changed membership.
		setOpenToolTypes((previous) => {
			if (previous.size !== next.size) return next;
			for (const type of next) {
				if (!previous.has(type)) return next;
			}
			return previous;
		});
	}, []);

	const openToolPanel = useCallback(
		(type: NarratorToolPanelType) => {
			const api = apiRef.current;
			if (!api) return;
			const id = dockPanelId(type);
			const existing = api.getPanel(id);
			if (existing) {
				existing.api.setActive();
				return;
			}

			// A cluster keeps its chat panel as the protagonist and stacks every
			// resource panel (spec/terminal/browser/…) as tabs in ONE secondary
			// group beside it. Find that secondary group by locating any already-
			// open tool panel (panelType !== "chat").
			const existingTool = api.panels.find((p) => {
				const params = p.params as NarratorDockPanelParams | undefined;
				return params && params.panelType !== "chat";
			});
			const chatPanel = api.getPanel(dockPanelId("chat"));

			const params: NarratorDockPanelParams = {
				panelType: type,
				narratorId,
				chapterId: chapterIdRef.current,
			};
			const placement = resolveToolPlacement({
				hasSecondaryGroup: !!existingTool?.group,
				hasChatPanel: !!chatPanel,
				surfaceWidth: api.width,
			});

			if (placement.mode === "within-secondary" && existingTool?.group) {
				// Subsequent tool panels: add as a tab within the existing secondary
				// group (omitting direction defaults to "within").
				api.addPanel<NarratorDockPanelParams>({
					id,
					component: NARRATOR_DOCK_COMPONENT[type],
					params,
					position: { referenceGroup: existingTool.group },
				});
				return;
			}

			if (placement.mode === "split-right" && chatPanel) {
				// First tool panel: open a new secondary group to the right of chat,
				// sized to ~1/3 of the surface so main:secondary ≈ 2:1.
				api.addPanel<NarratorDockPanelParams>({
					id,
					component: NARRATOR_DOCK_COMPONENT[type],
					params,
					initialWidth: placement.initialWidth,
					position: { referencePanel: chatPanel.id, direction: "right" },
				});
				return;
			}

			// Defensive fallback (no chat panel present).
			api.addPanel<NarratorDockPanelParams>({
				id,
				component: NARRATOR_DOCK_COMPONENT[type],
				params,
			});
		},
		[narratorId],
	);

	const openSubagentPanel = useCallback(
		(subagentNarratorId: string, messageId?: string) => {
			const api = apiRef.current;
			if (!api || !subagentNarratorId) return;
			// Communication bubbles can point back to the host, not only to children.
			// Never create a second copy of the primary session in the secondary area.
			if (subagentNarratorId === narratorId) {
				const primary = api.getPanel(dockPanelId("chat"));
				if (primary) {
					focusMessagePanel(api, primary, messageId, (id) =>
						bridgesRef.current.scrollToMessage?.(id),
					);
				}
				return;
			}
			const id = subagentDockPanelId(subagentNarratorId);
			const existing = api.getPanel(id);
			if (existing) {
				existing.api.setActive();
				// An already-open panel is focused, and re-asked to jump. The nonce is what
				// makes a SECOND click on the same row work: the panel's jump is latched per
				// (narrator, target) so it fires once, and without a changing token the reader
				// who scrolled away would click a live-looking control and see nothing.
				if (messageId) {
					existing.api.updateParameters({
						panelType: "subagent",
						subagentNarratorId,
						highlightMessageId: messageId,
						highlightRequestId: nextHighlightRequestId(),
					} satisfies SubagentPanelParams);
				}
				return;
			}

			const existingSecondary = api.panels.find((panel) => {
				const params = panel.params as NarratorDockPanelParams | undefined;
				return params?.panelType !== "chat";
			});
			const chatPanel = api.getPanel(dockPanelId("chat"));
			const params: NarratorDockPanelParams = {
				panelType: "subagent",
				subagentNarratorId,
				// Carried as a PARAMETER rather than pushed through the `scrollToMessage`
				// bridge because the panel does not exist yet at click time — there is nothing
				// registered to call. The panel consumes it on mount.
				...(messageId
					? { highlightMessageId: messageId, highlightRequestId: nextHighlightRequestId() }
					: {}),
			};
			const placement = resolveToolPlacement({
				hasSecondaryGroup: !!existingSecondary?.group,
				hasChatPanel: !!chatPanel,
				surfaceWidth: api.width,
			});

			if (placement.mode === "within-secondary" && existingSecondary?.group) {
				api.addPanel<NarratorDockPanelParams>({
					id,
					component: NARRATOR_DOCK_COMPONENT.subagent,
					params,
					position: { referenceGroup: existingSecondary.group },
				});
				return;
			}

			if (placement.mode === "split-right" && chatPanel) {
				api.addPanel<NarratorDockPanelParams>({
					id,
					component: NARRATOR_DOCK_COMPONENT.subagent,
					params,
					initialWidth: placement.initialWidth,
					position: { referencePanel: chatPanel.id, direction: "right" },
				});
				return;
			}

			api.addPanel<NarratorDockPanelParams>({
				id,
				component: NARRATOR_DOCK_COMPONENT.subagent,
				params,
			});
		},
		[narratorId],
	);

	// Same placement rule as the other secondary panels, but multi-instance: the
	// panel id is derived from the path, so re-opening the same file focuses the
	// existing viewer instead of stacking duplicates.
	const openFilePanel = useCallback(
		(filePath: string, fileName?: string, options: FileOpenOptions = {}) => {
			const api = apiRef.current;
			if (!api || !filePath) return;
			const deviceId = options.deviceId ?? "local";
			// Absent means the host's authority (legacy panels keep their existing ids).
			const fileNarratorId =
				options.fileNarratorId === narratorId ? undefined : options.fileNarratorId;
			const navigation = {
				deviceId,
				fileNarratorId,
				toolEdit: options.toolEdit,
				selection: options.selection,
				highlightRequestId: options.highlightRequestId ?? nextHighlightRequestId(),
			};
			const id = fileDockPanelId(filePath, deviceId, options.toolEdit, fileNarratorId);
			const existing = api.getPanel(id);
			if (existing) {
				// Layouts written before file editing carried no host identity. Repair the
				// live panel when it is reopened so the edit action appears immediately and
				// the corrected params are available to later drags / persistence. Guard the
				// cast: corrupt persisted params are replaced wholesale — falling through to
				// addPanel would throw on the duplicate id.
				const current = existing.params as FilePanelParams | undefined;
				existing.api.updateParameters({
					...current,
					panelType: "file",
					hostNarratorId: narratorId,
					filePath,
					...navigation,
					referenceOrigin: current?.referenceOrigin === true || options.referenceOrigin === true,
					...(fileName ? { fileName } : {}),
				});
				existing.api.setActive();
				return;
			}

			const existingSecondary = api.panels.find((panel) => {
				const panelParams = panel.params as NarratorDockPanelParams | undefined;
				return panelParams?.panelType !== "chat";
			});
			const chatPanel = api.getPanel(dockPanelId("chat"));
			const params: NarratorDockPanelParams = {
				panelType: "file",
				hostNarratorId: narratorId,
				filePath,
				...navigation,
				referenceOrigin: options.referenceOrigin === true,
				...(fileName ? { fileName } : {}),
			};
			const browserPosition = resolveFileBrowserPosition(api, options.sourcePanelId);
			if (browserPosition) {
				api.addPanel<NarratorDockPanelParams>({
					id,
					component: NARRATOR_DOCK_COMPONENT.file,
					params,
					position: browserPosition,
				});
				return;
			}
			const placement = resolveToolPlacement({
				hasSecondaryGroup: !!existingSecondary?.group,
				hasChatPanel: !!chatPanel,
				surfaceWidth: api.width,
			});

			if (placement.mode === "within-secondary" && existingSecondary?.group) {
				api.addPanel<NarratorDockPanelParams>({
					id,
					component: NARRATOR_DOCK_COMPONENT.file,
					params,
					position: { referenceGroup: existingSecondary.group },
				});
				return;
			}

			if (placement.mode === "split-right" && chatPanel) {
				api.addPanel<NarratorDockPanelParams>({
					id,
					component: NARRATOR_DOCK_COMPONENT.file,
					params,
					initialWidth: placement.initialWidth,
					position: { referencePanel: chatPanel.id, direction: "right" },
				});
				return;
			}

			api.addPanel<NarratorDockPanelParams>({
				id,
				component: NARRATOR_DOCK_COMPONENT.file,
				params,
			});
		},
		[narratorId],
	);

	// Same placement rule as the other multi-instance secondary panels (file,
	// subagent). The panel id is derived from the entryId (a nanoid, safe as-is).
	const openKnowledgePanel = useCallback(
		(entryId: string, scope: KnowledgeEntryScope = "global") => {
			const api = apiRef.current;
			if (!api || !entryId) return;
			const id = knowledgeDockPanelId(entryId);
			const existing = api.getPanel(id);
			if (existing) {
				existing.api.setActive();
				return;
			}

			const existingSecondary = api.panels.find((panel) => {
				const panelParams = panel.params as NarratorDockPanelParams | undefined;
				return panelParams?.panelType !== "chat";
			});
			const chatPanel = api.getPanel(dockPanelId("chat"));
			const params: KnowledgePanelParams = { panelType: "knowledge", entryId, scope };
			const placement = resolveToolPlacement({
				hasSecondaryGroup: !!existingSecondary?.group,
				hasChatPanel: !!chatPanel,
				surfaceWidth: api.width,
			});

			if (placement.mode === "within-secondary" && existingSecondary?.group) {
				api.addPanel<NarratorDockPanelParams>({
					id,
					component: NARRATOR_DOCK_COMPONENT.knowledge,
					params,
					position: { referenceGroup: existingSecondary.group },
				});
				return;
			}

			if (placement.mode === "split-right" && chatPanel) {
				api.addPanel<NarratorDockPanelParams>({
					id,
					component: NARRATOR_DOCK_COMPONENT.knowledge,
					params,
					initialWidth: placement.initialWidth,
					position: { referencePanel: chatPanel.id, direction: "right" },
				});
				return;
			}

			api.addPanel<NarratorDockPanelParams>({
				id,
				component: NARRATOR_DOCK_COMPONENT.knowledge,
				params,
			});
		},
		[],
	);

	const closeToolPanel = useCallback((type: NarratorToolPanelType) => {
		apiRef.current?.getPanel(dockPanelId(type))?.api.close();
	}, []);

	const toggleToolPanel = useCallback(
		(type: NarratorToolPanelType) => {
			if (apiRef.current?.getPanel(dockPanelId(type))) closeToolPanel(type);
			else openToolPanel(type);
		},
		[openToolPanel, closeToolPanel],
	);

	const registerAddFileReference = useCallback((fn: (reference: FileReference) => void) => {
		bridgesRef.current.addFileReference = fn;
		return () => {
			if (bridgesRef.current.addFileReference === fn) bridgesRef.current.addFileReference = null;
		};
	}, []);
	const addFileReference = useCallback(
		(reference: FileReference) => bridgesRef.current.addFileReference?.(reference),
		[],
	);

	// These callback props (onForkFromMessage, onBack, onMinimize) MUST keep stable
	// references across parent renders. The sole call site in
	// routes/narrators/$narratorId.tsx wraps each with useCallback, ensuring the
	// context value below only rebuilds when truly necessary (narratorId/chapterId
	// change, or local state changes). If a new call site is added without
	// useCallback, the entire context will re-create on every parent render.
	const value = useMemo<NarratorDockContextValue>(() => {
		return {
			narratorId,
			chapterId,
			hostOwnsTitle,
			onForkFromMessage,
			highlightMessageId,
			onBack,
			onMinimize,
			apiRef,
			fileModProps,
			setFileModProps,
			fileReferenceSelection,
			setFileReferenceSelection,
			registerAddFileReference,
			addFileReference,
			detailsProps,
			setDetailsProps,
			browserInfo,
			setBrowserInfo,
			registerAppendChatInput: (fn) => {
				bridgesRef.current.appendChatInput = fn;
				return () => {
					if (bridgesRef.current.appendChatInput === fn) {
						bridgesRef.current.appendChatInput = null;
					}
				};
			},
			appendChatInput: (text) => bridgesRef.current.appendChatInput?.(text),
			registerWriteTerminalStdin: (fn) => {
				bridgesRef.current.writeTerminalStdin = fn;
				return () => {
					if (bridgesRef.current.writeTerminalStdin === fn) {
						bridgesRef.current.writeTerminalStdin = null;
					}
				};
			},
			writeTerminalStdin: (text) => bridgesRef.current.writeTerminalStdin?.(text),
			registerScrollToMessage: (fn) => {
				bridgesRef.current.scrollToMessage = fn;
				return () => {
					if (bridgesRef.current.scrollToMessage === fn) {
						bridgesRef.current.scrollToMessage = null;
					}
				};
			},
			scrollToMessage: (messageId) => bridgesRef.current.scrollToMessage?.(messageId),
			registerSubmitToNarrator: (fn) => {
				bridgesRef.current.submitToNarrator = fn;
				return () => {
					if (bridgesRef.current.submitToNarrator === fn) {
						bridgesRef.current.submitToNarrator = null;
					}
				};
			},
			submitToNarrator: (text) => bridgesRef.current.submitToNarrator?.(text),
			openToolTypes,
			refreshOpenToolTypes,
			openToolPanel,
			openSubagentPanel,
			openFilePanel,
			openKnowledgePanel,
			closeToolPanel,
			toggleToolPanel,
		};
	}, [
		narratorId,
		chapterId,
		hostOwnsTitle,
		onForkFromMessage,
		highlightMessageId,
		onBack,
		onMinimize,
		fileModProps,
		fileReferenceSelection,
		registerAddFileReference,
		addFileReference,
		detailsProps,
		browserInfo,
		openToolTypes,
		refreshOpenToolTypes,
		openToolPanel,
		openSubagentPanel,
		openFilePanel,
		openKnowledgePanel,
		closeToolPanel,
		toggleToolPanel,
	]);

	return (
		<PluginUiSurfaceProvider hostContext={{ surface: pluginSurface, narratorId, chapterId }}>
			<NarratorDockContext.Provider value={value}>{children}</NarratorDockContext.Provider>
		</PluginUiSurfaceProvider>
	);
}

/** Access the dock context, or null when rendered outside a provider. */
export function useNarratorDockContext(): NarratorDockContextValue | null {
	return useContext(NarratorDockContext);
}
