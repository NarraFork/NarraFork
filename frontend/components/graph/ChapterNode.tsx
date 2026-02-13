import { Badge, Card, Group, Text } from "@mantine/core";
import { IconGitBranch, IconQuestionMark } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { CHAPTER_STATUS_COLORS } from "../../lib/constants";

const CHAPTER_TYPE_ICON: Record<string, React.ReactNode> = {
	meanwhile: <IconGitBranch size={14} />,
	whatif: <IconQuestionMark size={14} />,
};

interface ChapterNodeData {
	title: string;
	chapterType: string;
	status: string;
	branch: string;
	narratorCount: number;
	hasContainers: boolean;
	[key: string]: unknown;
}

export function ChapterNode({ data, id }: NodeProps) {
	const d = data as ChapterNodeData;
	const navigate = useNavigate();
	const { t } = useTranslation("graph");

	return (
		<>
			<Handle type="target" position={Position.Top} />
			<Card
				shadow="sm"
				padding="xs"
				radius="md"
				withBorder
				style={{
					width: 280,
					height: 120,
					cursor: "pointer",
					borderColor: `var(--mantine-color-${CHAPTER_STATUS_COLORS[d.status] ?? "gray"}-4)`,
				}}
				onClick={() => navigate({ to: "/chapters/$chapterId", params: { chapterId: id } })}
			>
				<Group justify="space-between" mb={4}>
					<Group gap={6}>
						<Text size="xs" c="dimmed" fw={700}>
							{CHAPTER_TYPE_ICON[d.chapterType] ?? null}
						</Text>
						<Text size="sm" fw={600} lineClamp={1} style={{ maxWidth: 180 }}>
							{d.title}
						</Text>
					</Group>
					<Badge size="xs" color={CHAPTER_STATUS_COLORS[d.status] ?? "gray"}>
						{d.status}
					</Badge>
				</Group>
				<Text size="xs" c="dimmed" lineClamp={1}>
					{d.branch}
				</Text>
				<Group gap={8} mt={4}>
					<Text size="xs" c="dimmed">
						{t("narratorCount", { count: d.narratorCount })}
					</Text>
					{d.hasContainers && (
						<Badge size="xs" variant="dot" color="teal">
							{t("containers")}
						</Badge>
					)}
				</Group>
			</Card>
			<Handle type="source" position={Position.Bottom} />
		</>
	);
}
