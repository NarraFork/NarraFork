import { Badge, Card, Group, Text } from "@mantine/core";
import { IconGitCommit } from "@tabler/icons-react";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { CHAPTER_ROLE_ICONS, CHAPTER_STATUS_COLORS, statusRegistry } from "../../lib/constants";

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

export function ChapterNode({ data }: NodeProps) {
	const d = data as ChapterNodeData;
	const { t } = useTranslation("graph");
	const { t: tc } = useTranslation("common");

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

	const handleStyle = { opacity: 0, width: 8, height: 8 };

	return (
		<>
			<Handle type="target" position={Position.Top} id="top" style={handleStyle} />
			<Handle type="source" position={Position.Top} id="top-src" style={handleStyle} />
			<Handle type="target" position={Position.Bottom} id="bottom" style={handleStyle} />
			<Handle type="source" position={Position.Bottom} id="bottom-src" style={handleStyle} />
			<Handle type="target" position={Position.Left} id="left" style={handleStyle} />
			<Handle type="source" position={Position.Left} id="left-src" style={handleStyle} />
			<Handle type="target" position={Position.Right} id="right" style={handleStyle} />
			<Handle type="source" position={Position.Right} id="right-src" style={handleStyle} />
			<Card
				shadow="sm"
				padding="xs"
				radius="md"
				withBorder
				style={{
					width: nodeWidth,
					height: nodeHeight,
					cursor: "grab",
					borderColor,
					borderWidth: isRoot ? 2 : 1,
					opacity: isFrozen ? 0.6 : 1,
					position: "relative",
				}}
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
							backgroundColor: statusRegistry.edgeType("dependency").color,
						}}
					/>
				)}
				<Group justify="space-between" mb={4}>
					<Text size="sm" fw={600} lineClamp={1} style={{ maxWidth: nodeWidth - 80 }}>
						{roleIcon ? `${roleIcon} ` : ""}
						{d.title}
					</Text>
					<Badge size="xs" color={CHAPTER_STATUS_COLORS[d.status] ?? "gray"}>
						{tc(statusRegistry.chapterStatus(d.status).i18nKey)}
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
		</>
	);
}
