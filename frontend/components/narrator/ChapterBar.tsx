import { useChapterGitStatus } from "@frontend/hooks/useChapterGitStatus";
import { useChapter, useUpdateChapter } from "@frontend/hooks/useChapters";
import { useContainers } from "@frontend/hooks/useContainers";
import { useChapterContainersCapability } from "@frontend/hooks/usePlatform";
import { type ApiError, api } from "@frontend/lib/api";
import { CHAPTER_ROLE_ICONS, statusRegistry } from "@frontend/lib/constants";
import {
	ActionIcon,
	Badge,
	Collapse,
	Group,
	Menu,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconGitCommit,
	IconGitFork,
	IconGitMerge,
	IconGraph,
	IconMoon,
	IconPackage,
	IconSettings,
	IconSun,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import classes from "./ChapterBar.module.css";
import { useNarratorDockContext } from "./dock/NarratorDockContext";

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

interface ChapterBarProps {
	chapterId: string;
	/**
	 * Open the Git view for this chapter. NarratorPanel routes the gesture: dock
	 * panel when a dock surface exists, the mobile Drawer host otherwise. The raw
	 * dock context below is only a fallback for surfaces that render this bar
	 * without the panel around it.
	 */
	onOpenGitPanel?: () => void;
}

export function ChapterBar({ chapterId, onOpenGitPanel }: ChapterBarProps) {
	const { t } = useTranslation("chapters");
	const { t: tn } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const navigate = useNavigate();
	const { data: chapter } = useChapter(chapterId);
	const { data: gitStatus } = useChapterGitStatus(chapterId);
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
	const updateChapter = useUpdateChapter();
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

	if (!chapter) return null;

	const roleIcon = CHAPTER_ROLE_ICONS[chapter.role] || "";
	// biome-ignore lint/suspicious/noExplicitAny: dynamic container entity
	const runningContainers = containers?.filter((c: any) => c.status === "running") ?? [];
	const hasContainers = !!chapter.containerConfig;

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
				{/* Left: chapter info — the whole strip is the Git panel affordance, so it
				    is one button that stretches to the action icons. Cursor + hover tint
				    are what tell the reader this text is clickable at all; without them
				    the click target is invisible. */}
				<UnstyledButton
					onClick={openGitPanel}
					disabled={!openGitPanel}
					title={openGitPanel ? tn("chapterBar.git") : undefined}
					className={classes.gitTrigger}
				>
					<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
						{roleIcon && <Text size="xs">{roleIcon}</Text>}
						<Text size="xs" fw={500} truncate>
							{chapter.title}
						</Text>
						<Text size="xs" c="dimmed">
							·
						</Text>
						<Text size="xs" c="dimmed" ff="monospace" truncate>
							{chapter.branch}
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
				</UnstyledButton>

				{/* Right: action menus */}
				<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
					{/* Git fork/merge menu */}
					<Menu position="top-end" withinPortal>
						<Menu.Target>
							<Tooltip label={tn("chapterBar.git")}>
								<ActionIcon variant="subtle" color="gray" size="sm">
									<IconGitFork size={15} />
								</ActionIcon>
							</Tooltip>
						</Menu.Target>
						<Menu.Dropdown>
							<Menu.Label>{tn("chapterBar.git")}</Menu.Label>
							<Menu.Item
								leftSection={<IconGitFork size={14} />}
								onClick={() => setForkModalOpen(true)}
							>
								{t("fork")}
							</Menu.Item>
							<Menu.Divider />
							<Menu.Item
								leftSection={<IconGitMerge size={14} />}
								onClick={() => setMergeModalOpen(true)}
							>
								{t("merge")}
							</Menu.Item>
						</Menu.Dropdown>
					</Menu>

					{/* Container toggle + menu */}
					<Tooltip
						label={
							containerCapability.supported
								? tn("chapterBar.containers")
								: containerUnsupportedReason
						}
					>
						<ActionIcon
							variant={containerPanelOpen ? "light" : "subtle"}
							color={runningContainers.length > 0 ? "green" : "gray"}
							size="sm"
							disabled={!containerCapability.supported}
							onClick={() => {
								if (!containerCapability.supported) return;
								if (hasContainers) {
									setContainerPanelOpen(!containerPanelOpen);
								} else {
									setContainerConfigOpen(true);
								}
							}}
						>
							<IconPackage size={15} />
						</ActionIcon>
					</Tooltip>

					{/* Chapter settings menu */}
					<Menu position="top-end" withinPortal>
						<Menu.Target>
							<Tooltip label={tn("chapterBar.settings")}>
								<ActionIcon variant="subtle" color="gray" size="sm">
									<IconSettings size={15} />
								</ActionIcon>
							</Tooltip>
						</Menu.Target>
						<Menu.Dropdown>
							{!chapter.isRoot && (
								<>
									<Menu.Label>{tn("chapterBar.setRole")}</Menu.Label>
									{(["branch", "exploration"] as const).map((role) => (
										<Menu.Item
											key={role}
											disabled={chapter.role === role}
											onClick={() => updateChapter.mutate({ id: chapterId, data: { role } })}
										>
											{CHAPTER_ROLE_ICONS[role]} {t(`role.${role}`)}
										</Menu.Item>
									))}
									<Menu.Divider />
								</>
							)}
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
							<Menu.Item
								leftSection={<IconGraph size={14} />}
								onClick={() =>
									navigate({
										to: "/projects/$projectId",
										params: { projectId: chapter.projectId },
									})
								}
							>
								{tn("chapterBar.openInGraph")}
							</Menu.Item>
						</Menu.Dropdown>
					</Menu>
				</Group>
			</Group>

			{/* Container panel collapse */}
			<Collapse expanded={containerCapability.supported && containerPanelOpen && hasContainers}>
				<div
					style={{
						borderBottom: "1px solid var(--mantine-color-default-border)",
					}}
				>
					<Suspense fallback={null}>
						<ContainerPanel
							chapterId={chapterId}
							onOpenConfig={() => setContainerConfigOpen(true)}
							onContainerError={handleContainerError}
						/>
					</Suspense>
				</div>
			</Collapse>

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
