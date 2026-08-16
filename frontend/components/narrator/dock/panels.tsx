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
 *   - git      → GitPanel (needs chapterId)
 *   - browser  → BrowserPanel — session info from dock context
 *
 * Tool panels take their cross-panel state from NarratorDockContext (published
 * by the chat panel), so they can live as dockview siblings of chat.
 */

import { ActionIcon, Badge, Box, Center, Group, Loader, Text, Tooltip } from "@mantine/core";
import {
	IconFileCode,
	IconFileText,
	IconFlask,
	IconGitBranch,
	IconInfoCircle,
	IconMessages,
	IconNotebook,
	IconRobot,
	IconSearch,
	IconTerminal2,
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
import type {
	FilePanelParams,
	NarratorBoundPanelParams,
	SubagentPanelParams,
} from "../panels/panel-kind";
import { usePanelCompact, usePanelHeaderDrag } from "../panels/shared";
import type { NarratorDockPanelType } from "./dock-panel-types";
import { NarratorDockContext, useNarratorDockContext } from "./NarratorDockContext";

const NarratorTerminal = lazy(() =>
	import("../../terminal/NarratorTerminal").then((m) => ({ default: m.NarratorTerminal })),
);
const NarratorPanel = lazy(() =>
	import("../NarratorPanel").then((m) => ({ default: m.NarratorPanel })),
);
const NarratorDetailsPanel = lazy(() =>
	import("../NarratorDetailsPanel").then((m) => ({ default: m.NarratorDetailsPanel })),
);
const BackgroundTasksPanel = lazy(() =>
	import("../BackgroundTasksDrawer").then((m) => ({ default: m.BackgroundTasksPanel })),
);
const BrowserPanel = lazy(() =>
	import("../BrowserPanel").then((m) => ({ default: m.BrowserPanel })),
);
const FileModificationsPanel = lazy(() =>
	import("../FileModificationsDrawer").then((m) => ({ default: m.FileModificationsPanel })),
);
const SpecPanel = lazy(() => import("../SpecPanel").then((m) => ({ default: m.SpecPanel })));
const NarratorSearchPanel = lazy(() =>
	import("../NarratorSearchPanel").then((m) => ({ default: m.NarratorSearchPanel })),
);
const NarratorUserChatPanel = lazy(() =>
	import("../../chat/NarratorUserChatPanel").then((m) => ({ default: m.NarratorUserChatPanel })),
);
const GitPanel = lazy(() =>
	import("../../chapter/GitPanel").then((m) => ({ default: m.GitPanel })),
);
const FileViewerContent = lazy(() =>
	import("../file-viewer/FileViewerContent").then((m) => ({ default: m.FileViewerContent })),
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
			{actions ? (
				<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
					{actions}
				</Group>
			) : null}
			<Tooltip label="Close" withinPortal>
				<ActionIcon size="sm" variant="subtle" color="gray" onClick={onClose}>
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
	children: React.ReactNode;
}) {
	const onPointerDown = usePanelHeaderDrag(props, subjectId, "tool");
	const close = useCallback(() => props.api.close(), [props.api]);
	return (
		<Box style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
			<ToolPanelHeader
				title={title}
				icon={icon}
				actions={actions}
				onPointerDown={onPointerDown}
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
	const { ref, compact } = usePanelCompact();
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
		</Box>
	);
}

export interface SubagentSessionPanelContentProps {
	subagentNarratorId: string;
	compact: boolean;
	onClose: () => void;
	onHeaderPointerDown?: (event: React.PointerEvent) => void;
	onViewSubagentSession?: (narratorId: string) => void;
	onTitleChange?: (title: string) => void;
}

/** Full child-narrator session rendered inside a secondary dock panel. */
export function SubagentSessionPanelContent({
	subagentNarratorId,
	compact,
	onClose,
	onHeaderPointerDown,
	onViewSubagentSession,
	onTitleChange,
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
			<LazyPanelBoundary>
				<NarratorPanel
					key={subagentNarratorId}
					narratorId={subagentNarratorId}
					narrator={narrator}
					compact={compact}
					onClose={onClose}
					onHeaderPointerDown={onHeaderPointerDown}
					onOpenStandalonePage={openStandalone}
					onViewSubagentSession={onViewSubagentSession}
				/>
			</LazyPanelBoundary>
		</NarratorDockContext.Provider>
	);
}

function SubagentDockPanel(props: IDockviewPanelProps<SubagentPanelParams>) {
	const hostDock = useNarratorDockContext();
	const { ref, compact } = usePanelCompact();
	const close = useCallback(() => props.api.close(), [props.api]);
	const onHeaderPointerDown = usePanelHeaderDrag(props, props.params.subagentNarratorId, "tool");
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
				onTitleChange={handleTitleChange}
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
	const chapterId = dock?.chapterId ?? props.params.chapterId;
	const icon = <IconGitBranch size={16} color="var(--mantine-color-dimmed)" />;

	// Sync Dockview tab title with localization
	useLayoutEffect(() => {
		const title = t("panel.title");
		if (title && title !== props.api.title) {
			props.api.setTitle(title);
		}
	}, [t, props.api]);

	if (!chapterId) {
		return (
			<ToolPanelShell title={t("panel.title")} icon={icon} props={props} subjectId="__git__">
				<Center h="100%">
					<Text size="sm" c="dimmed">
						No chapter
					</Text>
				</Center>
			</ToolPanelShell>
		);
	}
	return (
		<ToolPanelShell title={t("panel.title")} icon={icon} props={props} subjectId="__git__">
			<LazyPanelBoundary>
				<GitPanel chapterId={chapterId} />
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
		>
			<LazyPanelBoundary>
				<NarratorUserChatPanel narratorId={narratorId} />
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

// ── File viewer (multi-instance, one panel per path) ──
export function FileDockPanel(props: IDockviewPanelProps<FilePanelParams>) {
	const { t } = useTranslation("narrator");
	// Identity is a RESOURCE, so it comes from params (like a subagent's child id)
	// rather than the live page context — several file panels coexist per surface.
	const { filePath, fileName } = props.params;
	const title = fileName?.trim() || filePath.split(/[/\\]/).pop() || t("fileViewer.title");

	useLayoutEffect(() => {
		if (title && title !== props.api.title) props.api.setTitle(title);
	}, [title, props.api]);

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
			title={title}
			icon={<IconFileText size={16} color="var(--mantine-color-dimmed)" />}
			props={props}
			subjectId={`__file__:${filePath}`}
		>
			<LazyPanelBoundary>
				<FileViewerContent key={filePath} filePath={filePath} />
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
	subagent: SubagentDockPanel,
	file: FileDockPanel,
	plugin: PluginDockPanel,
	// TEMPORARY (see ../mock/README-REMOVAL.md).
	mock: MockDockPanel,
};

/**
 * Close-less tab for the chat panel. The chat panel is the cluster's
 * protagonist and must never be closed (focus-page rule), so its dockview tab
 * renders the title only — no close action. Tool panels keep the default tab
 * (with close). Note: when chat is alone in its group the tab strip is hidden
 * entirely (`.dv-single-tab`); this matters only when a tool is dragged into
 * chat's group, making the strip visible.
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
