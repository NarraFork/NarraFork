import { CommitDetailModal } from "@frontend/components/chapter/CommitDetailModal";
import { CommitList } from "@frontend/components/chapter/CommitList";
import { useChapterCommits } from "@frontend/hooks/useChapterCommits";
import { CHAPTER_ROLE_ICONS } from "@frontend/lib/constants";
import { ActionIcon, Badge, Divider, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconChevronRight, IconExternalLink } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

interface GraphSidePanelProps {
	selectedNode: {
		id: string;
		title: string;
		status: string;
		role: string;
		branch: string;
		narratorCount: number;
		hasContainers: boolean;
		hasUpstreamUpdates: boolean;
		commitCount?: number;
		headCommitSha?: string | null;
	} | null;
	onClose: () => void;
}

export function GraphSidePanel({ selectedNode, onClose }: GraphSidePanelProps) {
	const { t } = useTranslation("graph");
	const { data: commits } = useChapterCommits(selectedNode?.id, { limit: 8 });
	const [detailOpened, { open: openDetail, close: closeDetail }] = useDisclosure(false);
	const [selectedSha, setSelectedSha] = useState<string | null>(null);

	const handleCommitClick = useCallback(
		(sha: string) => {
			setSelectedSha(sha);
			openDetail();
		},
		[openDetail],
	);

	if (!selectedNode) return null;

	const roleIcon = CHAPTER_ROLE_ICONS[selectedNode.role] || "";

	return (
		<>
			<Paper
				w={320}
				h="100%"
				p="md"
				withBorder
				style={{
					borderLeft: "1px solid var(--mantine-color-dark-4)",
					overflow: "auto",
				}}
			>
				<Group justify="space-between" mb="md">
					<Title order={5}>
						{roleIcon} {selectedNode.title}
					</Title>
					<ActionIcon variant="subtle" onClick={onClose}>
						<IconChevronRight size={16} />
					</ActionIcon>
				</Group>

				<Stack gap="xs">
					<Group gap="xs">
						<Badge size="sm" variant="light">
							{selectedNode.status}
						</Badge>
						<Badge size="sm" variant="outline">
							{selectedNode.role}
						</Badge>
						{selectedNode.hasUpstreamUpdates && (
							<Badge size="sm" color="orange">
								{t("sidePanel.upstreamUpdates")}
							</Badge>
						)}
					</Group>

					<Text size="sm" c="dimmed">
						{selectedNode.branch}
					</Text>

					{selectedNode.commitCount != null && selectedNode.commitCount > 0 && (
						<Text size="xs" c="dimmed">
							{t("sidePanel.commitSummary", { count: selectedNode.commitCount })}
							{selectedNode.headCommitSha && (
								<>
									{` · ${t("sidePanel.headLabel")} `}
									<Text span ff="monospace" size="xs">
										{selectedNode.headCommitSha.slice(0, 7)}
									</Text>
								</>
							)}
						</Text>
					)}

					<Divider />

					<Text size="sm" fw={500}>
						{t("sidePanel.recentCommits")}
					</Text>
					<CommitList commits={commits ?? []} maxItems={8} onCommitClick={handleCommitClick} />

					<Divider />

					<Link to="/chapters/$chapterId" params={{ chapterId: selectedNode.id }}>
						<Group gap={4}>
							<Text size="sm">{t("sidePanel.openDetails")}</Text>
							<IconExternalLink size={14} />
						</Group>
					</Link>
				</Stack>
			</Paper>

			<CommitDetailModal
				chapterId={selectedNode.id}
				commitSha={selectedSha}
				opened={detailOpened}
				onClose={closeDetail}
			/>
		</>
	);
}
