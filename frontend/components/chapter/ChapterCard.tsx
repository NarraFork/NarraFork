import { Badge, Button, Card, Code, Group, Text } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { CHAPTER_STATUS_COLORS } from "../../lib/constants";

interface ChapterCardProps {
	chapter: {
		id: string;
		projectId: string;
		title: string;
		status: string;
		branch: string;
		createdAt: string;
	};
}

export function ChapterCard({ chapter }: ChapterCardProps) {
	const { t } = useTranslation("chapters");
	const qc = useQueryClient();

	const dormant = useMutation({
		mutationFn: () => api.dormantChapter(chapter.id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["chapters"] }),
	});

	const wake = useMutation({
		mutationFn: () => api.wakeChapter(chapter.id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["chapters"] }),
	});

	return (
		<Card shadow="sm" padding="lg" radius="md" withBorder>
			<Card.Section
				component={Link}
				to="/chapters/$chapterId"
				params={{ chapterId: chapter.id } as any}
				inheritPadding
				py="sm"
				style={{ textDecoration: "none" }}
			>
				<Group justify="space-between" mb="xs">
					<Text fw={500}>{chapter.title}</Text>
					<Badge size="sm" color={CHAPTER_STATUS_COLORS[chapter.status] ?? "gray"}>
						{chapter.status}
					</Badge>
				</Group>
				<Code>{chapter.branch}</Code>
			</Card.Section>

			{(chapter.status === "active" || chapter.status === "dormant") && (
				<Group mt="xs" gap="xs">
					{chapter.status === "active" && (
						<Button
							size="compact-xs"
							variant="light"
							color="yellow"
							onClick={(e) => {
								e.preventDefault();
								dormant.mutate();
							}}
							loading={dormant.isPending}
						>
							{t("dormant")}
						</Button>
					)}
					{chapter.status === "dormant" && (
						<Button
							size="compact-xs"
							variant="light"
							color="green"
							onClick={(e) => {
								e.preventDefault();
								wake.mutate();
							}}
							loading={wake.isPending}
						>
							{t("wake")}
						</Button>
					)}
				</Group>
			)}
		</Card>
	);
}
