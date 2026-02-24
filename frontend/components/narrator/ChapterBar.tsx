import { ChapterForkModal } from "@frontend/components/chapter/ChapterForkModal";
import { ChapterMergeModal } from "@frontend/components/chapter/ChapterMergeModal";
import { ContainerLogs } from "@frontend/components/container/ContainerLogs";
import { useChapterGitStatus } from "@frontend/hooks/useChapterGitStatus";
import { useChapter, useUpdateChapter } from "@frontend/hooks/useChapters";
import {
	useContainers,
	useStartContainers,
	useStopContainers,
} from "@frontend/hooks/useContainers";
import { api } from "@frontend/lib/api";
import { CHAPTER_ROLE_ICONS } from "@frontend/lib/constants";
import { ActionIcon, Badge, Collapse, Group, Menu, Text, Tooltip } from "@mantine/core";
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
import { useState } from "react";
import { useTranslation } from "react-i18next";

interface ChapterBarProps {
	chapterId: string;
}

export function ChapterBar({ chapterId }: ChapterBarProps) {
	const { t } = useTranslation("chapters");
	const { t: tn } = useTranslation("narrator");
	const navigate = useNavigate();
	const { data: chapter } = useChapter(chapterId);
	const { data: gitStatus } = useChapterGitStatus(chapterId);
	const { data: containers } = useContainers(chapterId);
	const qc = useQueryClient();
	const updateChapter = useUpdateChapter();
	const startContainers = useStartContainers();
	const stopContainers = useStopContainers();
	const dormantChapter = useMutation({
		mutationFn: () => api.dormantChapter(chapterId),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["chapters", chapterId] }),
	});
	const wakeChapter = useMutation({
		mutationFn: () => api.wakeChapter(chapterId),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["chapters", chapterId] }),
	});

	const [forkModalOpen, setForkModalOpen] = useState(false);
	const [mergeModalOpen, setMergeModalOpen] = useState(false);
	const [logsOpen, setLogsOpen] = useState(false);

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
					backgroundColor: "var(--mantine-color-dark-7)",
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
						<Badge size="xs" variant="light" color={chapter.status === "frozen" ? "blue" : "gray"}>
							{chapter.status}
						</Badge>
					)}
				</Group>

				{/* Right: action menus */}
				<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
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

					{/* Container menu */}
					{hasContainers && (
						<Menu position="top-end" withinPortal>
							<Menu.Target>
								<Tooltip label={tn("chapterBar.containers")}>
									<ActionIcon
										variant="subtle"
										color={runningContainers.length > 0 ? "green" : "gray"}
										size="sm"
									>
										<IconPackage size={15} />
									</ActionIcon>
								</Tooltip>
							</Menu.Target>
							<Menu.Dropdown>
								<Menu.Label>
									{runningContainers.length > 0
										? tn("chapterBar.containersRunning", {
												count: runningContainers.length,
											})
										: tn("chapterBar.noContainersRunning")}
								</Menu.Label>
								<Menu.Divider />
								<Menu.Item onClick={() => startContainers.mutate(chapterId)}>
									{tn("chapterBar.startContainers")}
								</Menu.Item>
								<Menu.Item onClick={() => stopContainers.mutate(chapterId)}>
									{tn("chapterBar.stopContainers")}
								</Menu.Item>
								<Menu.Divider />
								<Menu.Item onClick={() => setLogsOpen(!logsOpen)}>
									{tn("chapterBar.viewLogs")}
								</Menu.Item>
							</Menu.Dropdown>
						</Menu>
					)}

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
							<Menu.Label>{tn("chapterBar.setRole")}</Menu.Label>
							{(["trunk", "branch", "exploration"] as const).map((role) => (
								<Menu.Item
									key={role}
									disabled={chapter.role === role}
									onClick={() => updateChapter.mutate({ id: chapterId, data: { role } })}
								>
									{CHAPTER_ROLE_ICONS[role]} {t(`role.${role}`)}
								</Menu.Item>
							))}
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

			{/* Container logs collapse */}
			<Collapse in={logsOpen}>
				<div
					style={{
						maxHeight: 200,
						overflow: "auto",
						borderBottom: "1px solid var(--mantine-color-default-border)",
					}}
				>
					<ContainerLogs chapterId={chapterId} />
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
		</>
	);
}
