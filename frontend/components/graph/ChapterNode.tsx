import { Badge, Card, Group, Text } from "@mantine/core";
import { IconGitCommit } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { CHAPTER_ROLE_ICONS, CHAPTER_STATUS_COLORS } from "../../lib/constants";

interface ChapterNodeData {
	title: string;
	status: string;
	branch: string;
	narratorCount: number;
	hasContainers: boolean;
	role?: string;
	color?: string;
	hasUpstreamUpdates?: boolean;
	isRoot?: boolean;
	commitCount?: number;
	[key: string]: unknown;
}

export function ChapterNode({ data, id }: NodeProps) {
	const d = data as ChapterNodeData;
	const navigate = useNavigate();
	const { t } = useTranslation("graph");

	const role = d.role ?? "branch";
	const isRoot = !!d.isRoot;
	const isTrunk = role === "trunk";
	const isFrozen = d.status === "frozen";
	const roleIcon = isRoot ? "📂" : CHAPTER_ROLE_ICONS[role] || "";
	const borderColor = isRoot
		? "var(--mantine-color-indigo-6)"
		: (d.color ?? `var(--mantine-color-${CHAPTER_STATUS_COLORS[d.status] ?? "gray"}-4)`);
	const nodeWidth = isRoot ? 320 : isTrunk ? 320 : 280;
	const nodeHeight = isRoot ? 140 : isTrunk ? 140 : 120;

	return (
		<>
			<Handle type="target" position={Position.Top} />
			<Card
				shadow="sm"
				padding="xs"
				radius="md"
				withBorder
				style={{
					width: nodeWidth,
					height: nodeHeight,
					cursor: "pointer",
					borderColor,
					borderWidth: isRoot ? 2 : 1,
					opacity: isFrozen ? 0.6 : 1,
					position: "relative",
				}}
				onClick={() => navigate({ to: "/chapters/$chapterId", params: { chapterId: id } })}
			>
				{d.hasUpstreamUpdates && (
					<div
						style={{
							position: "absolute",
							top: 6,
							right: 6,
							width: 8,
							height: 8,
							borderRadius: "50%",
							backgroundColor: "#fd7e14",
						}}
					/>
				)}
				<Group justify="space-between" mb={4}>
					<Text size="sm" fw={600} lineClamp={1} style={{ maxWidth: nodeWidth - 80 }}>
						{roleIcon ? `${roleIcon} ` : ""}
						{d.title}
					</Text>
					<Badge size="xs" color={CHAPTER_STATUS_COLORS[d.status] ?? "gray"}>
						{d.status}
					</Badge>
				</Group>
				<Text size="xs" c="dimmed" lineClamp={1}>
					{d.branch}
				</Text>
				<Group gap={8} mt={4}>
					{isRoot && (
						<Badge size="xs" variant="filled" color="indigo">
							{t("root")}
						</Badge>
					)}
					{!isRoot && role !== "branch" && (
						<Badge size="xs" variant="outline" color="indigo">
							{role}
						</Badge>
					)}
					<Text size="xs" c="dimmed">
						{t("narratorCount", { count: d.narratorCount })}
					</Text>
					{d.hasContainers && (
						<Badge size="xs" variant="dot" color="teal">
							{t("containers")}
						</Badge>
					)}
					{(d.commitCount ?? 0) > 0 && (
						<Group gap={2}>
							<IconGitCommit size={12} color="var(--mantine-color-dimmed)" />
							<Text size="xs" c="dimmed">
								{d.commitCount}
							</Text>
						</Group>
					)}
				</Group>
			</Card>
			<Handle type="source" position={Position.Bottom} />
		</>
	);
}
