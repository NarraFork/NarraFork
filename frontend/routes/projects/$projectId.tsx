import {
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChapterBatchMergeModal } from "../../components/chapter/ChapterBatchMergeModal";
import { ChapterCleanupModal } from "../../components/chapter/ChapterCleanupModal";
import { StoryNetwork } from "../../components/graph/StoryNetwork";
import { useChapters, useCreateChapter } from "../../hooks/useChapters";
import { useProject } from "../../hooks/useProjects";

export const Route = createFileRoute("/projects/$projectId")({
	component: ProjectDetailPage,
});

function ProjectDetailPage() {
	const { projectId } = Route.useParams();
	const { data: project, isLoading: projectLoading } = useProject(projectId);
	const { data: chapters } = useChapters(projectId);
	const createChapter = useCreateChapter();
	const [opened, { open, close }] = useDisclosure(false);
	const [cleanupOpened, { open: openCleanup, close: closeCleanup }] = useDisclosure(false);
	const [batchMergeOpened, { open: openBatchMerge, close: closeBatchMerge }] = useDisclosure(false);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const { t } = useTranslation("chapters");
	const { t: tc } = useTranslation("common");
	const { t: tp } = useTranslation("projects");

	if (projectLoading) return <Loader />;
	if (!project) return <Text>{tp("projectNotFound")}</Text>;

	const hasGitPath = !!project.gitPath;

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

	return (
		<Box
			style={{
				height: "calc(100vh - 60px)",
				display: "flex",
				flexDirection: "column",
			}}
		>
			{/* Toolbar */}
			<Group p="xs" justify="space-between" style={{ flexShrink: 0 }}>
				<Group gap="sm">
					<Title order={4}>{project.name}</Title>
					<Badge color={project.status === "active" ? "green" : "gray"} size="sm">
						{project.status}
					</Badge>
				</Group>
				<Group gap="xs">
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
						disabled={!chapters?.length}
					>
						{t("batchMerge")}
					</Button>
					<Button size="xs" onClick={open} disabled={!hasGitPath}>
						{t("newChapter")}
					</Button>
				</Group>
			</Group>

			<Divider />

			{/* Graph canvas */}
			<Box style={{ flex: 1, minHeight: 0 }}>
				<StoryNetwork projectId={projectId} />
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

			<ChapterCleanupModal
				chapters={chapters ?? []}
				opened={cleanupOpened}
				onClose={closeCleanup}
			/>
			<ChapterBatchMergeModal
				chapters={chapters ?? []}
				opened={batchMergeOpened}
				onClose={closeBatchMerge}
			/>
		</Box>
	);
}
