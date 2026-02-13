import { Badge, Box, Button, Code, Collapse, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { ChapterForkModal } from "../../components/chapter/ChapterForkModal";
import { ChapterMergeModal } from "../../components/chapter/ChapterMergeModal";
import { ContainerLogs } from "../../components/container/ContainerLogs";
import { ContainerStatus } from "../../components/container/ContainerStatus";
import { NarratorPanel } from "../../components/narrator/NarratorPanel";
import { TerminalTabs } from "../../components/terminal/TerminalTabs";
import { useChapter } from "../../hooks/useChapters";
import { useCreateNarrator, useNarrators } from "../../hooks/useNarrator";
import { CHAPTER_STATUS_COLORS } from "../../lib/constants";

export const Route = createFileRoute("/chapters/$chapterId")({
	component: ChapterDetailPage,
});

const MIN_PANEL_HEIGHT = 100;
const DEFAULT_TERMINAL_HEIGHT = 300;

function ChapterDetailPage() {
	const { chapterId } = Route.useParams();
	const { data: chapter, isLoading } = useChapter(chapterId);
	const { data: narratorList, isLoading: narratorsLoading } = useNarrators(chapterId);
	const createNarrator = useCreateNarrator(chapterId);

	const [terminalHeight, setTerminalHeight] = useState(DEFAULT_TERMINAL_HEIGHT);
	const containerRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);
	const [forkOpened, { open: openFork, close: closeFork }] = useDisclosure(false);
	const [mergeOpened, { open: openMerge, close: closeMerge }] = useDisclosure(false);
	const [containersOpen, { toggle: toggleContainers }] = useDisclosure(false);
	const [forkAtMessageUuid, setForkAtMessageUuid] = useState<string | undefined>();

	const handleForkFromMessage = useCallback((sdkMessageUuid: string) => {
		setForkAtMessageUuid(sdkMessageUuid);
		openFork();
	}, [openFork]);

	const handleForkClose = useCallback(() => {
		setForkAtMessageUuid(undefined);
		closeFork();
	}, [closeFork]);

	const onDragStart = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		dragging.current = true;

		const onMouseMove = (ev: MouseEvent) => {
			if (!dragging.current || !containerRef.current) return;
			const containerRect = containerRef.current.getBoundingClientRect();
			const newTerminalHeight = containerRect.bottom - ev.clientY;
			const maxHeight = containerRect.height - MIN_PANEL_HEIGHT;
			setTerminalHeight(Math.max(MIN_PANEL_HEIGHT, Math.min(maxHeight, newTerminalHeight)));
		};

		const onMouseUp = () => {
			dragging.current = false;
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};

		document.body.style.cursor = "row-resize";
		document.body.style.userSelect = "none";
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
	}, []);

	if (isLoading) return <Loader />;
	if (!chapter) return <Text>Chapter not found</Text>;

	const primaryNarrator = narratorList?.find((n: any) => n.type === "primary");

	return (
		<Box
			ref={containerRef}
			h="calc(100vh - 80px)"
			style={{ display: "flex", flexDirection: "column" }}
		>
			{/* Chapter info header */}
			<Box p="xs">
				<Group justify="space-between">
					<Group>
						<Title order={2}>{chapter.title}</Title>
						<Badge color={chapter.type === "meanwhile" ? "indigo" : "orange"}>{chapter.type}</Badge>
						<Badge color={CHAPTER_STATUS_COLORS[chapter.status] ?? "gray"}>{chapter.status}</Badge>
					</Group>
					{chapter.status === "active" && (
						<Group gap="xs">
							<Button size="xs" variant="light" onClick={openFork}>
								Fork
							</Button>
							<Button size="xs" variant="light" color="green" onClick={openMerge}>
								Merge
							</Button>
							<Button size="xs" variant="light" color="gray" onClick={toggleContainers}>
								Containers
							</Button>
						</Group>
					)}
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

				<Collapse in={containersOpen}>
					<Paper withBorder p="sm" mt="xs">
						<ContainerStatus chapterId={chapterId} />
						<ContainerLogs chapterId={chapterId} />
					</Paper>
				</Collapse>
			</Box>

			{/* Narrator panel */}
			<Box style={{ flex: 1, minHeight: MIN_PANEL_HEIGHT, overflow: "hidden" }}>
				{narratorsLoading ? (
					<Loader />
				) : primaryNarrator ? (
					<NarratorPanel
						narratorId={primaryNarrator.id}
						narrator={primaryNarrator}
						onForkFromMessage={handleForkFromMessage}
					/>
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

			{/* Drag handle */}
			<Box
				onMouseDown={onDragStart}
				style={{
					height: 6,
					cursor: "row-resize",
					backgroundColor: "var(--mantine-color-gray-3)",
					flexShrink: 0,
					transition: "background-color 0.15s",
				}}
				onMouseEnter={(e) => {
					e.currentTarget.style.backgroundColor = "var(--mantine-color-blue-4)";
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.backgroundColor = "var(--mantine-color-gray-3)";
				}}
			/>

			{/* Terminal area */}
			<Box
				style={{
					height: terminalHeight,
					flexShrink: 0,
					overflow: "hidden",
				}}
			>
				<TerminalTabs chapterId={chapterId} />
			</Box>

			<ChapterForkModal
				chapterId={chapterId}
				opened={forkOpened}
				onClose={handleForkClose}
				forkAtMessageUuid={forkAtMessageUuid}
			/>
			<ChapterMergeModal
				chapterId={chapterId}
				projectId={chapter.projectId}
				opened={mergeOpened}
				onClose={closeMerge}
			/>
		</Box>
	);
}
