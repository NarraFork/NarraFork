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
import { PluginUiSurfaceProvider } from "../../plugins/PluginUiSurfaceContext";
import type {
	FileModPanelExternalProps,
	NarratorDetailsPanelExternalProps,
} from "../narrator-panel-types";
import { resolveToolPlacement } from "../panels/tool-placement";
import {
	dockPanelId,
	fileDockPanelId,
	isNarratorToolPanelType,
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
}

export interface NarratorDockContextValue {
	narratorId: string;
	chapterId: string | null | undefined;

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
	/** Scroll to + highlight a message in the chat panel, if mounted. */
	scrollToMessage: (messageId: string) => void;

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
	/** Open (or focus) a child narrator session in the shared secondary area. */
	openSubagentPanel: (subagentNarratorId: string) => void;
	/**
	 * Open (or focus) a read-only file viewer for an absolute path. Multi-instance:
	 * one panel per path, keyed by a hash of the path (see `fileDockPanelId`).
	 */
	openFilePanel: (filePath: string, fileName?: string) => void;
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
	children,
}: {
	narratorId: string;
	chapterId?: string | null;
	onForkFromMessage?: ((messageId: string) => void) | null;
	highlightMessageId?: string;
	onBack?: (() => void) | null;
	onMinimize?: (() => void) | null;
	children: React.ReactNode;
}) {
	const apiRef = useRef<DockviewApi | null>(null);
	const [fileModProps, setFileModProps] = useState<FileModPanelExternalProps | null>(null);
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
		setOpenToolTypes(next);
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

	const openSubagentPanel = useCallback((subagentNarratorId: string) => {
		const api = apiRef.current;
		if (!api || !subagentNarratorId) return;
		const id = subagentDockPanelId(subagentNarratorId);
		const existing = api.getPanel(id);
		if (existing) {
			existing.api.setActive();
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
	}, []);

	// Same placement rule as the other secondary panels, but multi-instance: the
	// panel id is derived from the path, so re-opening the same file focuses the
	// existing viewer instead of stacking duplicates.
	const openFilePanel = useCallback((filePath: string, fileName?: string) => {
		const api = apiRef.current;
		if (!api || !filePath) return;
		const id = fileDockPanelId(filePath);
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
		const params: NarratorDockPanelParams = {
			panelType: "file",
			filePath,
			...(fileName ? { fileName } : {}),
		};
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
	}, []);

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
			onForkFromMessage,
			highlightMessageId,
			onBack,
			onMinimize,
			apiRef,
			fileModProps,
			setFileModProps,
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
			closeToolPanel,
			toggleToolPanel,
		};
	}, [
		narratorId,
		chapterId,
		onForkFromMessage,
		highlightMessageId,
		onBack,
		onMinimize,
		fileModProps,
		detailsProps,
		browserInfo,
		openToolTypes,
		refreshOpenToolTypes,
		openToolPanel,
		openSubagentPanel,
		openFilePanel,
		closeToolPanel,
		toggleToolPanel,
	]);

	return (
		<PluginUiSurfaceProvider hostContext={{ surface: "focus", narratorId, chapterId }}>
			<NarratorDockContext.Provider value={value}>{children}</NarratorDockContext.Provider>
		</PluginUiSurfaceProvider>
	);
}

/** Access the dock context, or null when rendered outside a provider. */
export function useNarratorDockContext(): NarratorDockContextValue | null {
	return useContext(NarratorDockContext);
}
