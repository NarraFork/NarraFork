import { statusRegistry } from "@frontend/lib/status-registry";
import {
	Badge,
	Button,
	Card,
	Code,
	Group,
	Loader,
	Modal,
	Progress,
	SegmentedControl,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DirectoryPicker } from "../../components/common/DirectoryPicker";
import { usePlatform } from "../../hooks/usePlatform";
import { useCreateProject, useCreateProjectStream, useProjects } from "../../hooks/useProjects";

export const Route = createFileRoute("/projects/")({
	component: ProjectListPage,
});

function ProjectListPage() {
	const { data: projects, isLoading } = useProjects();
	const createProject = useCreateProject();
	const createProjectStream = useCreateProjectStream();
	const [opened, { open, close }] = useDisclosure(false);
	const [name, setName] = useState("");
	const [nameError, setNameError] = useState("");
	const [repoMode, setRepoMode] = useState<string>("existing");
	const [repoPath, setRepoPath] = useState("");
	const [cloneUrl, setCloneUrl] = useState("");
	const [cloneBranch, setCloneBranch] = useState("");
	const { t } = useTranslation("projects");
	const { t: tc } = useTranslation("common");
	const platform = usePlatform();

	const pathPlaceholder =
		platform === "windows" ? "E:\\Code\\my-repo" : "/home/user/projects/my-repo";

	const isCloning = createProjectStream.isPending;

	const resetForm = () => {
		setName("");
		setNameError("");
		setRepoMode("existing");
		setRepoPath("");
		setCloneUrl("");
		setCloneBranch("");
		createProjectStream.reset();
	};

	const handleClose = () => {
		if (!isCloning) {
			close();
			resetForm();
		}
	};

	const handleCreate = () => {
		if (!name.trim()) {
			setNameError(t("projectNameRequired"));
			return;
		}
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const data: Record<string, any> = {
			name: name.trim(),
			repoMode,
			gitPath: repoPath.trim() || undefined,
		};

		if (repoMode === "clone") {
			data.cloneUrl = cloneUrl.trim() || undefined;
			data.cloneBranch = cloneBranch.trim() || undefined;

			createProjectStream.mutate(data, {
				onSuccess: () => {
					close();
					resetForm();
				},
			});
		} else {
			createProject.mutate(data, {
				onSuccess: () => {
					close();
					resetForm();
				},
			});
		}
	};

	// Parse git clone progress for a progress bar
	const progressPercent = parseGitProgress(createProjectStream.cloneProgress);

	if (isLoading) return <Loader />;

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={2}>{t("title")}</Title>
				<Button onClick={open}>{t("newProject")}</Button>
			</Group>

			{!projects?.length ? (
				<Text c="dimmed">{t("noProjects")}</Text>
			) : (
				<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
					{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
					{projects.map((project: any) => (
						<Card
							key={project.id}
							shadow="sm"
							padding="lg"
							radius="md"
							withBorder
							component={Link}
							to="/projects/$projectId"
							// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
							params={{ projectId: project.id } as any}
							style={{ textDecoration: "none" }}
						>
							<Group justify="space-between" mb="xs">
								<Text fw={500}>{project.name}</Text>
								<Badge color={statusRegistry.projectStatus(project.status).color}>
									{tc(statusRegistry.projectStatus(project.status).i18nKey)}
								</Badge>
							</Group>
							{project.description && (
								<Text size="sm" c="dimmed" lineClamp={2}>
									{project.description}
								</Text>
							)}
						</Card>
					))}
				</SimpleGrid>
			)}

			<Modal
				opened={opened}
				onClose={handleClose}
				title={t("newProject")}
				closeOnClickOutside={!isCloning}
				closeOnEscape={!isCloning}
			>
				<Stack>
					<TextInput
						label={t("projectName")}
						placeholder={t("projectNamePlaceholder")}
						value={name}
						onChange={(e) => {
							setName(e.currentTarget.value);
							if (nameError) setNameError("");
						}}
						error={nameError}
						required
						disabled={isCloning}
					/>
					<div>
						<Text size="sm" fw={500} mb={4}>
							{t("repoMode")}
						</Text>
						<SegmentedControl
							fullWidth
							value={repoMode}
							onChange={setRepoMode}
							data={[
								{ value: "existing", label: t("repoModeExisting") },
								{ value: "init", label: t("repoModeInit") },
								{ value: "clone", label: t("repoModeClone") },
							]}
							disabled={isCloning}
						/>
					</div>
					{repoMode === "clone" && (
						<>
							<TextInput
								label={t("cloneUrl")}
								placeholder={t("cloneUrlPlaceholder")}
								value={cloneUrl}
								onChange={(e) => setCloneUrl(e.currentTarget.value)}
								required
								disabled={isCloning}
							/>
							<TextInput
								label={t("cloneBranch")}
								value={cloneBranch}
								onChange={(e) => setCloneBranch(e.currentTarget.value)}
								disabled={isCloning}
							/>
						</>
					)}
					<DirectoryPicker
						label={t("repositoryPath")}
						placeholder={pathPlaceholder}
						value={repoPath}
						onChange={setRepoPath}
						description={
							repoMode === "init"
								? t("initPathDescription")
								: repoMode === "clone"
									? t("clonePathDescription")
									: t("repositoryPathDescription")
						}
						required
						disabled={isCloning}
					/>
					{isCloning && (
						<Stack gap="xs">
							<Text size="sm" fw={500}>
								{t("cloning")}
							</Text>
							{progressPercent != null && <Progress value={progressPercent} size="sm" animated />}
							<Code block style={{ fontSize: 12, maxHeight: 40, overflow: "hidden" }}>
								{createProjectStream.cloneProgress || "..."}
							</Code>
						</Stack>
					)}
					{createProjectStream.error && (
						<Text size="sm" c="red">
							{createProjectStream.error.message}
						</Text>
					)}
					<Button onClick={handleCreate} loading={createProject.isPending || isCloning}>
						{tc("create")}
					</Button>
				</Stack>
			</Modal>
		</Stack>
	);
}

/** Extract percentage from git clone progress lines like "Receiving objects:  42% (100/238)" */
function parseGitProgress(line: string): number | null {
	const match = line.match(/(\d+)%/);
	return match ? Number.parseInt(match[1], 10) : null;
}
