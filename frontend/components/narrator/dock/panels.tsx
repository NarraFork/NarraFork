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
	IconGitBranch,
	IconInfoCircle,
	IconNotebook,
	IconRobot,
	IconTerminal2,
	IconWorldWww,
	IconX,
} from "@tabler/icons-react";
import type { IDockviewPanelHeaderProps, IDockviewPanelProps } from "dockview-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarrator } from "../../../hooks/useNarrator";
import { NARRATOR_STATUS_COLORS } from "../../../lib/constants";
import { GitPanel } from "../../chapter/GitPanel";
import { BackgroundTasksPanel } from "../BackgroundTasksDrawer";
import { BrowserPanel } from "../BrowserPanel";
import { FileModificationsPanel } from "../FileModificationsDrawer";
import { NarratorDetailsPanel } from "../NarratorDetailsPanel";
import { NarratorPanel } from "../NarratorPanel";
import { usePanelCompact, usePanelHeaderDrag, useSubagentStack } from "../panels/shared";
import { SpecPanel } from "../SpecPanel";
import type { NarratorDockPanelParams, NarratorDockPanelType } from "./dock-panel-types";
import { useNarratorDockContext } from "./NarratorDockContext";

const NarratorTerminal = lazy(() =>
	import("../../terminal/NarratorTerminal").then((m) => ({ default: m.NarratorTerminal })),
);

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
	props: IDockviewPanelProps<NarratorDockPanelParams>;
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
function ChatDockPanel(props: IDockviewPanelProps<NarratorDockPanelParams>) {
	const dock = useNarratorDockContext();
	// Identity ALWAYS comes from the live page context, never the serialized
	// params: a restored dockview layout bakes params.narratorId into
	// localStorage, so trusting it would render a stale/foreign narrator ("open A,
	// see B"). params only decides *which kind* of panel this is.
	const narratorId = dock?.narratorId ?? props.params.narratorId;
	const onForkFromMessage = dock?.onForkFromMessage ?? undefined;
	// Deep-link / search-result jump target. Applies only to the primary
	// narrator view, not the subagent stack overlay (which shows a different
	// narrator's messages).
	const highlightMessageId = dock?.highlightMessageId;
	const { ref, compact } = usePanelCompact();
	const { currentNarratorId, isSubagentView, openSubagent, restoreParent } =
		useSubagentStack(narratorId);
	const onHeaderPointerDown = usePanelHeaderDrag(props, narratorId);

	const { data: narratorData } = useNarrator(currentNarratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON entity
	const narratorTitle = (narratorData as any)?.title as string | undefined;
	useLayoutEffect(() => {
		const title = narratorTitle?.trim();
		if (title && title !== props.api.title) props.api.setTitle(title);
	}, [narratorTitle, props.api]);

	return (
		<Box ref={ref} style={{ position: "relative", height: "100%", overflow: "hidden" }}>
			<Box
				style={{
					position: "absolute",
					inset: 0,
					visibility: isSubagentView ? "hidden" : "visible",
				}}
			>
				<NarratorPanel
					key={narratorId}
					narratorId={narratorId}
					compact={compact}
					onForkFromMessage={onForkFromMessage}
					onHeaderPointerDown={onHeaderPointerDown}
					onViewSubagentSession={openSubagent}
					highlightMessageId={highlightMessageId}
				/>
			</Box>
			{isSubagentView && (
				<Box style={{ position: "absolute", inset: 0 }}>
					<NarratorPanel
						key={currentNarratorId}
						narratorId={currentNarratorId}
						compact={compact}
						onBack={restoreParent}
						onHeaderPointerDown={onHeaderPointerDown}
						onViewSubagentSession={openSubagent}
					/>
				</Box>
			)}
		</Box>
	);
}

// ── Terminal ──
export function TerminalDockPanel(props: IDockviewPanelProps<NarratorDockPanelParams>) {
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
export function DetailsDockPanel(props: IDockviewPanelProps<NarratorDockPanelParams>) {
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
			<NarratorDetailsPanel
				{...detailsProps}
				opened
				onClose={close}
				displayMode="inline"
				chromeless
			/>
		</ToolPanelShell>
	);
}

// ── File modifications ──
export function FileModDockPanel(props: IDockviewPanelProps<NarratorDockPanelParams>) {
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
		</ToolPanelShell>
	);
}

// ── Spec ──
export function SpecDockPanel(props: IDockviewPanelProps<NarratorDockPanelParams>) {
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
			<SpecPanel narratorId={narratorId} onClose={close} chromeless />
		</ToolPanelShell>
	);
}

// ── Git ──
export function GitDockPanel(props: IDockviewPanelProps<NarratorDockPanelParams>) {
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
			<GitPanel chapterId={chapterId} />
		</ToolPanelShell>
	);
}

// ── Browser ──
export function BrowserDockPanel(props: IDockviewPanelProps<NarratorDockPanelParams>) {
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
			<BrowserPanel
				narratorId={narratorId}
				sessionCount={dock?.browserInfo.sessionCount}
				visualChange={dock?.browserInfo.visualChange}
				chromeless
			/>
		</ToolPanelShell>
	);
}

// ── Background tasks ──
export function TasksDockPanel(props: IDockviewPanelProps<NarratorDockPanelParams>) {
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
			<BackgroundTasksPanel narratorId={narratorId} chromeless />
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
