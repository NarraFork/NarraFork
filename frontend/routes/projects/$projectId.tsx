import {
	Badge,
	Button,
	Group,
	Loader,
	Modal,
	Select,
	SimpleGrid,
	Stack,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChapterBatchMergeModal } from "../../components/chapter/ChapterBatchMergeModal";
import { ChapterCard } from "../../components/chapter/ChapterCard";
import { ChapterCleanupModal } from "../../components/chapter/ChapterCleanupModal";
import { useChapters, useCreateChapter } from "../../hooks/useChapters";
import { useProject } from "../../hooks/useProjects";

export const Route = createFileRoute("/projects/$projectId")({
	component: ProjectDetailPage,
});

function ProjectDetailPage() {
	const { projectId } = Route.useParams();
	const { data: project, isLoading: projectLoading } = useProject(projectId);
	const { data: chapters, isLoading: chaptersLoading } = useChapters(projectId);
	const createChapter = useCreateChapter();
	const [opened, { open, close }] = useDisclosure(false);
	const [cleanupOpened, { open: openCleanup, close: closeCleanup }] = useDisclosure(false);
	const [batchMergeOpened, { open: openBatchMerge, close: closeBatchMerge }] = useDisclosure(false);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [type, setType] = useState<string>("meanwhile");
	const { t } = useTranslation("chapters");
	const { t: tc } = useTranslation("common");
	const { t: tp } = useTranslation("projects");

	if (projectLoading) return <Loader />;
	if (!project) return <Text>{tp("projectNotFound")}</Text>;

	const primaryRepo =
		project.repositories?.find((r: any) => r.isPrimary) ?? project.repositories?.[0];

	const handleCreate = () => {
		if (!title.trim() || !primaryRepo) return;
		createChapter.mutate(
			{
				projectId,
				repositoryId: primaryRepo.id,
				title: title.trim(),
				description: description.trim() || undefined,
				type,
			},
			{
				onSuccess: () => {
					close();
					setTitle("");
					setDescription("");
					setType("meanwhile");
				},
			},
		);
	};

	return (
		<Stack>
			<Group justify="space-between">
				<div>
					<Title order={2}>{project.name}</Title>
					{project.description && (
						<Text c="dimmed" size="sm">
							{project.description}
						</Text>
					)}
				</div>
				<Badge color={project.status === "active" ? "green" : "gray"} size="lg">
					{project.status}
				</Badge>
			</Group>
			<Group justify="space-between">
				<Title order={3}>{t("title")}</Title>
				<Group gap="xs">
					<Link to="/projects/$projectId/graph" params={{ projectId }}>
						<Button variant="light" size="sm">
							{t("viewGraph")}
						</Button>
					</Link>
					<Button
						variant="light"
						color="red"
						size="sm"
						onClick={openCleanup}
						disabled={!chapters?.length}
					>
						{t("cleanup")}
					</Button>
					<Button
						variant="light"
						color="green"
						size="sm"
						onClick={openBatchMerge}
						disabled={!chapters?.length}
					>
						{t("batchMerge")}
					</Button>
					<Button onClick={open} disabled={!primaryRepo}>
						{t("newChapter")}
					</Button>
				</Group>
			</Group>

			{chaptersLoading ? (
				<Loader />
			) : !chapters?.length ? (
				<Text c="dimmed">{t("noChapters")}</Text>
			) : (
				<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
					{chapters.map((chapter: any) => (
						<ChapterCard key={chapter.id} chapter={chapter} />
					))}
				</SimpleGrid>
			)}

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
					<Select
						label={tc("type")}
						data={[
							{ value: "meanwhile", label: t("typeMeanwhile") },
							{ value: "whatif", label: t("typeWhatif") },
						]}
						value={type}
						onChange={(v) => setType(v ?? "meanwhile")}
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
		</Stack>
	);
}
