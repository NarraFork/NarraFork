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
import type {
	FileModPanelExternalProps,
	NarratorDetailsPanelExternalProps,
} from "../narrator-panel-types";
import {
	dockPanelId,
	NARRATOR_DOCK_COMPONENT,
	type NarratorDockPanelParams,
	type NarratorToolPanelType,
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
	onForkFromMessage: ((messageUuid: string) => void) | null;

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

	/** Tool panel types currently present in the layout (for toolbar active state). */
	openToolTypes: ReadonlySet<NarratorToolPanelType>;
	/** Recompute `openToolTypes` from the live layout (called on layout change). */
	refreshOpenToolTypes: () => void;
	/** Open (or focus) a tool panel next to chat. */
	openToolPanel: (type: NarratorToolPanelType) => void;
	/** Close a tool panel if present. */
	closeToolPanel: (type: NarratorToolPanelType) => void;
	/** Toggle a tool panel open/closed. */
	toggleToolPanel: (type: NarratorToolPanelType) => void;
}

const NarratorDockContext = createContext<NarratorDockContextValue | null>(null);

/** Provider that owns the shared state for one narrator dockview surface. */
export function NarratorDockProvider({
	narratorId,
	chapterId,
	onForkFromMessage = null,
	children,
}: {
	narratorId: string;
	chapterId?: string | null;
	onForkFromMessage?: ((messageUuid: string) => void) | null;
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
			if (params && params.panelType !== "chat") next.add(params.panelType);
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
			const chatPanel = api.getPanel(dockPanelId("chat"));
			api.addPanel<NarratorDockPanelParams>({
				id,
				component: NARRATOR_DOCK_COMPONENT[type],
				params: { panelType: type, narratorId, chapterId: chapterIdRef.current },
				position: chatPanel ? { referencePanel: chatPanel.id, direction: "right" } : undefined,
			});
		},
		[narratorId],
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

	const value = useMemo<NarratorDockContextValue>(() => {
		return {
			narratorId,
			chapterId,
			onForkFromMessage,
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
			openToolTypes,
			refreshOpenToolTypes,
			openToolPanel,
			closeToolPanel,
			toggleToolPanel,
		};
	}, [
		narratorId,
		chapterId,
		onForkFromMessage,
		fileModProps,
		detailsProps,
		browserInfo,
		openToolTypes,
		refreshOpenToolTypes,
		openToolPanel,
		closeToolPanel,
		toggleToolPanel,
	]);

	return <NarratorDockContext.Provider value={value}>{children}</NarratorDockContext.Provider>;
}

/** Access the dock context, or null when rendered outside a provider. */
export function useNarratorDockContext(): NarratorDockContextValue | null {
	return useContext(NarratorDockContext);
}
