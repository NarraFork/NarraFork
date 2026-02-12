import { Badge, Box, Button, Code, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { NarratorPanel } from "../../components/narrator/NarratorPanel";
import { useChapter } from "../../hooks/useChapters";
import { useCreateNarrator, useNarrators } from "../../hooks/useNarrator";
import { CHAPTER_STATUS_COLORS } from "../../lib/constants";

export const Route = createFileRoute("/chapters/$chapterId")({
	component: ChapterDetailPage,
});

function ChapterDetailPage() {
	const { chapterId } = Route.useParams();
	const { data: chapter, isLoading } = useChapter(chapterId);
	const { data: narratorList, isLoading: narratorsLoading } = useNarrators(chapterId);
	const createNarrator = useCreateNarrator(chapterId);

	if (isLoading) return <Loader />;
	if (!chapter) return <Text>Chapter not found</Text>;

	const primaryNarrator = narratorList?.find((n: any) => n.type === "primary");

	return (
		<Stack h="calc(100vh - 80px)">
			{/* Chapter info header */}
			<Box>
				<Group>
					<Title order={2}>{chapter.title}</Title>
					<Badge color={chapter.type === "meanwhile" ? "indigo" : "orange"}>{chapter.type}</Badge>
					<Badge color={CHAPTER_STATUS_COLORS[chapter.status] ?? "gray"}>{chapter.status}</Badge>
				</Group>

				{chapter.description && <Text c="dimmed">{chapter.description}</Text>}

				<Paper withBorder p="sm" mt="xs">
					<Group gap="lg">
						<Group gap={4}>
							<Text size="xs" fw={500}>
								Branch:
							</Text>
							<Code style={{ fontSize: 11 }}>{chapter.branch}</Code>
						</Group>
						<Group gap={4}>
							<Text size="xs" fw={500}>
								Base:
							</Text>
							<Code style={{ fontSize: 11 }}>{chapter.baseBranch}</Code>
						</Group>
					</Group>
				</Paper>
			</Box>

			{/* Narrator panel */}
			<Box flex={1} style={{ minHeight: 0 }}>
				{narratorsLoading ? (
					<Loader />
				) : primaryNarrator ? (
					<NarratorPanel narratorId={primaryNarrator.id} narrator={primaryNarrator} />
				) : (
					<Paper withBorder p="xl" h="100%">
						<Stack align="center" justify="center" h="100%">
							<Text c="dimmed">No narrator yet for this chapter.</Text>
							<Button onClick={() => createNarrator.mutate({})} loading={createNarrator.isPending}>
								Start Narrator
							</Button>
						</Stack>
					</Paper>
				)}
			</Box>
		</Stack>
	);
}
