import { statusRegistry } from "@frontend/lib/status-registry";
import {
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Loader,
	Modal,
	SegmentedControl,
	Stack,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChapters, useCreateChapter } from "../../hooks/useChapters";
import { useChapterBatchMergeCapability } from "../../hooks/usePlatform";
import { useDeleteProject, useProject, useUpdateProject } from "../../hooks/useProjects";
import { addRecentTab } from "../../hooks/useRecentTabs";
import { APP_SHELL_CONTENT_HEIGHT } from "../../lib/safe-area";

const NarraFlow = lazy(() =>
	import("../../components/graph/NarraFlow").then((m) => ({
		default: m.NarraFlow,
	})),
);

const RulerFlow = lazy(() =>
	import("../../components/ruler/RulerFlow").then((m) => ({
		default: m.RulerFlow,
	})),
);

const ChapterBatchMergeModal = lazy(() =>
	import("../../components/chapter/ChapterBatchMergeModal").then((m) => ({
		default: m.ChapterBatchMergeModal,
	})),
);

const ChapterCleanupModal = lazy(() =>
	import("../../components/chapter/ChapterCleanupModal").then((m) => ({
		default: m.ChapterCleanupModal,
	})),
);

const ProjectCommandsModal = lazy(() =>
	import("../../components/project/ProjectCommandsModal").then((m) => ({
		default: m.ProjectCommandsModal,
	})),
);

const ProjectRoutinesModal = lazy(() =>
	import("../../components/project/ProjectRoutinesModal").then((m) => ({
		default: m.ProjectRoutinesModal,
	})),
);

const ProjectSettingsModal = lazy(() =>
	import("../../components/project/ProjectSettingsModal").then((m) => ({
		default: m.ProjectSettingsModal,
	})),
);

const ProjectSkillsModal = lazy(() =>
	import("../../components/project/ProjectSkillsModal").then((m) => ({
		default: m.ProjectSkillsModal,
	})),
);

export const Route = createFileRoute("/projects/$projectId")({
	component: ProjectDetailPage,
});

function ProjectDetailPage() {
	const { projectId } = Route.useParams();
	// biome-ignore lint/suspicious/noExplicitAny: loose search params
	const search = useSearch({ strict: false }) as any;
	const focus = search?.focus as string | undefined;
	const navigate = useNavigate();
	const { data: project, isLoading: projectLoading } = useProject(projectId);
	const { data: chapters } = useChapters(projectId);
	const createChapter = useCreateChapter();
	const updateProject = useUpdateProject();
	const deleteProject = useDeleteProject();
	const batchMergeCapability = useChapterBatchMergeCapability();
	const [opened, { open, close }] = useDisclosure(false);
	const [cleanupOpened, { open: openCleanup, close: closeCleanup }] = useDisclosure(false);
	const [batchMergeOpened, { open: openBatchMerge, close: closeBatchMerge }] = useDisclosure(false);
	const [deleteOpened, { open: openDelete, close: closeDelete }] = useDisclosure(false);
	const [commandsOpened, { open: openCommands, close: closeCommands }] = useDisclosure(false);
	const [skillsOpened, { open: openSkills, close: closeSkills }] = useDisclosure(false);
	const [routinesOpened, { open: openRoutines, close: closeRoutines }] = useDisclosure(false);
	const [settingsOpened, { open: openSettings, close: closeSettings }] = useDisclosure(false);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [deleteConfirmName, setDeleteConfirmName] = useState("");
	const { t } = useTranslation("chapters");
	const { t: tc } = useTranslation("common");
	const { t: tp } = useTranslation("projects");

	// Record project visit in recent tabs
	useEffect(() => {
		if (project) {
			addRecentTab({
				type: "project",
				id: projectId,
				title: project.name,
				subtitle: project.description || undefined,
			});
		}
	}, [projectId, project]);

	if (projectLoading) return <Loader />;
	if (!project) return <Text>{tp("projectNotFound")}</Text>;

	const hasGitPath = !!project.gitPath;
	// Anything that is not the deprecated Ruler falls back to the classic canvas, which
	// matches the render branch below and the column's own default.
	const flowMode: "classic" | "ruler" = project.flowMode === "ruler" ? "ruler" : "classic";
	const batchMergeSupported =
		batchMergeCapability.supported && batchMergeCapability.startRouteSupported;

	const handleCreate = () => {
		if (!title.trim()) return;
		createChapter.mutate(
			{
				projectId,
				title: title.trim(),
				description: description.trim() || undefined,
			},
			{
				onSuccess: () => {
					close();
					setTitle("");
					setDescription("");
				},
			},
		);
	};

	/**
	 * Swap the canvas the story network renders in.
	 *
	 * Reads back from `project.flowMode` rather than local state, so the control always
	 * shows what the server actually stored: a rejected PATCH leaves the old view
	 * selected and says so, instead of the toggle appearing to have worked.
	 */
	const handleFlowModeChange = (next: string) => {
		if (next !== "classic" && next !== "ruler") return;
		if (next === flowMode) return;
		updateProject.mutate(
			{ id: projectId, data: { flowMode: next } },
			{
				onError: (err) =>
					notifications.show({
						color: "red",
						title: tp("flowModeSwitchFailed"),
						message: err instanceof Error ? err.message : String(err),
					}),
			},
		);
	};

	const handleDelete = () => {
		deleteProject.mutate(projectId, {
			onSuccess: () => {
				closeDelete();
				navigate({ to: "/projects" });
			},
		});
	};

	return (
		<Box
			style={{
				height: APP_SHELL_CONTENT_HEIGHT,
				display: "flex",
				flexDirection: "column",
			}}
		>
			{/* Toolbar */}
			<Group p="xs" justify="space-between" style={{ flexShrink: 0 }}>
				<Group gap="sm">
					<Title order={4}>{project.name}</Title>
					<Badge color={statusRegistry.projectStatus(project.status).color} size="sm">
						{tc(statusRegistry.projectStatus(project.status).i18nKey)}
					</Badge>
					{/* Which canvas renders the story network.
					    Sits with the title rather than among the action buttons because it
					    changes the view, not the project's contents. It exists at all because
					    `flowMode` used to be write-once at creation: a project created as
					    `ruler` had no path back, which became untenable once Ruler was
					    deprecated. Switching only rewrites this one preference — chapters,
					    branches and worktrees are untouched, so it is freely reversible. */}
					<SegmentedControl
						size="xs"
						value={flowMode}
						onChange={handleFlowModeChange}
						disabled={updateProject.isPending}
						data={[
							{ value: "classic", label: tp("flowModeClassic") },
							{ value: "ruler", label: tp("flowModeRulerDeprecated") },
						]}
						aria-label={tp("flowModeSwitcherLabel")}
					/>
				</Group>
				<Group gap="xs">
					<Button variant="light" color="red" size="xs" onClick={openDelete}>
						{tp("deleteProject")}
					</Button>
					<Button
						variant="light"
						color="red"
						size="xs"
						onClick={openCleanup}
						disabled={!chapters?.length}
					>
						{t("cleanup")}
					</Button>
					<Button
						variant="light"
						color="green"
						size="xs"
						onClick={openBatchMerge}
						disabled={!chapters?.length || !batchMergeSupported}
						title={batchMergeSupported ? undefined : batchMergeCapability.reason}
					>
						{t("batchMerge")}
					</Button>
					<Button variant="light" size="xs" onClick={openCommands}>
						{tp("commandsButton")}
					</Button>
					<Button variant="light" size="xs" onClick={openSkills}>
						{tp("skillsButton")}
					</Button>
					<Button variant="light" size="xs" onClick={openRoutines}>
						{tp("routinesButton")}
					</Button>
					<Button variant="light" size="xs" onClick={openSettings}>
						{tp("settingsButton")}
					</Button>
					<Button size="xs" onClick={open} disabled={!hasGitPath}>
						{t("newChapter")}
					</Button>
				</Group>
			</Group>

			<Divider />

			{/* Graph canvas */}
			<Box style={{ flex: 1, minHeight: 0 }}>
				<Suspense fallback={<Loader />}>
					{flowMode === "ruler" ? (
						<RulerFlow
							projectId={projectId}
							focusChapterId={focus}
							onLeaveDeprecated={() => handleFlowModeChange("classic")}
						/>
					) : (
						<NarraFlow projectId={projectId} focusChapterId={focus} />
					)}
				</Suspense>
			</Box>

			{/* New chapter modal */}
			<Modal opened={opened} onClose={close} title={t("newChapter")}>
				<Stack>
					<TextInput
						label={tc("title")}
						placeholder={t("titlePlaceholder")}
						value={title}
						onChange={(e) => setTitle(e.currentTarget.value)}
						required
					/>
					<Textarea
						label={tc("description")}
						placeholder={t("descriptionPlaceholder")}
						value={description}
						onChange={(e) => setDescription(e.currentTarget.value)}
					/>
					<Button onClick={handleCreate} loading={createChapter.isPending}>
						{tc("create")}
					</Button>
				</Stack>
			</Modal>

			{cleanupOpened && (
				<Suspense fallback={null}>
					<ChapterCleanupModal
						chapters={chapters ?? []}
						opened={cleanupOpened}
						onClose={closeCleanup}
					/>
				</Suspense>
			)}
			{batchMergeOpened && (
				<Suspense fallback={null}>
					<ChapterBatchMergeModal
						chapters={chapters ?? []}
						opened={batchMergeOpened}
						onClose={closeBatchMerge}
					/>
				</Suspense>
			)}
			{commandsOpened && (
				<Suspense fallback={null}>
					<ProjectCommandsModal
						projectId={projectId}
						opened={commandsOpened}
						onClose={closeCommands}
					/>
				</Suspense>
			)}
			{skillsOpened && (
				<Suspense fallback={null}>
					<ProjectSkillsModal projectId={projectId} opened={skillsOpened} onClose={closeSkills} />
				</Suspense>
			)}
			{routinesOpened && (
				<Suspense fallback={null}>
					<ProjectRoutinesModal
						projectId={projectId}
						opened={routinesOpened}
						onClose={closeRoutines}
					/>
				</Suspense>
			)}
			{settingsOpened && (
				<Suspense fallback={null}>
					<ProjectSettingsModal
						projectId={projectId}
						proxyDomain={project.proxyDomain ?? null}
						chapterSettings={project.chapterSettings}
						opened={settingsOpened}
						onClose={closeSettings}
					/>
				</Suspense>
			)}

			<Modal
				opened={deleteOpened}
				onClose={() => {
					closeDelete();
					setDeleteConfirmName("");
				}}
				title={tp("deleteProject")}
			>
				<Stack>
					<Text size="sm">{tp("deleteProjectConfirm", { name: project.name })}</Text>
					<TextInput
						label={tp("deleteProjectTypeName")}
						value={deleteConfirmName}
						onChange={(e) => setDeleteConfirmName(e.currentTarget.value)}
					/>
					<Button
						color="red"
						onClick={handleDelete}
						loading={deleteProject.isPending}
						disabled={deleteConfirmName !== project.name}
					>
						{tc("delete")}
					</Button>
				</Stack>
			</Modal>
		</Box>
	);
}
