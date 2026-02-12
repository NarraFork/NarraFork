import { Badge, Card, Code, Group, Text } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { CHAPTER_STATUS_COLORS } from "../../lib/constants";

interface ChapterCardProps {
	chapter: {
		id: string;
		title: string;
		type: string;
		status: string;
		branch: string;
		createdAt: string;
	};
}

export function ChapterCard({ chapter }: ChapterCardProps) {
	return (
		<Card
			shadow="sm"
			padding="lg"
			radius="md"
			withBorder
			component={Link}
			to="/chapters/$chapterId"
			params={{ chapterId: chapter.id } as any}
			style={{ textDecoration: "none" }}
		>
			<Group justify="space-between" mb="xs">
				<Text fw={500}>{chapter.title}</Text>
				<Group gap="xs">
					<Badge size="sm" color={chapter.type === "meanwhile" ? "indigo" : "orange"}>
						{chapter.type}
					</Badge>
					<Badge size="sm" color={CHAPTER_STATUS_COLORS[chapter.status] ?? "gray"}>
						{chapter.status}
					</Badge>
				</Group>
			</Group>
			<Code>{chapter.branch}</Code>
		</Card>
	);
}
