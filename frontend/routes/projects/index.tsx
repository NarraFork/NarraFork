import { statusRegistry } from "@frontend/lib/status-registry";
import {
	Alert,
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
import { IconAlertCircle } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DirectoryPicker } from "../../components/common/DirectoryPicker";
import { usePlatform } from "../../hooks/usePlatform";
import { useCreateProject, useCreateProjectStream, useProjects } from "../../hooks/useProjects";
import { useSetupWizardGuard } from "../../hooks/useSetupWizardGuard";

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
	const [flowMode, setFlowMode] = useState<string>("classic");
	const [repoPath, setRepoPath] = useState("");
	const [repoPathError, setRepoPathError] = useState("");
	const [cloneUrl, setCloneUrl] = useState("");
	const [cloneUrlError, setCloneUrlError] = useState("");
	const [cloneBranch, setCloneBranch] = useState("");
	const { t } = useTranslation("projects");
	const { t: tc } = useTranslation("common");
	const platform = usePlatform();

	const requireSetup = useSetupWizardGuard();
	const guardedOpen = () => {
		if (!requireSetup()) return;
		open();
	};

	const pathPlaceholder =
		platform === "windows" ? "E:\\Code\\my-repo" : "/home/user/projects/my-repo";

	const isCloning = createProjectStream.isPending;

	const resetForm = () => {
		setName("");
		setNameError("");
		setRepoMode("existing");
		setFlowMode("classic");
		setRepoPath("");
		setRepoPathError("");
		setCloneUrl("");
		setCloneUrlError("");
		setCloneBranch("");
		createProjectStream.reset();
		createProject.reset();
	};

	const handleClose = () => {
		if (!isCloning) {
			close();
			resetForm();
		}
	};

	// Detect "not a git repo" error from existing mode — offer to init instead
	const isNotGitRepoError = createProject.error?.message?.includes("not a git repository") ?? false;

	const handleInitAndCreate = () => {
		createProject.reset();
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const data: Record<string, any> = {
			name: name.trim(),
			repoMode: "init",
			gitPath: repoPath.trim() || undefined,
		};
		createProject.mutate(data, {
			onSuccess: () => {
				close();
				resetForm();
			},
		});
	};

	const handleCreate = () => {
		// Clear previous errors
		createProject.reset();
		createProjectStream.reset();

		// Validate
		let hasError = false;
		if (!name.trim()) {
			setNameError(t("projectNameRequired"));
			hasError = true;
		}
		if (!repoPath.trim()) {
			setRepoPathError(t("repoPathRequired"));
			hasError = true;
		}
		if (repoMode === "clone" && !cloneUrl.trim()) {
			setCloneUrlError(t("cloneUrlRequired"));
			hasError = true;
		}
		if (hasError) return;

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const data: Record<string, any> = {
			name: name.trim(),
			repoMode,
			flowMode,
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

	// Unified error from either mutation
	const mutationError = createProjectStream.error ?? createProject.error;

	if (isLoading) return <Loader />;

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={2}>{t("title")}</Title>
				<Button onClick={guardedOpen}>{t("newProject")}</Button>
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
							onChange={(val) => {
								setRepoMode(val);
								createProject.reset();
								createProjectStream.reset();
							}}
							data={[
								{ value: "existing", label: t("repoModeExisting") },
								{ value: "init", label: t("repoModeInit") },
								{ value: "clone", label: t("repoModeClone") },
							]}
							disabled={isCloning}
						/>
						<Text size="xs" c="dimmed" mt={4}>
							{repoMode === "existing"
								? t("repoModeExistingDesc")
								: repoMode === "init"
									? t("repoModeInitDesc")
									: t("repoModeCloneDesc")}
						</Text>
					</div>
					<div>
						<Text size="sm" fw={500} mb={4}>
							{t("flowMode", "Flow Mode")}
						</Text>
						<SegmentedControl
							fullWidth
							value={flowMode}
							onChange={setFlowMode}
							data={[
								{ value: "classic", label: t("flowModeClassic", "Classic") },
								{ value: "ruler", label: t("flowModeRuler", "Ruler") },
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
								onChange={(e) => {
									setCloneUrl(e.currentTarget.value);
									if (cloneUrlError) setCloneUrlError("");
								}}
								error={cloneUrlError}
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
						onChange={(val) => {
							setRepoPath(val);
							if (repoPathError) setRepoPathError("");
						}}
						description={
							repoMode === "init"
								? t("initPathDescription")
								: repoMode === "clone"
									? t("clonePathDescription")
									: t("repositoryPathDescription")
						}
						error={repoPathError}
						required
						disabled={isCloning}
					/>
					{isCloning && (
						<Stack gap="xs">
							<Text size="sm" fw={500}>
								{t("cloning")}
							</Text>
							{progressPercent != null && <Progress value={progressPercent} size="sm" animated />}
							<Code block style={{ fontSize: 12, maxHeight: 80, overflow: "auto" }}>
								{createProjectStream.cloneProgress || "..."}
							</Code>
						</Stack>
					)}
					{isNotGitRepoError && (
						<Alert icon={<IconAlertCircle size={16} />} title={t("notGitRepoTitle")} color="yellow">
							<Text size="sm">{t("notGitRepoMessage", { path: repoPath.trim() })}</Text>
							<Button
								size="xs"
								mt="sm"
								onClick={handleInitAndCreate}
								loading={createProject.isPending}
							>
								{t("notGitRepoInitAndCreate")}
							</Button>
						</Alert>
					)}
					{mutationError && !isNotGitRepoError && (
						<Alert icon={<IconAlertCircle size={16} />} color="red">
							<Text size="sm">{mutationError.message}</Text>
						</Alert>
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
