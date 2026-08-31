/**
 * One lesson: a step rail beside the REAL narrator surface.
 *
 * The right-hand pane is the actual `NarratorPanel` the rest of the app uses, not
 * a mock of it. That is the whole design: everything the user learns here — where
 * the composer is, what a tool card looks like, how an approval reads — transfers
 * because it *is* the product. Only the model is scripted.
 *
 * The lesson's narrator is created on demand rather than at page load: provisioning
 * runs `git init` for chapter lessons, and doing that just because someone opened
 * a page would create repositories for lessons nobody started.
 */

import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import {
	ActionIcon,
	Alert,
	Box,
	Button,
	Card,
	Center,
	Drawer,
	Group,
	Loader,
	Modal,
	Progress,
	ScrollArea,
	Stack,
	Text,
	ThemeIcon,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
	IconArrowLeft,
	IconArrowRight,
	IconBulb,
	IconCheck,
	IconGitBranch,
	IconListCheck,
	IconPlayerPlay,
	IconRefresh,
} from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useResetTutorialLesson,
	useSandboxEdgeKinds,
	useStartTutorialLesson,
	useTutorialIndex,
	useTutorialLesson,
	useTutorialSteps,
} from "../../hooks/useTutorial";
import type { TutorialLesson, TutorialStep } from "../../lib/api/types";
import { APP_SHELL_FULL_BLEED_HEIGHT } from "../../lib/safe-area";

// Heavy: pulls the whole message renderer. Not needed until a lesson is started.
const NarratorPanel = lazy(() =>
	import("../../components/narrator/NarratorPanel").then((m) => ({ default: m.NarratorPanel })),
);

export const Route = createFileRoute("/tutorial/$lessonId")({
	component: TutorialLessonPage,
});

function TutorialLessonPage() {
	const { lessonId } = Route.useParams();
	const { t } = useTranslation("tutorial");
	const navigate = useNavigate();
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY);

	const { data, isLoading } = useTutorialLesson(lessonId);
	const { data: index } = useTutorialIndex();
	const startLesson = useStartTutorialLesson();
	const resetLesson = useResetTutorialLesson();

	// `undefined` means "not started in this tab". It is only ever set by a start
	// call; the server-reported session below is what makes a RETURNING user land back
	// on their running conversation.
	const [startedNarratorId, setStartedNarratorId] = useState<string | undefined>(undefined);
	const [startedProjectId, setStartedProjectId] = useState<string | undefined>(undefined);
	const [startError, setStartError] = useState<string | null>(null);
	const [resetOpen, { open: openReset, close: closeReset }] = useDisclosure(false);
	const [railOpen, { open: openRail, close: closeRail }] = useDisclosure(false);

	const lesson = data?.lesson;
	const recordedStepIds = data?.progress?.completedStepIds ?? [];

	// One tutorial narrator spans every lesson, so a lesson the user already began
	// (or simply reloaded) has a live session on the server. Mounting it is not a
	// convenience: pressing start again writes another lesson boundary, which rewinds
	// the script of a lesson that was halfway through.
	const narratorId = startedNarratorId ?? data?.session?.narratorId;
	const projectId = startedProjectId ?? data?.session?.projectId ?? undefined;

	// Fork and merge happen on the graph, not in this narrator, so their evidence
	// has to be polled rather than observed. Only for chapters lessons: elsewhere
	// there is nothing to watch and the query stays disabled.
	const chapterEdgeKinds = useSandboxEdgeKinds(projectId, lesson?.track === "chapters");

	const steps = useTutorialSteps({
		lesson,
		narratorId,
		recordedStepIds,
		chapterEdgeKinds,
	});

	const start = useCallback(() => {
		setStartError(null);
		startLesson.mutate(lessonId, {
			onSuccess: (session) => {
				setStartedNarratorId(session.narratorId);
				setStartedProjectId(session.projectId ?? undefined);
			},
			onError: (error) => setStartError((error as Error)?.message ?? String(error)),
		});
	}, [lessonId, startLesson]);

	const nextLessonId = useMemo(() => {
		const lessons = index?.lessons ?? [];
		const ordered = [...lessons].sort((a, b) => {
			const trackDelta =
				(index?.tracks ?? []).indexOf(a.track) - (index?.tracks ?? []).indexOf(b.track);
			return trackDelta !== 0 ? trackDelta : a.order - b.order;
		});
		const position = ordered.findIndex((entry) => entry.id === lessonId);
		return position >= 0 ? ordered[position + 1]?.id : undefined;
	}, [index?.lessons, index?.tracks, lessonId]);

	const confirmReset = () => {
		resetLesson.mutate(lessonId, {
			onSuccess: () => {
				// A reset means "let me do it again from the top". Only the LOCAL start
				// state is dropped, which puts the start button back; the narrator itself is
				// kept (it holds the earlier lessons the user may want to read), and
				// pressing start writes a fresh lesson boundary so the script replays from
				// turn 0 in the same conversation.
				setStartedNarratorId(undefined);
				setStartedProjectId(undefined);
				closeReset();
			},
		});
	};

	if (isLoading) return <Loader />;
	if (!lesson) return <Text c="dimmed">{t("empty")}</Text>;

	const rail = (
		<StepRail
			lesson={lesson}
			completedStepIds={steps.completedStepIds}
			activeStepId={steps.activeStepId}
			complete={steps.complete}
			started={!!narratorId}
			starting={startLesson.isPending}
			// Fork / merge / graph steps are performed on the NarraFlow canvas, so the
			// rail needs a way to get there. Without it the instruction says "fork this
			// chapter" while the page offers no route to do so.
			projectId={lesson.track === "chapters" ? projectId : undefined}
			onOpenGraph={
				projectId
					? () => void navigate({ to: "/projects/$projectId", params: { projectId } })
					: undefined
			}
			onStart={start}
			onMarkStepDone={steps.markStepDone}
			onSkipToEnd={steps.markLessonComplete}
			onReset={openReset}
			onBack={() => void navigate({ to: "/tutorial" })}
			onNext={
				nextLessonId
					? () => {
							// Drop THIS lesson's start state so the next lesson opens on its own
							// start button. The narrator is shared across lessons, so carrying the
							// id over would mount the previous lesson's conversation under the next
							// lesson's steps — before its boundary row exists, which is what makes
							// the script play from turn 0.
							setStartedNarratorId(undefined);
							setStartedProjectId(undefined);
							void navigate({
								to: "/tutorial/$lessonId",
								params: { lessonId: nextLessonId },
							});
						}
					: undefined
			}
			startError={startError}
		/>
	);

	const surface = narratorId ? (
		<Suspense
			fallback={
				<Center h="100%">
					<Loader size="sm" />
				</Center>
			}
		>
			<NarratorPanel key={narratorId} narratorId={narratorId} />
		</Suspense>
	) : (
		<Center h="100%" p="xl">
			<Stack align="center" gap="sm" maw={420}>
				<ThemeIcon variant="light" color="indigo" size="xl">
					<IconPlayerPlay size={22} />
				</ThemeIcon>
				<Title order={4} ta="center">
					{lesson.title}
				</Title>
				<Text c="dimmed" size="sm" ta="center">
					{lesson.summary}
				</Text>
				<Button onClick={start} loading={startLesson.isPending}>
					{t("start")}
				</Button>
			</Stack>
		</Center>
	);

	if (isMobile) {
		return (
			<Box
				h={APP_SHELL_FULL_BLEED_HEIGHT}
				mx="calc(var(--mantine-spacing-md) * -1)"
				my="calc(var(--mantine-spacing-md) * -1)"
				style={{ display: "flex", flexDirection: "column", position: "relative" }}
			>
				<Group
					justify="space-between"
					px="sm"
					py="xs"
					wrap="nowrap"
					style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
				>
					<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
						<ActionIcon variant="subtle" onClick={() => void navigate({ to: "/tutorial" })}>
							<IconArrowLeft size={16} />
						</ActionIcon>
						<Text fw={600} size="sm" truncate>
							{lesson.title}
						</Text>
					</Group>
					<Tooltip label={t("steps")}>
						<ActionIcon variant="light" onClick={openRail}>
							<IconListCheck size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>
				<Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{surface}</Box>
				<Drawer
					opened={railOpen}
					onClose={closeRail}
					position="bottom"
					size="80%"
					title={t("steps")}
				>
					{rail}
				</Drawer>
				<ResetModal
					opened={resetOpen}
					onClose={closeReset}
					onConfirm={confirmReset}
					pending={resetLesson.isPending}
				/>
			</Box>
		);
	}

	return (
		<Box
			h={APP_SHELL_FULL_BLEED_HEIGHT}
			mx="calc(var(--mantine-spacing-md) * -1)"
			my="calc(var(--mantine-spacing-md) * -1)"
			style={{ display: "flex", minHeight: 0 }}
		>
			<Box
				w={360}
				style={{
					flexShrink: 0,
					borderRight: "1px solid var(--mantine-color-default-border)",
					overflow: "hidden",
				}}
			>
				<ScrollArea h="100%">{rail}</ScrollArea>
			</Box>
			<Box style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>{surface}</Box>
			<ResetModal
				opened={resetOpen}
				onClose={closeReset}
				onConfirm={confirmReset}
				pending={resetLesson.isPending}
			/>
		</Box>
	);
}

function StepRail({
	lesson,
	completedStepIds,
	activeStepId,
	complete,
	started,
	starting,
	projectId,
	onOpenGraph,
	onStart,
	onMarkStepDone,
	onSkipToEnd,
	onReset,
	onBack,
	onNext,
	startError,
}: {
	lesson: TutorialLesson;
	completedStepIds: string[];
	activeStepId: string | null;
	complete: boolean;
	started: boolean;
	starting: boolean;
	/** Set only for chapters lessons, once the sandbox exists. */
	projectId?: string;
	onOpenGraph?: () => void;
	onStart: () => void;
	onMarkStepDone: (stepId: string) => void;
	onSkipToEnd: () => void;
	onReset: () => void;
	onBack: () => void;
	onNext?: () => void;
	startError: string | null;
}) {
	const { t } = useTranslation("tutorial");
	const done = new Set(completedStepIds);
	const doneCount = lesson.steps.filter((step) => done.has(step.id)).length;
	const percent = lesson.steps.length > 0 ? (doneCount / lesson.steps.length) * 100 : 0;

	return (
		<Stack gap="sm" p="md">
			<Group gap="xs" wrap="nowrap">
				<ActionIcon variant="subtle" onClick={onBack} aria-label={t("backToOverview")}>
					<IconArrowLeft size={16} />
				</ActionIcon>
				<Title order={5} style={{ flex: 1, minWidth: 0 }}>
					{lesson.title}
				</Title>
			</Group>

			<Text size="sm" c="dimmed">
				{lesson.summary}
			</Text>

			<Box>
				<Progress value={percent} size="sm" color={complete ? "teal" : "indigo"} />
				<Text size="xs" c="dimmed" mt={4}>
					{t("stepCount", { done: doneCount, total: lesson.steps.length })}
				</Text>
			</Box>

			{startError && (
				<Alert color="red" variant="light">
					{t("startFailed", { error: startError })}
				</Alert>
			)}

			{!started && (
				<Button onClick={onStart} loading={starting} leftSection={<IconPlayerPlay size={14} />}>
					{t("start")}
				</Button>
			)}

			{/* Chapters lessons are performed on the canvas, so the rail has to lead
			    there — otherwise the instruction asks for a fork the page cannot do. */}
			{projectId && onOpenGraph && (
				<Button variant="light" leftSection={<IconGitBranch size={14} />} onClick={onOpenGraph}>
					{t("openGraph")}
				</Button>
			)}

			<Stack gap="xs">
				{lesson.steps.map((step, position) => (
					<StepRow
						key={step.id}
						step={step}
						position={position + 1}
						done={done.has(step.id)}
						active={step.id === activeStepId}
						onMarkDone={() => onMarkStepDone(step.id)}
					/>
				))}
			</Stack>

			{complete && (
				<Alert color="teal" variant="light" icon={<IconCheck size={16} />}>
					{t("lessonComplete")}
				</Alert>
			)}

			<Group gap="xs">
				{onNext && (
					<Button
						variant={complete ? "filled" : "light"}
						rightSection={<IconArrowRight size={14} />}
						onClick={onNext}
					>
						{t("nextLesson")}
					</Button>
				)}
				{started && !complete && (
					<Button variant="subtle" size="compact-sm" onClick={onSkipToEnd}>
						{t("skipToEnd")}
					</Button>
				)}
				{doneCount > 0 && (
					<Button
						variant="subtle"
						size="compact-sm"
						color="gray"
						leftSection={<IconRefresh size={14} />}
						onClick={onReset}
					>
						{t("reset")}
					</Button>
				)}
			</Group>
		</Stack>
	);
}

function StepRow({
	step,
	position,
	done,
	active,
	onMarkDone,
}: {
	step: TutorialStep;
	position: number;
	done: boolean;
	active: boolean;
	onMarkDone: () => void;
}) {
	const { t } = useTranslation("tutorial");
	// A `manual` step has nothing to detect, so it needs the button. Every other
	// kind advances from real product state and must NOT offer one — a user could
	// otherwise click past a step without doing it and be told they had learned it.
	const isManual = step.completion.kind === "manual";

	return (
		<Card
			withBorder
			radius="sm"
			p="sm"
			style={{
				borderColor: active ? "var(--mantine-color-indigo-5)" : undefined,
				background: done ? "var(--mantine-color-teal-light)" : undefined,
			}}
		>
			<Group gap="xs" align="flex-start" wrap="nowrap">
				<ThemeIcon
					size="sm"
					variant={done ? "filled" : active ? "light" : "subtle"}
					color={done ? "teal" : active ? "indigo" : "gray"}
				>
					{done ? <IconCheck size={12} /> : position}
				</ThemeIcon>
				<Box style={{ flex: 1, minWidth: 0 }}>
					<Text size="sm">{step.instruction}</Text>
					{step.hint && active && (
						<Group gap={6} mt={6} wrap="nowrap" align="flex-start">
							<ThemeIcon size="xs" variant="subtle" color="yellow">
								<IconBulb size={11} />
							</ThemeIcon>
							<Text size="xs" c="dimmed">
								<Text span fw={600}>
									{t("hint")}:{" "}
								</Text>
								{step.hint}
							</Text>
						</Group>
					)}
					{isManual && active && !done && (
						<Button mt="xs" size="compact-xs" variant="light" onClick={onMarkDone}>
							{t("markStepDone")}
						</Button>
					)}
				</Box>
			</Group>
		</Card>
	);
}

function ResetModal({
	opened,
	onClose,
	onConfirm,
	pending,
}: {
	opened: boolean;
	onClose: () => void;
	onConfirm: () => void;
	pending: boolean;
}) {
	const { t } = useTranslation("tutorial");
	return (
		<Modal opened={opened} onClose={onClose} title={t("resetConfirmTitle")} centered>
			<Stack gap="md">
				<Text size="sm">{t("resetConfirmBody")}</Text>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button color="red" onClick={onConfirm} loading={pending}>
						{t("resetConfirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
