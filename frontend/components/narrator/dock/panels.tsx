/**
 * Dockview panel adapters for the unified narrator surface.
 *
 * Each adapter maps a dockview panel (`params.panelType`) to an existing
 * NarraFork component:
 *   - chat     → NarratorPanel (primary)
 *   - terminal → NarratorTerminal (with a header bar)
 *   - details  → NarratorDetailsPanel (inline) — props from dock context
 *   - filemod  → FileModificationsPanel — props from dock context
 *   - spec     → SpecPanel
 *   - git      → GitPanel (resolves narrator workspace; chapter adapter retained)
 *   - browser  → BrowserPanel — session info from dock context
 *
 * Tool panels take their cross-panel state from NarratorDockContext (published
 * by the chat panel), so they can live as dockview siblings of chat.
 */

import { ActionIcon, Badge, Box, Center, Group, Loader, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { FileReferenceEditorSelection, FileTarget } from "@shared/file-reference";
import {
	IconFileCode,
	IconFileText,
	IconFlask,
	IconFolder,
	IconGitBranch,
	IconInfoCircle,
	IconMessages,
	IconNotebook,
	IconRobot,
	IconSearch,
	IconTerminal2,
	IconTextSize,
	IconWorldWww,
	IconX,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import type { IDockviewPanelHeaderProps, IDockviewPanelProps } from "dockview-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarrator } from "../../../hooks/useNarrator";
import { addSubagentRecentTab, shouldAddSubagentRecentTab } from "../../../hooks/useRecentTabs";
import { useUserPreferences } from "../../../hooks/useUserPreferences";
import { NARRATOR_STATUS_COLORS } from "../../../lib/constants";
import type { PluginDockPanelProps } from "../../plugins/types";
import { FileReferenceScopeProvider } from "../composer/FileReferenceScope";
import { getFilePreviewType } from "../file-panel/FilePreviewModal";
import {
	FilePanelNavigationProvider,
	type FilePanelOpener,
	useFilePanelSourceOpener,
} from "../file-panel/file-panel-navigation";
import {
	type FilePanelParams,
	filePanelBaseName,
	filePanelResourceId,
	type KnowledgePanelParams,
	type NarratorBoundPanelParams,
	type SubagentPanelParams,
} from "../panels/panel-kind";
import { usePanelCompact, usePanelGeometryReady, usePanelHeaderDrag } from "../panels/shared";
import { toolEditReferenceKey } from "../tool-call/tool-edit-reference";
import type { NarratorDockPanelType } from "./dock-panel-types";
import { FocusChatSlot } from "./FocusChatHost";
import { NarratorDockContext, useNarratorDockContext } from "./NarratorDockContext";

const NarratorTerminal = lazy(() =>
	import("../../terminal/NarratorTerminal").then((m) => ({ default: m.NarratorTerminal })),
);
const NarratorPanel = lazy(() =>
	import("../NarratorPanel").then((m) => ({ default: m.NarratorPanel })),
);
const NarratorDetailsPanel = lazy(() =>
	import("../details/NarratorDetailsPanel").then((m) => ({ default: m.NarratorDetailsPanel })),
);
const BackgroundTasksPanel = lazy(() =>
	import("../background/BackgroundTasksDrawer").then((m) => ({ default: m.BackgroundTasksPanel })),
);
const BrowserPanel = lazy(() =>
	import("../browser/BrowserPanel").then((m) => ({ default: m.BrowserPanel })),
);
const FileModificationsPanel = lazy(() =>
	import("../file-panel/FileModificationsDrawer").then((m) => ({
		default: m.FileModificationsPanel,
	})),
);
const SpecPanel = lazy(() => import("../spec/SpecPanel").then((m) => ({ default: m.SpecPanel })));
const AppearancePanel = lazy(() =>
	import("../AppearancePanel").then((m) => ({ default: m.AppearancePanel })),
);
const NarratorSearchPanel = lazy(() =>
	import("../NarratorSearchPanel").then((m) => ({ default: m.NarratorSearchPanel })),
);
const NarratorUserChatPanel = lazy(() =>
	import("../../chat/NarratorUserChatPanel").then((m) => ({ default: m.NarratorUserChatPanel })),
);
const GitPanel = lazy(() =>
	import("../../chapter/GitPanel").then((m) => ({ default: m.GitPanel })),
);
const FileTreePanel = lazy(() =>
	import("../file-tree/FileTreePanel").then((m) => ({ default: m.FileTreePanel })),
);
// Lazy so sessions without an open text file do not load the editor module graph.
const FileEditorContent = lazy(() =>
	import("../file-editor/FileEditorContent").then((m) => ({ default: m.FileEditorContent })),
);
const ToolEditFileViewer = lazy(() =>
	import("../tool-call/ToolEditFileViewer").then((m) => ({ default: m.ToolEditFileViewer })),
);
const FileViewerContent = lazy(() =>
	import("../file-viewer/FileViewerContent").then((m) => ({ default: m.FileViewerContent })),
);
const KnowledgeEntryPanelContent = lazy(() =>
	import("../knowledge/KnowledgeEntryPanelContent").then((m) => ({
		default: m.KnowledgeEntryPanelContent,
	})),
);
const LazyPluginDockPanel = lazy(() =>
	import("../../plugins/PluginDockPanel").then((m) => ({ default: m.PluginDockPanel })),
);
// TEMPORARY streaming harness — lazy so it is never fetched unless opened.
// Removed together with `../mock/` (see its README-REMOVAL.md).
const MockStreamPanel = lazy(() =>
	import("../mock/MockStreamPanel").then((m) => ({ default: m.MockStreamPanel })),
);

function LazyPanelBoundary({ children }: { children: React.ReactNode }) {
	return (
		<Suspense
			fallback={
				<Center h="100%">
					<Loader size="sm" />
				</Center>
			}
		>
			{children}
		</Suspense>
	);
}

function PluginDockPanel(props: PluginDockPanelProps) {
	return (
		<LazyPanelBoundary>
			<LazyPluginDockPanel {...props} />
		</LazyPanelBoundary>
	);
}

/**
 * Shared header bar for tool panels — the SINGLE title bar for a docked panel.
 * Layout: [grip icon] [title …flex…] [actions] [× close].
 *
 * Panels render chromeless (no own title bar) inside the dock; their small
 * header controls (badges, save/reload) are hoisted here via `actions` so every
 * docked panel shares one uniform header. Full toolbars (terminal tabs, spec
 * file tabs) stay as the panel's content top row, not here.
 */
function ToolPanelHeader({
	title,
	icon,
	actions,
	onPointerDown,
	onClose,
}: {
	title: string;
	icon?: React.ReactNode;
	actions?: React.ReactNode;
	onPointerDown: (e: React.PointerEvent) => void;
	onClose: () => void;
}) {
	return (
		<Group
			gap="xs"
			px="md"
			py="xs"
			wrap="nowrap"
			className="nf-panel-header"
			onPointerDown={(e) => {
				// Don't start a drag when the pointer lands on an interactive
				// element (e.g. the close button), so its click is not swallowed.
				const el = e.target as HTMLElement;
				if (el.closest("button, a, input, select, textarea, [role='button']")) return;
				onPointerDown(e);
			}}
			style={{
				flexShrink: 0,
				borderBottom: "1px solid var(--mantine-color-default-border)",
				cursor: "grab",
			}}
		>
			{icon ? <Box style={{ display: "flex", flexShrink: 0 }}>{icon}</Box> : null}
			<Text size="sm" fw={600} truncate style={{ flex: 1 }}>
				{title}
			</Text>
			{/* `nodrag` on the interactive parts, matching the pointerdown guard above but
			    for React Flow: when this header is a detached canvas node's dragHandle,
			    RF's drag filter is purely class-based and would otherwise start a node
			    drag from a button, since the button is a descendant of the handle. */}
			{actions ? (
				<Group className="nodrag" gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
					{actions}
				</Group>
			) : null}
			<Tooltip label="Close" withinPortal>
				<ActionIcon className="nodrag" size="sm" variant="subtle" color="gray" onClick={onClose}>
					<IconX size={16} />
				</ActionIcon>
			</Tooltip>
		</Group>
	);
}

/** Wrap tool-panel content with the shared header + a flex column layout. */
function ToolPanelShell({
	title,
	icon,
	actions,
	props,
	subjectId,
	detachKind,
	resourceId,
	beforeDrag,
	children,
}: {
	title: string;
	icon?: React.ReactNode;
	actions?: React.ReactNode;
	// Params-agnostic on purpose: the shell only touches `api` (drag + close), and
	// secondary panels carry different param shapes (narrator-bound, file, …).
	// biome-ignore lint/suspicious/noExplicitAny: shell is params-agnostic
	props: IDockviewPanelProps<any>;
	subjectId: string;
	/**
	 * The panel's kind, stamped onto header drags so a consumer can rebuild this
	 * panel elsewhere — the story-network canvas uses it to tear the panel out into
	 * its own node. Omit for panels that must not be detached.
	 */
	detachKind?: string;
	/** Resource identity for multi-instance kinds (subagent id, file path). */
	resourceId?: string;
	/** Guard custom pointer drags before a different surface can recreate the panel. */
	beforeDrag?: () => boolean;
	children: React.ReactNode;
}) {
	const onPointerDown = usePanelHeaderDrag(
		props,
		subjectId,
		"tool",
		detachKind ? { toolKind: detachKind, ...(resourceId ? { resourceId } : {}) } : undefined,
	);
	const close = useCallback(() => props.api.close(), [props.api]);
	const guardedPointerDown = useCallback(
		(event: React.PointerEvent) => {
			if (beforeDrag && !beforeDrag()) return;
			onPointerDown(event);
		},
		[beforeDrag, onPointerDown],
	);
	return (
		<Box style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
			<ToolPanelHeader
				title={title}
				icon={icon}
				actions={actions}
				onPointerDown={guardedPointerDown}
				onClose={close}
			/>
			<Box style={{ flex: 1, minHeight: 0, overflow: "auto" }}>{children}</Box>
		</Box>
	);
}

// ── Chat (primary) ──
function ChatDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const dock = useNarratorDockContext();
	// Identity ALWAYS comes from the live page context, never serialized params.
	const narratorId = dock?.narratorId ?? (props.params as { narratorId?: string }).narratorId ?? "";
	const { ref: compactRef, compact } = usePanelCompact();
	const { ref, geometryReady } = usePanelGeometryReady(compactRef);
	const onHeaderPointerDown = usePanelHeaderDrag(props, narratorId);
	const { data: narratorData } = useNarrator(narratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON entity
	const narratorTitle = (narratorData as any)?.title as string | undefined;

	useLayoutEffect(() => {
		const title = narratorTitle?.trim();
		if (title && title !== props.api.title) props.api.setTitle(title);
	}, [narratorTitle, props.api]);

	return (
		<Box ref={ref} style={{ height: "100%", overflow: "hidden" }}>
			<FocusChatSlot compact={compact} onHeaderPointerDown={onHeaderPointerDown}>
				{geometryReady && (
					<LazyPanelBoundary>
						<NarratorPanel
							key={narratorId}
							narratorId={narratorId}
							compact={compact}
							onForkFromMessage={dock?.onForkFromMessage ?? undefined}
							onHeaderPointerDown={onHeaderPointerDown}
							onViewSubagentSession={dock?.openSubagentPanel}
							highlightMessageId={dock?.highlightMessageId}
							onBack={dock?.onBack ?? undefined}
							onMinimize={dock?.onMinimize ?? undefined}
						/>
					</LazyPanelBoundary>
				)}
			</FocusChatSlot>
		</Box>
	);
}

export interface SubagentSessionPanelContentProps {
	subagentNarratorId: string;
	compact: boolean;
	onClose: () => void;
	onHeaderPointerDown?: (event: React.PointerEvent) => void;
	onViewSubagentSession?: (narratorId: string, messageId?: string) => void;
	onTitleChange?: (title: string) => void;
	/** Host navigation only; the child must not inherit parent state publishers. */
	onOpenFilePanel?: FilePanelOpener;
	/**
	 * Scroll to and flash this message on mount — set when the panel was opened from
	 * a row that points at one specific thing this child said.
	 *
	 * Paired with `highlightRequestId` so a repeat click on an already-open panel
	 * jumps again without remounting the session or discarding its loaded history.
	 */
	highlightMessageId?: string;
	highlightRequestId?: string;
}

/** Full child-narrator session rendered inside a secondary dock panel. */
export function SubagentSessionPanelContent({
	subagentNarratorId,
	compact,
	onClose,
	onHeaderPointerDown,
	onViewSubagentSession,
	onTitleChange,
	onOpenFilePanel,
	highlightMessageId,
	highlightRequestId,
}: SubagentSessionPanelContentProps) {
	const navigate = useNavigate();
	const { data: narrator } = useNarrator(subagentNarratorId);
	const { data: userPrefs, isLoading: userPrefsLoading } = useUserPreferences();
	// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator entity
	const narratorData = narrator as any;
	const title = (narratorData?.title as string | undefined)?.trim() || "Subagent";
	const traits = Array.isArray(narratorData?.traits) ? (narratorData.traits as string[]) : [];

	useLayoutEffect(() => {
		onTitleChange?.(title);
	}, [onTitleChange, title]);

	const openStandalone = useCallback(() => {
		if (
			shouldAddSubagentRecentTab({
				isLoading: userPrefsLoading,
				addSubagentToRecentTabs: userPrefs?.addSubagentToRecentTabs,
			})
		) {
			addSubagentRecentTab({
				id: subagentNarratorId,
				parentNarratorId: narratorData?.parentNarratorId,
				title,
				cwd: narratorData?.cwd,
				status: narratorData?.status,
				isScheduled: traits.includes("scheduled"),
			});
		}
		onClose();
		navigate({
			to: "/narrators/$narratorId",
			params: { narratorId: subagentNarratorId },
		});
	}, [
		navigate,
		narratorData,
		onClose,
		subagentNarratorId,
		title,
		traits,
		userPrefs?.addSubagentToRecentTabs,
		userPrefsLoading,
	]);

	return (
		<NarratorDockContext.Provider value={null}>
			<FilePanelNavigationProvider value={onOpenFilePanel}>
				<LazyPanelBoundary>
					<NarratorPanel
						key={subagentNarratorId}
						highlightRequestId={highlightRequestId}
						narratorId={subagentNarratorId}
						narrator={narrator}
						compact={compact}
						onClose={onClose}
						onHeaderPointerDown={onHeaderPointerDown}
						onOpenStandalonePage={openStandalone}
						onViewSubagentSession={onViewSubagentSession}
						highlightMessageId={highlightMessageId}
					/>
				</LazyPanelBoundary>
			</FilePanelNavigationProvider>
		</NarratorDockContext.Provider>
	);
}

/**
 * Exported so a detached canvas node can reuse this adapter verbatim. Rendering
 * `SubagentSessionPanelContent` directly there would silently drop the header
 * drag wiring below (`onHeaderPointerDown` is optional on that component), leaving
 * a detached subagent panel with no way to be moved or dragged back into a dock.
 */
export function SubagentDockPanel(props: IDockviewPanelProps<SubagentPanelParams>) {
	const hostDock = useNarratorDockContext();
	const openFilePanel = useFilePanelSourceOpener(
		hostDock?.openFilePanel,
		props.api.id,
		props.params.subagentNarratorId,
	);
	const { ref, compact } = usePanelCompact();
	const close = useCallback(() => props.api.close(), [props.api]);
	const onHeaderPointerDown = usePanelHeaderDrag(props, props.params.subagentNarratorId, "tool", {
		toolKind: "subagent",
		// Multi-instance: the child narrator is this panel's resource identity.
		resourceId: props.params.subagentNarratorId,
	});
	const handleTitleChange = useCallback(
		(title: string) => {
			if (title !== props.api.title) props.api.setTitle(title);
		},
		[props.api],
	);

	return (
		<Box ref={ref} style={{ height: "100%", overflow: "hidden" }}>
			<SubagentSessionPanelContent
				subagentNarratorId={props.params.subagentNarratorId}
				compact={compact}
				onClose={close}
				onHeaderPointerDown={onHeaderPointerDown}
				onViewSubagentSession={hostDock?.openSubagentPanel}
				onOpenFilePanel={openFilePanel}
				onTitleChange={handleTitleChange}
				highlightMessageId={props.params.highlightMessageId}
				highlightRequestId={props.params.highlightRequestId}
			/>
		</Box>
	);
}

// ── Terminal ──
export function TerminalDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const { t } = useTranslation("terminal");
	const dock = useNarratorDockContext();
	// Live context is the source of truth (see ChatDockPanel note).
	const narratorId = dock?.narratorId ?? props.params.narratorId;
	const close = useCallback(() => props.api.close(), [props.api]);

	// Sync Dockview tab title with localization
	useLayoutEffect(() => {
		const title = t("terminal");
		if (title && title !== props.api.title) {
			props.api.setTitle(title);
		}
	}, [t, props.api]);

	// Bridge: register terminal stdin writer so chat can push text to us.
	const registerWrite = dock?.registerWriteTerminalStdin;
	const handleWriteRef = useCallback(
		(fn: ((text: string) => void) | null) => {
			if (!registerWrite || !fn) return;
			const unregister = registerWrite(fn);
			return unregister;
		},
		[registerWrite],
	);
	const unregisterRef = useRef<(() => void) | null>(null);
	const onWriteRef = useCallback(
		(fn: ((text: string) => void) | null) => {
			unregisterRef.current?.();
			unregisterRef.current = fn ? (handleWriteRef(fn) ?? null) : null;
		},
		[handleWriteRef],
	);
	useEffect(() => () => unregisterRef.current?.(), []);

	const sendToChat = useCallback((text: string) => dock?.appendChatInput(text), [dock]);

	return (
		<ToolPanelShell
			title={t("terminal")}
			icon={<IconTerminal2 size={16} color="var(--mantine-color-dimmed)" />}
			props={props}
			subjectId="__terminal__"
			detachKind="terminal"
		>
			<Suspense
				fallback={
					<Center h="100%">
						<Loader size="sm" />
					</Center>
				}
			>
				<NarratorTerminal
					narratorId={narratorId}
					onSendToChat={sendToChat}
					onWriteRef={onWriteRef}
					onExit={close}
				/>
			</Suspense>
		</ToolPanelShell>
	);
}

// ── Details ──
export function DetailsDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const { t } = useTranslation("narrator");
	const dock = useNarratorDockContext();
	const detailsProps = dock?.detailsProps;
	const close = useCallback(() => props.api.close(), [props.api]);
	const title = t("details.title");
	const icon = <IconInfoCircle size={16} color="var(--mantine-color-dimmed)" />;

	// Sync Dockview tab title with localization
	useLayoutEffect(() => {
		const titleValue = t("details.title");
		if (titleValue && titleValue !== props.api.title) {
			props.api.setTitle(titleValue);
		}
	}, [t, props.api]);

	// Status badge is a small control → hoisted into the shell header. The
	// narrator comes from the published details props (same source the panel uses).
	// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator entity
	const status = (detailsProps?.narrator as any)?.status as string | undefined;
	const statusLabel = status
		? ((): string => {
				const key = `status_${status}`;
				const translated = t(key);
				return translated === key ? status : translated;
			})()
		: null;
	const actions = statusLabel ? (
		<Badge size="xs" color={NARRATOR_STATUS_COLORS[status ?? ""] ?? "gray"} variant="light">
			{statusLabel}
		</Badge>
	) : undefined;

	if (!detailsProps) {
		return (
			<ToolPanelShell title={title} icon={icon} props={props} subjectId="__details__">
				<Center h="100%">
					<Loader size="sm" />
				</Center>
			</ToolPanelShell>
		);
	}
	return (
		<ToolPanelShell
			title={title}
			icon={icon}
			actions={actions}
			props={props}
			subjectId="__details__"
		>
			<LazyPanelBoundary>
				<NarratorDetailsPanel
					{...detailsProps}
					opened
					onClose={close}
					displayMode="inline"
					chromeless
				/>
			</LazyPanelBoundary>
		</ToolPanelShell>
	);
}

// ── File modifications ──
export function FileModDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const { t } = useTranslation("narrator");
	const dock = useNarratorDockContext();
	// Live context is the source of truth (see ChatDockPanel note).
	const narratorId = dock?.narratorId ?? props.params.narratorId;
	const fileModProps = dock?.fileModProps;
	const close = useCallback(() => props.api.close(), [props.api]);

	// Sync Dockview tab title with localization
	useLayoutEffect(() => {
		const title = t("fileMod_title");
		if (title && title !== props.api.title) {
			props.api.setTitle(title);
		}
	}, [t, props.api]);

	return (
		<ToolPanelShell
			title={t("fileMod_title")}
			icon={<IconFileCode size={16} color="var(--mantine-color-dimmed)" />}
			props={props}
			subjectId="__filemod__"
		>
			<LazyPanelBoundary>
				<FileModificationsPanel
					narratorId={narratorId}
					onClose={close}
					pendingPermission={fileModProps?.pendingPermission}
					onPermissionDecision={fileModProps?.onPermissionDecision}
					deletePreviewMessageId={fileModProps?.deletePreviewMessageId}
					onConfirmDelete={fileModProps?.onConfirmDelete}
					onCancelDelete={fileModProps?.onCancelDelete}
					chromeless
				/>
			</LazyPanelBoundary>
		</ToolPanelShell>
	);
}

// ── Spec ──
export function SpecDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const { t } = useTranslation("narrator");
	const dock = useNarratorDockContext();
	// Live context is the source of truth (see ChatDockPanel note).
	const narratorId = dock?.narratorId ?? props.params.narratorId;
	const close = useCallback(() => props.api.close(), [props.api]);

	// Sync Dockview tab title with localization
	useLayoutEffect(() => {
		const title = t("spec.title");
		if (title && title !== props.api.title) {
			props.api.setTitle(title);
		}
	}, [t, props.api]);

	return (
		<ToolPanelShell
			title={t("spec.title")}
			icon={<IconNotebook size={16} color="var(--mantine-color-indigo-4)" />}
			props={props}
			subjectId="__spec__"
			detachKind="spec"
		>
			<LazyPanelBoundary>
				<SpecPanel narratorId={narratorId} onClose={close} chromeless />
			</LazyPanelBoundary>
		</ToolPanelShell>
	);
}

// ── Git ──
export function GitDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const { t } = useTranslation("git");
	const dock = useNarratorDockContext();
	// Live context is the source of truth (see ChatDockPanel note).
	const narratorId = dock?.narratorId ?? props.params.narratorId;
	const chapterId = dock?.chapterId ?? props.params.chapterId;
	const icon = <IconGitBranch size={16} color="var(--mantine-color-dimmed)" />;

	// Sync Dockview tab title with localization
	useLayoutEffect(() => {
		const title = t("panel.title");
		if (title && title !== props.api.title) {
			props.api.setTitle(title);
		}
	}, [t, props.api]);

	if (!narratorId && !chapterId) {
		return (
			<ToolPanelShell
				title={t("panel.title")}
				icon={icon}
				props={props}
				subjectId="__git__"
				detachKind="git"
			>
				<Center h="100%">
					<Text size="sm" c="dimmed">
						{t("workspace.error")}
					</Text>
				</Center>
			</ToolPanelShell>
		);
	}
	return (
		<ToolPanelShell
			title={t("panel.title")}
			icon={icon}
			props={props}
			subjectId="__git__"
			detachKind="git"
		>
			<LazyPanelBoundary>
				<GitPanel narratorId={narratorId} chapterId={chapterId} />
			</LazyPanelBoundary>
		</ToolPanelShell>
	);
}

// ── Browser ──
export function BrowserDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const { t } = useTranslation("narrator");
	const dock = useNarratorDockContext();
	// Live context is the source of truth (see ChatDockPanel note).
	const narratorId = dock?.narratorId ?? props.params.narratorId;

	// Sync Dockview tab title with localization
	useLayoutEffect(() => {
		const title = t("browser.title");
		if (title && title !== props.api.title) {
			props.api.setTitle(title);
		}
	}, [t, props.api]);

	// Session count is a small control → hoisted into the shell header.
	const count = dock?.browserInfo.sessionCount ?? 0;
	const actions =
		count > 0 ? (
			<Badge size="xs" variant="light" color="teal" circle>
				{count}
			</Badge>
		) : undefined;
	return (
		<ToolPanelShell
			title={t("browser.title")}
			icon={<IconWorldWww size={16} color="var(--mantine-color-teal-5)" />}
			actions={actions}
			props={props}
			subjectId="__browser__"
			detachKind="browser"
		>
			<LazyPanelBoundary>
				<BrowserPanel
					narratorId={narratorId}
					sessionCount={dock?.browserInfo.sessionCount}
					visualChange={dock?.browserInfo.visualChange}
					chromeless
				/>
			</LazyPanelBoundary>
		</ToolPanelShell>
	);
}

// ── Background tasks ──
export function TasksDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const { t } = useTranslation("narrator");
	const dock = useNarratorDockContext();
	// Live context is the source of truth (see ChatDockPanel note).
	const narratorId = dock?.narratorId ?? props.params.narratorId;
	const icon = <IconRobot size={16} color="var(--mantine-color-dimmed)" />;

	// Sync Dockview tab title with localization
	useLayoutEffect(() => {
		const title = t("backgroundTasks.title");
		if (title && title !== props.api.title) {
			props.api.setTitle(title);
		}
	}, [t, props.api]);

	return (
		<ToolPanelShell
			title={t("backgroundTasks.title")}
			icon={icon}
			props={props}
			subjectId="__tasks__"
			detachKind="tasks"
		>
			<LazyPanelBoundary>
				<BackgroundTasksPanel narratorId={narratorId} chromeless />
			</LazyPanelBoundary>
		</ToolPanelShell>
	);
}

// ── Search ──
export function SearchDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const { t } = useTranslation("narrator");
	const dock = useNarratorDockContext();
	// Live context is the source of truth (see ChatDockPanel note).
	const narratorId = dock?.narratorId ?? props.params.narratorId;

	// Sync Dockview tab title with localization
	useLayoutEffect(() => {
		const title = t("search.title");
		if (title && title !== props.api.title) {
			props.api.setTitle(title);
		}
	}, [t, props.api]);

	return (
		<ToolPanelShell
			title={t("search.title")}
			icon={<IconSearch size={16} color="var(--mantine-color-dimmed)" />}
			props={props}
			subjectId="__search__"
			detachKind="search"
		>
			<LazyPanelBoundary>
				<NarratorSearchPanel narratorId={narratorId} />
			</LazyPanelBoundary>
		</ToolPanelShell>
	);
}

// ── User chat (human discussion room beside this narrator) ──
export function UserChatDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const { t } = useTranslation("chat");
	const dock = useNarratorDockContext();
	// Live context is the source of truth (see ChatDockPanel note).
	const narratorId = dock?.narratorId ?? props.params.narratorId;

	useLayoutEffect(() => {
		const title = t("panelTitle");
		if (title && title !== props.api.title) props.api.setTitle(title);
	}, [t, props.api]);

	return (
		<ToolPanelShell
			title={t("panelTitle")}
			icon={<IconMessages size={16} color="var(--mantine-color-blue-4)" />}
			props={props}
			subjectId="__userchat__"
			detachKind="userchat"
		>
			<LazyPanelBoundary>
				<NarratorUserChatPanel narratorId={narratorId} />
			</LazyPanelBoundary>
		</ToolPanelShell>
	);
}

// ── Appearance (live transcript typography) ──
export function AppearanceDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const { t } = useTranslation("narrator");

	useLayoutEffect(() => {
		const title = t("appearance.title");
		if (title && title !== props.api.title) props.api.setTitle(title);
	}, [t, props.api]);

	return (
		<ToolPanelShell
			title={t("appearance.title")}
			icon={<IconTextSize size={16} color="var(--mantine-color-dimmed)" />}
			props={props}
			subjectId="__appearance__"
			detachKind="appearance"
		>
			<LazyPanelBoundary>
				<AppearancePanel />
			</LazyPanelBoundary>
		</ToolPanelShell>
	);
}

// ── Mock stream harness (TEMPORARY, see ../mock/README-REMOVAL.md) ──
export function MockDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const dock = useNarratorDockContext();
	// Live context is the source of truth (see ChatDockPanel note).
	const narratorId = dock?.narratorId ?? props.params.narratorId;

	// Title is hard-coded (not i18n) like the rest of this debug surface.
	useLayoutEffect(() => {
		if (props.api.title !== "Mock stream") props.api.setTitle("Mock stream");
	}, [props.api]);

	return (
		<ToolPanelShell
			title="Mock stream"
			icon={<IconFlask size={16} color="var(--mantine-color-dimmed)" />}
			props={props}
			subjectId="__mock__"
		>
			<LazyPanelBoundary>
				<MockStreamPanel narratorId={narratorId} />
			</LazyPanelBoundary>
		</ToolPanelShell>
	);
}

/**
 * Dockview exposes no cancellable panel-removal event: onWillMutateLayout is
 * notification-only. Its tabs, keyboard close and our surfaces use api.close().
 * Guard that shared entry point and restore it when the panel unmounts.
 *
 * Native dragstart capture is also required: onWillDrag* depends on Dockview's
 * optional advanced DnD service. Cancel BEFORE Dockview installs transfer data
 * and iframe shields (a canceled native drag does not emit dragend to clean up).
 * Block at drag START, not at close after the destination already recreated it.
 */
export function bindFilePanelExitGuard(
	{ api, containerApi }: Pick<IDockviewPanelProps<FilePanelParams>, "api" | "containerApi">,
	canExit: () => boolean,
): () => void {
	const originalClose = api.close;
	const guardedClose = () => {
		if (canExit()) originalClose.call(api);
	};
	api.close = guardedClose;
	const cancel = (event: Event) => {
		if (event.defaultPrevented || canExit()) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	const panelDrag = containerApi.onWillDragPanel((event) => {
		if (event.panel.id === api.id) cancel(event.nativeEvent);
	});
	const groupDrag = containerApi.onWillDragGroup((event) => {
		if (event.group.id === api.group.id) cancel(event.nativeEvent);
	});
	const doc = api.getWindow().document;
	const nativeDrag = (event: DragEvent) => {
		const target = event.target as Element | null;
		if (!target?.closest) return;
		const tab = target.closest(".dv-tab");
		if (tab) {
			const ownTab = containerApi.getPanel(api.id)?.view.tab.element;
			if (ownTab && tab.contains(ownTab)) cancel(event);
			return;
		}
		// Empty header space / tab-group grips can move the entire group. Query
		// this group's actual header so another surface's tabs remain draggable.
		const header = api.group.element.querySelector(".dv-tabs-and-actions-container");
		if (header?.contains(target)) cancel(event);
	};
	doc.addEventListener("dragstart", nativeDrag, true);
	return () => {
		if (api.close === guardedClose) api.close = originalClose;
		panelDrag.dispose();
		groupDrag.dispose();
		doc.removeEventListener("dragstart", nativeDrag, true);
	};
}

// Each mounted panel keeps its own last publication as its ownership token.
// Metadata refreshes and cleanup may only replace that token, never another panel's.
export function useFilePanelSelectionPublisher() {
	const dock = useNarratorDockContext();
	const dockRef = useRef(dock);
	dockRef.current = dock;
	const narratorId = dock?.narratorId;
	const publishedSelectionRef = useRef<FileReferenceEditorSelection | null>(null);
	return useCallback(
		(next: FileReferenceEditorSelection | null, takeOwnership = false) => {
			const current = dockRef.current;
			if (current?.narratorId !== narratorId) return;
			if (
				(next && takeOwnership) ||
				current?.fileReferenceSelection === publishedSelectionRef.current
			) {
				publishedSelectionRef.current = next;
				current?.setFileReferenceSelection?.(next);
			}
		},
		[narratorId],
	);
}

// ── File editor / binary preview (multi-instance, one panel per path) ──
export function FileDockPanel(props: IDockviewPanelProps<FilePanelParams>) {
	const { t } = useTranslation("narrator");
	const dock = useNarratorDockContext();
	// File identity is a RESOURCE, so the path comes from params (several file panels
	// coexist). Host identity is different: on a focus surface the live context is the
	// source of truth, while workspace/detached surfaces carry it in params.
	const {
		filePath,
		fileName,
		deviceId = "local",
		selection,
		highlightRequestId,
		referenceOrigin,
		toolEdit,
	} = props.params;
	const hostNarratorId = dock?.narratorId ?? props.params.hostNarratorId;
	const fileNarratorId = props.params.fileNarratorId ?? toolEdit?.narratorId ?? hostNarratorId;
	const openFilePanel = dock?.openFilePanel;
	const openFileTarget = useCallback(
		(target: FileTarget) =>
			openFilePanel?.(target.path, undefined, {
				...target,
				fileNarratorId,
				referenceOrigin: true,
			}),
		[openFilePanel, fileNarratorId],
	);
	// Selections still belong to the receiving chat, not the file-operation session.
	const publishSelection = useFilePanelSelectionPublisher();
	const title = fileName?.trim() || filePanelBaseName(filePath) || t("fileViewer.title");
	const [editorDirty, setEditorDirty] = useState(false);
	const dirtyRef = useRef(false);
	const onDirtyChange = useCallback((dirty: boolean) => {
		// Synchronous ref keeps close/drag guards current before React rerenders.
		dirtyRef.current = dirty;
		setEditorDirty(dirty);
	}, []);
	const canExit = useCallback(() => {
		if (!dirtyRef.current) return true;
		notifications.show({
			color: "yellow",
			message: t("fileEditor.unsavedBlockExit"),
			autoClose: 5000,
		});
		return false;
	}, [t]);
	useLayoutEffect(
		() => bindFilePanelExitGuard({ api: props.api, containerApi: props.containerApi }, canExit),
		[props.api, props.containerApi, canExit],
	);
	const displayTitle = toolEdit ? `${title} · Edit` : editorDirty ? `${title} *` : title;
	// Text always uses CodeMirror; the editor itself enforces write capability.
	const isText = getFilePreviewType(filePath ?? "") === "text";

	useLayoutEffect(() => {
		if (!hostNarratorId || props.params.hostNarratorId === hostNarratorId) return;
		// Hydrate focus layouts saved before file editing recorded ownership, so the
		// editor has its workspace scope on restore and future drags retain it.
		props.api.updateParameters({ ...props.params, hostNarratorId });
	}, [hostNarratorId, props.api, props.params]);

	useLayoutEffect(() => {
		if (displayTitle !== props.api.title) props.api.setTitle(displayTitle);
	}, [displayTitle, props.api]);

	if (!filePath) {
		return (
			<ToolPanelShell
				title={t("fileViewer.title")}
				icon={<IconFileText size={16} color="var(--mantine-color-dimmed)" />}
				props={props}
				subjectId="__file__"
			>
				<Center h="100%">
					<Text size="sm" c="dimmed">
						{t("fileViewer.noFile")}
					</Text>
				</Center>
			</ToolPanelShell>
		);
	}

	return (
		<ToolPanelShell
			title={displayTitle}
			icon={<IconFileText size={16} color="var(--mantine-color-dimmed)" />}
			props={props}
			subjectId={`__file__:${filePath}`}
			detachKind="file"
			beforeDrag={canExit}
			// Multi-instance: the path is what identifies WHICH file viewer this is, so
			// a torn-out panel can be rebuilt pointing at the same file.
			resourceId={filePanelResourceId(
				filePath,
				deviceId,
				referenceOrigin,
				toolEdit,
				props.params.fileNarratorId,
			)}
		>
			<FileReferenceScopeProvider
				value={{
					narratorId: fileNarratorId,
					openFile: openFilePanel ? openFileTarget : undefined,
					addReference: dock?.addFileReference,
					setSelection: publishSelection,
				}}
			>
				<LazyPanelBoundary>
					{toolEdit ? (
						<ToolEditFileViewer
							key={toolEditReferenceKey(toolEdit)}
							reference={toolEdit}
							filePath={filePath}
							navigationRequestId={highlightRequestId}
						/>
					) : isText ? (
						<FileEditorContent
							key={`edit:${fileNarratorId}:${deviceId}:${filePath}`}
							filePath={filePath}
							narratorId={fileNarratorId}
							deviceId={deviceId}
							referenceOrigin={referenceOrigin}
							selection={selection}
							navigationRequestId={highlightRequestId}
							onDirtyChange={onDirtyChange}
						/>
					) : (
						<FileViewerContent
							key={`${fileNarratorId}:${deviceId}:${filePath}`}
							filePath={filePath}
							narratorId={fileNarratorId}
							deviceId={deviceId}
							referenceOrigin={referenceOrigin}
							selection={selection}
							highlightRequestId={highlightRequestId}
						/>
					)}
				</LazyPanelBoundary>
			</FileReferenceScopeProvider>
		</ToolPanelShell>
	);
}

// ── File tree (singleton browser of the narrator's cwd) ──
export function FileTreeDockPanel(props: IDockviewPanelProps<NarratorBoundPanelParams>) {
	const { t } = useTranslation("narrator");
	const dock = useNarratorDockContext();
	// Live context is the source of truth (see ChatDockPanel note).
	const narratorId = dock?.narratorId ?? props.params.narratorId;
	const openFilePanel = dock?.openFilePanel;

	useLayoutEffect(() => {
		const title = t("fileTree.title");
		if (title && title !== props.api.title) props.api.setTitle(title);
	}, [t, props.api]);

	const handleOpenFile = useCallback(
		(absolutePath: string, fileName: string) => {
			// Routed through the dock's existing multi-instance file viewer rather than a
			// viewer of our own: re-opening the same path must focus the panel that is
			// already showing it, and that dedup lives in `openFilePanel`.
			openFilePanel?.(absolutePath, fileName, {
				sourcePanelId: props.api.id,
				fileNarratorId: narratorId,
				deviceId: "local",
			});
		},
		[openFilePanel, props.api.id, narratorId],
	);

	return (
		<ToolPanelShell
			title={t("fileTree.title")}
			icon={<IconFolder size={16} color="var(--mantine-color-dimmed)" />}
			props={props}
			subjectId="__filetree__"
			detachKind="filetree"
		>
			<LazyPanelBoundary>
				<FileTreePanel narratorId={narratorId} onOpenFile={handleOpenFile} />
			</LazyPanelBoundary>
		</ToolPanelShell>
	);
}

// ── Knowledge entry (multi-instance, one panel per entry) ──
export function KnowledgeDockPanel(props: IDockviewPanelProps<KnowledgePanelParams>) {
	const { t } = useTranslation("knowledge");
	const { entryId, scope } = props.params;

	const close = useCallback(() => props.api.close(), [props.api]);

	useLayoutEffect(() => {
		// Title will be updated by the content component once loaded; start generic.
		const fallback = t("panel.title");
		if (!props.api.title || props.api.title === "Knowledge") props.api.setTitle(fallback);
	}, [t, props.api]);

	if (!entryId) {
		return (
			<ToolPanelShell
				title={t("panel.title")}
				icon={<IconNotebook size={16} color="var(--mantine-color-dimmed)" />}
				props={props}
				subjectId="__knowledge__"
			>
				<Center h="100%">
					<Text size="sm" c="dimmed">
						{t("panel.notFound")}
					</Text>
				</Center>
			</ToolPanelShell>
		);
	}

	return (
		<ToolPanelShell
			title={t("panel.title")}
			icon={<IconNotebook size={16} color="var(--mantine-color-dimmed)" />}
			props={props}
			subjectId={`__knowledge__:${entryId}`}
			detachKind="knowledge"
			resourceId={entryId}
		>
			<LazyPanelBoundary>
				<KnowledgeEntryPanelContent key={entryId} entryId={entryId} scope={scope} onClose={close} />
			</LazyPanelBoundary>
		</ToolPanelShell>
	);
}

/** Component registry passed to <DockviewSurface components={...} />. */
export const narratorDockComponents: Record<
	NarratorDockPanelType,
	// biome-ignore lint/suspicious/noExplicitAny: dockview panel registry is heterogeneous
	React.FunctionComponent<IDockviewPanelProps<any>>
> = {
	chat: ChatDockPanel,
	terminal: TerminalDockPanel,
	details: DetailsDockPanel,
	filemod: FileModDockPanel,
	spec: SpecDockPanel,
	git: GitDockPanel,
	browser: BrowserDockPanel,
	tasks: TasksDockPanel,
	search: SearchDockPanel,
	userchat: UserChatDockPanel,
	appearance: AppearanceDockPanel,
	subagent: SubagentDockPanel,
	filetree: FileTreeDockPanel,
	file: FileDockPanel,
	knowledge: KnowledgeDockPanel,
	plugin: PluginDockPanel,
	// TEMPORARY (see ../mock/README-REMOVAL.md).
	mock: MockDockPanel,
};

/**
 * Close-less tab for the chat panel. The chat panel is the cluster's
 * protagonist and must never be closed (focus-page rule), so its dockview tab
 * renders the title only — no close action. Tool panels keep the default tab
 * (with close).
 */
function ChatTab(props: IDockviewPanelHeaderProps) {
	const [title, setTitle] = useState(props.api.title ?? "");
	useEffect(() => {
		const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? ""));
		return () => d.dispose();
	}, [props.api]);
	return (
		<Box px="sm" style={{ display: "flex", alignItems: "center", height: "100%" }}>
			<Text size="xs" fw={600} truncate>
				{title}
			</Text>
		</Box>
	);
}

/** Per-panel tab renderers for the focus dock (chat = close-less). */
export const narratorDockTabComponents: Record<
	string,
	React.FunctionComponent<IDockviewPanelHeaderProps>
> = {
	chat: ChatTab,
};
