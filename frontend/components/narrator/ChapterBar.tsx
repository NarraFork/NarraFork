import { ChapterForkModal } from "@frontend/components/chapter/ChapterForkModal";
import { ChapterMergeModal } from "@frontend/components/chapter/ChapterMergeModal";
import { GitPanel } from "@frontend/components/chapter/GitPanel";
import { ContainerConfigModal } from "@frontend/components/container/ContainerConfigModal";
import { ContainerPanel } from "@frontend/components/container/ContainerPanel";
import { PodmanInstallModal } from "@frontend/components/container/PodmanInstallModal";
import { useChapterGitStatus } from "@frontend/hooks/useChapterGitStatus";
import { useChapter, useUpdateChapter } from "@frontend/hooks/useChapters";
import { useContainers } from "@frontend/hooks/useContainers";
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
	IconSourceCode,
	IconSun,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

interface ChapterBarProps {
	chapterId: string;
}

export function ChapterBar({ chapterId }: ChapterBarProps) {
	const { t } = useTranslation("chapters");
	const { t: tn } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const navigate = useNavigate();
	const { data: chapter } = useChapter(chapterId);
	const { data: gitStatus } = useChapterGitStatus(chapterId);
	const { data: containers } = useContainers(chapterId);
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
	const [gitPanelOpen, setGitPanelOpen] = useState(false);

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
				{/* Left: chapter info */}
				<Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
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
							<UnstyledButton onClick={() => setGitPanelOpen(!gitPanelOpen)}>
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
							</UnstyledButton>
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
					{/* Git panel toggle */}
					{chapter.status === "active" && (
						<Tooltip label={tn("chapterBar.git")}>
							<ActionIcon
								variant={gitPanelOpen ? "light" : "subtle"}
								color={gitPanelOpen ? "indigo" : "gray"}
								size="sm"
								onClick={() => setGitPanelOpen(!gitPanelOpen)}
							>
								<IconSourceCode size={15} />
							</ActionIcon>
						</Tooltip>
					)}

					{/* Git menu */}
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
					<Tooltip label={tn("chapterBar.containers")}>
						<ActionIcon
							variant={containerPanelOpen ? "light" : "subtle"}
							color={runningContainers.length > 0 ? "green" : "gray"}
							size="sm"
							onClick={() => {
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
			<Collapse in={containerPanelOpen && hasContainers}>
				<div
					style={{
						borderBottom: "1px solid var(--mantine-color-default-border)",
					}}
				>
					<ContainerPanel
						chapterId={chapterId}
						onOpenConfig={() => setContainerConfigOpen(true)}
						onContainerError={handleContainerError}
					/>
				</div>
			</Collapse>

			{/* Git panel collapse */}
			<Collapse in={gitPanelOpen}>
				<div
					style={{
						borderBottom: "1px solid var(--mantine-color-default-border)",
					}}
				>
					<GitPanel chapterId={chapterId} />
				</div>
			</Collapse>

			{/* Modals */}
			<ChapterForkModal
				chapterId={chapterId}
				opened={forkModalOpen}
				onClose={() => setForkModalOpen(false)}
			/>
			<ChapterMergeModal
				chapterId={chapterId}
				projectId={chapter.projectId}
				opened={mergeModalOpen}
				onClose={() => setMergeModalOpen(false)}
			/>
			<ContainerConfigModal
				chapterId={chapterId}
				currentConfig={chapter.containerConfig}
				opened={containerConfigOpen}
				onClose={() => setContainerConfigOpen(false)}
			/>
			<PodmanInstallModal opened={podmanInstallOpen} onClose={() => setPodmanInstallOpen(false)} />
		</>
	);
}
