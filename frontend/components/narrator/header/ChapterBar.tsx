import { useChapterGitStatus } from "@frontend/hooks/useChapterGitStatus";
import { useChapter } from "@frontend/hooks/useChapters";
import { useContainers } from "@frontend/hooks/useContainers";
import { gitWorkspaceTarget, useGitStatus, useGitWorkspace } from "@frontend/hooks/useGit";
import { useChapterContainersCapability } from "@frontend/hooks/usePlatform";
import { useWorkspaceContext } from "@frontend/hooks/useWorkspaceContext";
import { type ApiError, api } from "@frontend/lib/api";
import { statusRegistry } from "@frontend/lib/constants";
import { ActionIcon, Badge, Drawer, Group, Menu, Stack, Text, Tooltip } from "@mantine/core";
import {
	IconGitBranch,
	IconGitCommit,
	IconGitFork,
	IconGitMerge,
	IconMoon,
	IconPackage,
	IconSettings,
	IconSun,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { lazy, Suspense, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { NarratorCompatibilityEntry } from "../../project/NarratorCompatibilityEntry";
import { useNarratorDockContext } from "../dock/NarratorDockContext";
import classes from "./ChapterBar.module.css";
import { isActivationKey, isTextSelectionGesture } from "./chapter-bar-git-trigger";
import { NarratorWorktreeControls } from "./NarratorWorktreeControls";

// Lazy-loaded heavy panels and modals — only needed when user opens them
const ChapterForkModal = lazy(() =>
	import("@frontend/components/chapter/ChapterForkModal").then((m) => ({
		default: m.ChapterForkModal,
	})),
);
const ChapterMergeModal = lazy(() =>
	import("@frontend/components/chapter/ChapterMergeModal").then((m) => ({
		default: m.ChapterMergeModal,
	})),
);
const ContainerPanel = lazy(() =>
	import("@frontend/components/container/ContainerPanel").then((m) => ({
		default: m.ContainerPanel,
	})),
);
const ContainerConfigModal = lazy(() =>
	import("@frontend/components/container/ContainerConfigModal").then((m) => ({
		default: m.ContainerConfigModal,
	})),
);
const PodmanInstallModal = lazy(() =>
	import("@frontend/components/container/PodmanInstallModal").then((m) => ({
		default: m.PodmanInstallModal,
	})),
);

/**
 * Git strip for standalone narrators (no chapter worktree).
 *
 * Non-git working directories render nothing: a row that only says "not a Git
 * tree" is pure vertical noise. Pending probe is also hidden so a non-git cwd
 * does not flash a loading line before vanishing. Discovery failures and other
 * unusable-environment states stay visible so they can still be retried from
 * the panel.
 */
export function NarratorGitBar({
	narratorId,
	onOpenGitPanel,
	onRequirement,
}: {
	narratorId: string;
	onOpenGitPanel: () => void;
	onRequirement?: (text: string) => void;
}) {
	const { t } = useTranslation("git");
	const workspace = useGitWorkspace(narratorId);
	const { data: executionContext } = useWorkspaceContext(narratorId);
	const target = !workspace.isError ? gitWorkspaceTarget(narratorId, workspace.data) : null;
	const status = useGitStatus(target);
	const workspaceState = workspace.data?.state;
	if (
		!workspace.isError &&
		((workspace.isPending && !executionContext?.git) || workspaceState === "not_git")
	) {
		return null;
	}
	return (
		<Group
			px="md"
			py={4}
			gap={6}
			wrap="nowrap"
			role="button"
			tabIndex={0}
			aria-label={t("panel.title")}
			style={{ flexShrink: 0, cursor: "pointer", userSelect: "text" }}
			onClick={(event) => {
				// Portal events bubble through React, even when outside this DOM row.
				if (!event.currentTarget.contains(event.target as Node)) return;
				if (!isTextSelectionGesture(window.getSelection())) onOpenGitPanel();
			}}
			onKeyDown={(event) => {
				if (!event.currentTarget.contains(event.target as Node)) return;
				if (isActivationKey(event.key)) {
					event.preventDefault();
					onOpenGitPanel();
				}
			}}
		>
			<Group gap={6} wrap="nowrap">
				<IconGitBranch size={14} color="var(--mantine-color-dimmed)" aria-hidden="true" />
				<Text
					size="xs"
					c="dimmed"
					ff="monospace"
					truncate
					title={
						executionContext ? `${executionContext.deviceId}: ${executionContext.cwd}` : undefined
					}
				>
					{target
						? status.data?.branch || t("workspace.ready")
						: t(
								`workspace.${workspace.isPending ? "loading" : workspace.isError ? "error" : (workspace.data?.state ?? "error")}`,
							)}
				</Text>
			</Group>
			{status.data && (
				<Tooltip label={t("panel.changes")}>
					<Badge size="xs" variant="light">
						<Group gap={5} wrap="nowrap">
							<Text span size="xs" fw={600}>
								{status.data.totalFiles}
							</Text>
							<Text span size="xs" c="green" fw={600}>
								+{status.data.linesAdded}
							</Text>
							<Text span size="xs" c="red" fw={600}>
								-{status.data.linesRemoved}
							</Text>
						</Group>
					</Badge>
				</Tooltip>
			)}
			<NarratorWorktreeControls
				key={narratorId}
				narratorId={narratorId}
				onRequirement={onRequirement}
			/>
			{target && !workspace.data?.capabilities.write && (
				<Text size="xs" c="dimmed">
					{t("workspace.readOnly")}
				</Text>
			)}
		</Group>
	);
}

interface ChapterBarProps {
	chapterId: string;
	narratorId?: string;
	/**
	 * Open the Git view for this chapter. NarratorPanel routes the gesture: dock
	 * panel when a dock surface exists, the mobile Drawer host otherwise. The raw
	 * dock context below is only a fallback for surfaces that render this bar
	 * without the panel around it.
	 */
	onOpenGitPanel?: () => void;
	onRequirement?: (text: string) => void;
}

export function ChapterBar({
	chapterId,
	narratorId,
	onOpenGitPanel,
	onRequirement,
}: ChapterBarProps) {
	const { t } = useTranslation("chapters");
	const { t: tn } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { data: chapter } = useChapter(chapterId);
	const { data: executionContext } = useWorkspaceContext(narratorId ?? "");
	const workspaceQuery = useGitWorkspace(narratorId);
	const { data: workspaceStatus } = useGitStatus(
		narratorId && !workspaceQuery.isError
			? gitWorkspaceTarget(narratorId, workspaceQuery.data)
			: null,
	);
	const { data: chapterStatus } = useChapterGitStatus(narratorId ? null : chapterId);
	const gitStatus = narratorId
		? workspaceStatus
			? { ...workspaceStatus, commitsAhead: 0, baseBranch: "" }
			: undefined
		: chapterStatus;
	// Git lives in the dockview surface (right side), not in a collapse below this
	// bar. The prop wins because the caller knows the mobile Drawer host; the raw
	// dock context is only a fallback for surfaces that render the bar standalone.
	const dock = useNarratorDockContext();
	const openGitPanel = onOpenGitPanel ?? (dock ? () => dock.openToolPanel("git") : undefined);
	const containerCapability = useChapterContainersCapability();
	const containerUnsupportedReason =
		containerCapability.reason ?? tn("chapterBar.containersUnsupported");
	const { data: containers } = useContainers(
		containerCapability.supported && containerCapability.routes.list ? chapterId : "",
	);
	const qc = useQueryClient();
	const dormantChapter = useMutation({
		mutationFn: () => api.dormantChapter(chapterId),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["chapters", chapterId] }),
	});
	const wakeChapter = useMutation({
		mutationFn: () => api.wakeChapter(chapterId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["chapters", chapterId] });
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
		},
	});

	const [forkModalOpen, setForkModalOpen] = useState(false);
	const [mergeModalOpen, setMergeModalOpen] = useState(false);
	const [containerConfigOpen, setContainerConfigOpen] = useState(false);
	const [podmanInstallOpen, setPodmanInstallOpen] = useState(false);
	const [containerPanelOpen, setContainerPanelOpen] = useState(false);

	const handleContainerError = useCallback((err: Error) => {
		if ((err as ApiError).message?.includes("podman is not installed")) {
			setPodmanInstallOpen(true);
		}
	}, []);

	/**
	 * Open Git, unless this click was the end of a text selection.
	 *
	 * Readers copy the branch name out of this row, and a drag-select ends with a
	 * click on the same element — without this guard every copy attempt would also
	 * swap the side panel, and the selection would be lost to the re-render. A
	 * collapsed selection (a plain click) still opens the panel. The predicate lives
	 * in chapter-bar-git-trigger.ts, where it is tested directly.
	 */
	const handleGitTriggerClick = useCallback(
		(event: React.MouseEvent) => {
			if (!event.currentTarget.contains(event.target as Node)) return;
			if (isTextSelectionGesture(window.getSelection())) return;
			openGitPanel?.();
		},
		[openGitPanel],
	);

	// Keyboard equivalent for the role="button" row. Space is prevented so the
	// conversation behind it does not scroll instead.
	const handleGitTriggerKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (!e.currentTarget.contains(e.target as Node)) return;
			if (!isActivationKey(e.key)) return;
			e.preventDefault();
			openGitPanel?.();
		},
		[openGitPanel],
	);

	if (!chapter) return null;

	// biome-ignore lint/suspicious/noExplicitAny: dynamic container entity
	const runningContainers = containers?.filter((c: any) => c.status === "running") ?? [];
	const hasContainers = !!chapter.containerConfig;
	const containerSource = tn("worktree.legacyContainerSource", {
		title: chapter.title,
		chapterId,
		path: chapter.worktreePath || tn("worktree.legacyPathUnavailable"),
	});
	const containerTargetDescription = `${containerSource}\n${tn("worktree.legacyContainerWarning")}`;

	return (
		<>
			<Group
				px="md"
				py={4}
				gap="xs"
				justify="space-between"
				wrap="nowrap"
				style={{
					borderBottom: "1px solid var(--mantine-color-default-border)",
					flexShrink: 0,
					backgroundColor: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-7))",
				}}
			>
				{/* Left: chapter info — the whole strip opens the Git view. Deliberately a
				    div with role="button" and not a real <button>: the UA stylesheet gives
				    buttons `user-select: none`, and readers copy the branch name out of
				    this row. `handleGitTriggerClick` is what keeps both gestures on the
				    same element. */}
				<Group
					gap={6}
					wrap="nowrap"
					className={classes.gitTrigger}
					role={openGitPanel ? "button" : undefined}
					tabIndex={openGitPanel ? 0 : undefined}
					title={openGitPanel ? tn("chapterBar.git") : undefined}
					onClick={openGitPanel ? handleGitTriggerClick : undefined}
					onKeyDown={openGitPanel ? handleGitTriggerKeyDown : undefined}
				>
					<Text size="xs" fw={500} truncate>
						{chapter.title}
					</Text>
					<Text size="xs" c="dimmed">
						·
					</Text>
					<Text
						size="xs"
						c="dimmed"
						ff="monospace"
						truncate
						title={
							executionContext ? `${executionContext.deviceId}: ${executionContext.cwd}` : undefined
						}
					>
						{narratorId ? workspaceStatus?.branch || "Git" : chapter.branch}
					</Text>
					{gitStatus &&
						(gitStatus.commitsAhead > 0 ||
							gitStatus.linesAdded > 0 ||
							gitStatus.linesRemoved > 0) && (
							<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
								{gitStatus.commitsAhead > 0 && (
									<Tooltip
										label={tn("chapterBar.commitsAhead", {
											count: gitStatus.commitsAhead,
											base: gitStatus.baseBranch,
										})}
									>
										<Badge
											size="xs"
											variant="light"
											color="blue"
											leftSection={<IconGitCommit size={10} />}
										>
											{gitStatus.commitsAhead}
										</Badge>
									</Tooltip>
								)}
								{(gitStatus.linesAdded > 0 || gitStatus.linesRemoved > 0) && (
									<Tooltip label={tn("chapterBar.uncommittedLines")}>
										<Badge size="xs" variant="light" color="yellow">
											{gitStatus.linesAdded > 0 && (
												<Text span size="xs" c="green" fw={600}>
													+{gitStatus.linesAdded}
												</Text>
											)}
											{gitStatus.linesAdded > 0 && gitStatus.linesRemoved > 0 && " "}
											{gitStatus.linesRemoved > 0 && (
												<Text span size="xs" c="red" fw={600}>
													-{gitStatus.linesRemoved}
												</Text>
											)}
										</Badge>
									</Tooltip>
								)}
							</Group>
						)}
					{chapter.status !== "active" && (
						<Badge
							size="xs"
							variant="light"
							color={statusRegistry.chapterStatus(chapter.status).color}
						>
							{tc(statusRegistry.chapterStatus(chapter.status).i18nKey)}
						</Badge>
					)}
				</Group>

				{/* Right: action menus */}
				<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
					{narratorId && (
						<NarratorWorktreeControls
							key={narratorId}
							narratorId={narratorId}
							onRequirement={onRequirement}
						/>
					)}

					{/* Chapter settings menu */}
					<Menu position="top-end" withinPortal>
						<Menu.Target>
							<Tooltip label={tn("worktree.legacyResources")}>
								<ActionIcon
									variant="subtle"
									color="gray"
									size="sm"
									aria-label={tn("worktree.legacyResources")}
								>
									<IconSettings size={15} />
								</ActionIcon>
							</Tooltip>
						</Menu.Target>
						<Menu.Dropdown>
							<Menu.Label>{tn("worktree.legacyResources")}</Menu.Label>
							<Menu.Label style={{ maxWidth: 320, whiteSpace: "normal", overflowWrap: "anywhere" }}>
								{containerSource}
							</Menu.Label>
							<Menu.Item
								leftSection={<IconPackage size={14} />}
								disabled={!containerCapability.supported}
								title={
									!containerCapability.supported
										? containerUnsupportedReason
										: containerTargetDescription
								}
								rightSection={
									runningContainers.length ? (
										<Badge size="xs" color="green">
											{runningContainers.length}
										</Badge>
									) : undefined
								}
								onClick={() => {
									if (!containerCapability.supported) return;
									if (hasContainers) setContainerPanelOpen(true);
									else setContainerConfigOpen(true);
								}}
							>
								{tn("chapterBar.containers")}
							</Menu.Item>
							<Menu.Item
								leftSection={<IconSettings size={14} />}
								disabled={!containerCapability.supported}
								title={containerTargetDescription}
								onClick={() => {
									if (containerCapability.supported) setContainerConfigOpen(true);
								}}
							>
								{tn("worktree.legacyContainerConfigure")}
							</Menu.Item>
							<Menu.Divider />
							<Menu.Item
								leftSection={<IconGitFork size={14} />}
								onClick={() => setForkModalOpen(true)}
							>
								{t("fork")}
							</Menu.Item>
							<Menu.Item
								leftSection={<IconGitMerge size={14} />}
								onClick={() => setMergeModalOpen(true)}
							>
								{t("merge")}
							</Menu.Item>
							<Menu.Divider />
							{chapter.status === "active" && (
								<Menu.Item
									leftSection={<IconMoon size={14} />}
									onClick={() => dormantChapter.mutate()}
								>
									{t("dormant")}
								</Menu.Item>
							)}
							{chapter.status === "dormant" && (
								<Menu.Item leftSection={<IconSun size={14} />} onClick={() => wakeChapter.mutate()}>
									{t("wake")}
								</Menu.Item>
							)}
							<Suspense fallback={null}>
								<NarratorCompatibilityEntry projectId={chapter.projectId} />
							</Suspense>
						</Menu.Dropdown>
					</Menu>
				</Group>
			</Group>

			{/* Existing chapter resources are intentionally separate from the current workspace Git row. */}
			<Drawer
				opened={containerCapability.supported && containerPanelOpen && hasContainers}
				onClose={() => setContainerPanelOpen(false)}
				position="right"
				size="lg"
				title={tn("worktree.legacyContainerTitle")}
			>
				<Stack gap="xs">
					<Text size="sm" fw={600} c="orange" style={{ overflowWrap: "anywhere" }}>
						{containerSource}
					</Text>
					<Text size="xs" c="dimmed">
						{tn("worktree.legacyContainerWarning")}
					</Text>
					{containerPanelOpen && containerCapability.supported && hasContainers && (
						<Suspense fallback={null}>
							<ContainerPanel
								chapterId={chapterId}
								onOpenConfig={() => setContainerConfigOpen(true)}
								onContainerError={handleContainerError}
							/>
						</Suspense>
					)}
				</Stack>
			</Drawer>

			{/* Modals */}
			{forkModalOpen && (
				<Suspense fallback={null}>
					<ChapterForkModal
						chapterId={chapterId}
						chapterStatus={chapter.status}
						opened={forkModalOpen}
						onClose={() => setForkModalOpen(false)}
					/>
				</Suspense>
			)}
			{mergeModalOpen && (
				<Suspense fallback={null}>
					<ChapterMergeModal
						chapterId={chapterId}
						projectId={chapter.projectId}
						opened={mergeModalOpen}
						onClose={() => setMergeModalOpen(false)}
					/>
				</Suspense>
			)}
			{containerCapability.supported && containerConfigOpen && (
				<Suspense fallback={null}>
					<ContainerConfigModal
						chapterId={chapterId}
						currentConfig={chapter.containerConfig}
						targetDescription={containerTargetDescription}
						opened={containerConfigOpen}
						onClose={() => setContainerConfigOpen(false)}
					/>
				</Suspense>
			)}
			{containerCapability.supported && podmanInstallOpen && (
				<Suspense fallback={null}>
					<PodmanInstallModal
						opened={podmanInstallOpen}
						onClose={() => setPodmanInstallOpen(false)}
					/>
				</Suspense>
			)}
		</>
	);
}
