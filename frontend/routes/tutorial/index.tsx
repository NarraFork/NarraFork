/**
 * Tutorial overview — lessons grouped by track, with per-lesson progress.
 *
 * Lessons are individually startable on purpose: a user who only wants to
 * understand forking should not have to replay the conversation basics. The
 * "whole tour" button just enters the first lesson; `recommendedAfter` is surfaced
 * as a hint rather than a lock, so nothing here can strand someone.
 */

import {
	Alert,
	Badge,
	Box,
	Button,
	Card,
	Grid,
	Group,
	Loader,
	Paper,
	Progress,
	Stack,
	Text,
	ThemeIcon,
	Title,
} from "@mantine/core";
import {
	IconArrowRight,
	IconCheck,
	IconFolders,
	IconPlugConnectedX,
	IconSchool,
} from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
	useStartTutorialLesson,
	useTutorialIndex,
	useTutorialTracks,
} from "../../hooks/useTutorial";
import type { TutorialLessonSummary, TutorialTrack } from "../../lib/api/types";

export const Route = createFileRoute("/tutorial/")({
	component: TutorialOverviewPage,
});

function TutorialOverviewPage() {
	const { t } = useTranslation("tutorial");
	const navigate = useNavigate();
	const { data, isLoading } = useTutorialIndex();
	const tracks = useTutorialTracks();
	const startLesson = useStartTutorialLesson();

	const progress = data?.progress ?? {};
	const firstLessonId = tracks[0]?.lessons[0]?.id;

	const openLesson = (lessonId: string) => {
		void navigate({ to: "/tutorial/$lessonId", params: { lessonId } });
	};

	if (isLoading) return <Loader />;

	return (
		<Stack gap="md" className="nf-blur-in-enter">
			<Paper withBorder p="xl" radius="lg">
				<Group gap="md" align="flex-start" wrap="nowrap">
					<ThemeIcon variant="gradient" gradient={{ from: "indigo", to: "violet" }} size="xl">
						<IconSchool size={24} />
					</ThemeIcon>
					<Box maw={760} style={{ flex: 1 }}>
						<Group gap="sm" align="center">
							<Title order={1} lh={1.1}>
								{t("title")}
							</Title>
							{/* The one claim a user most needs to trust before clicking. */}
							<Badge variant="light" color="teal">
								{t("noApiBadge")}
							</Badge>
						</Group>
						<Text c="dimmed" mt="sm" size="lg">
							{t("subtitle")}
						</Text>
						{firstLessonId && (
							<Button
								mt="md"
								rightSection={<IconArrowRight size={14} />}
								onClick={() => openLesson(firstLessonId)}
							>
								{t("runAll")}
							</Button>
						)}
					</Box>
				</Group>
			</Paper>

			{tracks.length === 0 ? (
				<Text c="dimmed">{t("empty")}</Text>
			) : (
				tracks.map(({ track, lessons }) => (
					<TrackSection
						key={track}
						track={track}
						lessons={lessons}
						progress={progress}
						onOpen={openLesson}
						starting={startLesson.isPending}
					/>
				))
			)}

			<SandboxCard
				exists={data?.sandbox.exists ?? false}
				projectId={data?.sandbox.projectId ?? null}
			/>
		</Stack>
	);
}

function TrackSection({
	track,
	lessons,
	progress,
	onOpen,
	starting,
}: {
	track: TutorialTrack;
	lessons: TutorialLessonSummary[];
	progress: Record<string, { completedStepIds: string[]; completedAt?: string }>;
	onOpen: (lessonId: string) => void;
	starting: boolean;
}) {
	const { t } = useTranslation("tutorial");
	return (
		<Box>
			<Title order={3}>{t(`tracks.${track}`)}</Title>
			<Text c="dimmed" size="sm" mb="sm">
				{t(`trackDescriptions.${track}`)}
			</Text>
			<Grid gap="md">
				{lessons.map((lesson) => (
					<Grid.Col key={lesson.id} span={{ base: 12, sm: 6, lg: 4 }}>
						<LessonCard
							lesson={lesson}
							done={progress[lesson.id]?.completedStepIds ?? []}
							completedAt={progress[lesson.id]?.completedAt}
							onOpen={() => onOpen(lesson.id)}
							starting={starting}
						/>
					</Grid.Col>
				))}
			</Grid>
		</Box>
	);
}

function LessonCard({
	lesson,
	done,
	completedAt,
	onOpen,
	starting,
}: {
	lesson: TutorialLessonSummary;
	done: string[];
	completedAt?: string;
	onOpen: () => void;
	starting: boolean;
}) {
	const { t } = useTranslation("tutorial");
	const doneCount = Math.min(done.length, lesson.stepCount);
	const percent = lesson.stepCount > 0 ? (doneCount / lesson.stepCount) * 100 : 0;
	const started = doneCount > 0;

	return (
		<Card withBorder radius="md" p="md" h="100%">
			<Stack gap="xs" h="100%">
				<Group justify="space-between" wrap="nowrap" align="flex-start">
					<Text fw={700}>{lesson.title}</Text>
					{completedAt && (
						<ThemeIcon variant="light" color="teal" size="sm">
							<IconCheck size={14} />
						</ThemeIcon>
					)}
				</Group>
				<Text size="sm" c="dimmed" style={{ flex: 1 }}>
					{lesson.summary}
				</Text>

				<Box>
					<Progress value={percent} size="sm" color={completedAt ? "teal" : "indigo"} />
					<Text size="xs" c="dimmed" mt={4}>
						{t("stepCount", { done: doneCount, total: lesson.stepCount })}
					</Text>
				</Box>

				<Button
					variant={completedAt ? "default" : started ? "light" : "filled"}
					rightSection={<IconArrowRight size={14} />}
					onClick={onOpen}
					loading={starting}
					fullWidth
				>
					{completedAt ? t("replay") : started ? t("resume") : t("start")}
				</Button>
			</Stack>
		</Card>
	);
}

/**
 * What the sandbox is and where it lives.
 *
 * Shown even before it exists: a user is about to have a repository created in
 * their data directory, and finding out afterwards is worse than being told first.
 * Deletion links to normal project deletion rather than offering its own button —
 * a second teardown implementation would drift from the real one.
 */
function SandboxCard({ exists, projectId }: { exists: boolean; projectId: string | null }) {
	const { t } = useTranslation("tutorial");
	const navigate = useNavigate();
	return (
		<Alert
			variant="light"
			color={exists ? "indigo" : "gray"}
			icon={exists ? <IconFolders size={18} /> : <IconPlugConnectedX size={18} />}
			title={t("sandboxTitle")}
		>
			<Stack gap="xs">
				<Text size="sm">{t("sandboxBody")}</Text>
				{exists ? (
					<>
						<Group gap="xs">
							{projectId && (
								<Button
									size="compact-sm"
									variant="light"
									onClick={() =>
										void navigate({ to: "/projects/$projectId", params: { projectId } })
									}
								>
									{t("sandboxOpen")}
								</Button>
							)}
						</Group>
						<Text size="xs" c="dimmed">
							{t("sandboxDeleteHint")}
						</Text>
					</>
				) : (
					<Text size="xs" c="dimmed">
						{t("sandboxMissing")}
					</Text>
				)}
			</Stack>
		</Alert>
	);
}
