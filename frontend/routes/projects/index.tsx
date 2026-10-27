import { statusRegistry } from "@frontend/lib/status-registry";
import {
	Alert,
	Badge,
	Button,
	Card,
	Code,
	Group,
	Modal,
	PasswordInput,
	Progress,
	SegmentedControl,
	SimpleGrid,
	Skeleton,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconAlertCircle } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePlatform } from "../../hooks/usePlatform";
import {
	useCreateProject,
	useCreateProjectStream,
	useHiddenProjectExistence,
	useProjects,
} from "../../hooks/useProjects";
import { useSetupWizardGuard } from "../../hooks/useSetupWizardGuard";
import { normalizeUrlProtocol } from "../../lib/url";

const DirectoryPicker = lazy(() =>
	import("../../components/common/DirectoryPicker").then((module) => ({
		default: module.DirectoryPicker,
	})),
);
const PROJECT_LIST_RENDER_LIMIT = 200;

export const Route = createFileRoute("/projects/")({
	component: ProjectListPage,
});

function ProjectGridSkeleton() {
	return (
		<SimpleGrid
			cols={{ base: 1, sm: 2, lg: 3 }}
			aria-busy="true"
			data-testid="project-list-skeleton"
		>
			{["first", "second", "third"].map((key) => (
				<Card key={key} padding="lg" radius="md" withBorder>
					<Skeleton height={22} width="62%" />
					<Skeleton height={14} mt="md" width="88%" />
				</Card>
			))}
		</SimpleGrid>
	);
}

function ProjectListPage() {
	const { data: projects, isLoading } = useProjects();
	// Only probed when the list is empty: it exists purely to tell "no projects yet"
	// apart from "none of them are yours".
	const hiddenProjects = useHiddenProjectExistence(!isLoading && !projects?.length);
	const createProject = useCreateProject();
	const createProjectStream = useCreateProjectStream();
	const [opened, { open, close }] = useDisclosure(false);
	const [name, setName] = useState("");
	const [nameError, setNameError] = useState("");
	const [repoMode, setRepoMode] = useState<string>("existing");
	const [repoPath, setRepoPath] = useState("");
	const [repoPathError, setRepoPathError] = useState("");
	const [cloneUrl, setCloneUrl] = useState("");
	const [cloneUrlError, setCloneUrlError] = useState("");
	const [cloneBranch, setCloneBranch] = useState("");
	const [cloneUsername, setCloneUsername] = useState("");
	const [clonePassword, setClonePassword] = useState("");
	const [projectFilter, setProjectFilter] = useState("");
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
	const repoPathDescription =
		repoMode === "init"
			? t("initPathDescription")
			: repoMode === "clone"
				? t("clonePathDescription")
				: t("repositoryPathDescription");

	const handleRepoPathChange = (val: string) => {
		setRepoPath(val);
		if (repoPathError) setRepoPathError("");
	};

	const resetForm = () => {
		setName("");
		setNameError("");
		setRepoMode("existing");
		setRepoPath("");
		setRepoPathError("");
		setCloneUrl("");
		setCloneUrlError("");
		setCloneBranch("");
		setCloneUsername("");
		setClonePassword("");
		createProjectStream.reset();
		createProject.reset();
	};

	const handleClose = () => {
		if (!isCloning) {
			close();
			resetForm();
		}
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
			gitPath: repoPath.trim() || undefined,
		};

		if (repoMode === "clone") {
			const normalizedCloneUrl = normalizeUrlProtocol(cloneUrl) ?? "";
			setCloneUrl(normalizedCloneUrl);
			data.cloneUrl = normalizedCloneUrl || undefined;
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

	const normalizedProjectFilter = projectFilter.trim().toLowerCase();
	const filteredProjects = useMemo(() => {
		if (!projects?.length) return [];
		if (!normalizedProjectFilter) return projects;
		return projects.filter((project) => {
			const haystack = `${project.name ?? ""}\n${project.description ?? ""}\n${project.gitPath ?? ""}`;
			return haystack.toLowerCase().includes(normalizedProjectFilter);
		});
	}, [normalizedProjectFilter, projects]);
	const displayedProjects = filteredProjects.slice(0, PROJECT_LIST_RENDER_LIMIT);
	const hiddenProjectCount = Math.max(0, filteredProjects.length - displayedProjects.length);
	const showProjectFilter = (projects?.length ?? 0) > PROJECT_LIST_RENDER_LIMIT || !!projectFilter;

	// Parse git clone progress for a progress bar
	const progressPercent = parseGitProgress(createProjectStream.cloneProgress);

	// Unified error from either mutation
	const mutationError = createProjectStream.error ?? createProject.error;

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={2}>{t("title")}</Title>
				<Button onClick={guardedOpen}>{t("newProject")}</Button>
			</Group>

			{isLoading ? (
				<ProjectGridSkeleton />
			) : !projects?.length ? (
				// Two different empty states: telling a user who simply has not been added to
				// any project to "create one" sends them down the wrong path.
				<Text c="dimmed">
					{hiddenProjects.data?.hasHidden ? t("noProjectsVisible") : t("noProjects")}
				</Text>
			) : (
				<Stack gap="sm">
					{showProjectFilter && (
						<TextInput
							placeholder={t("projectSearchPlaceholder")}
							value={projectFilter}
							onChange={(event) => setProjectFilter(event.currentTarget.value)}
						/>
					)}
					{filteredProjects.length === 0 ? (
						<Text c="dimmed">{t("noProjectMatches")}</Text>
					) : (
						<>
							<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
								{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
								{displayedProjects.map((project: any) => (
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
							{hiddenProjectCount > 0 && (
								<Text size="sm" c="dimmed" ta="center">
									{t("projectListTruncated", {
										shown: displayedProjects.length,
										hidden: hiddenProjectCount,
									})}
								</Text>
							)}
						</>
					)}
				</Stack>
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
					<Suspense
						fallback={
							<TextInput
								label={t("repositoryPath")}
								placeholder={pathPlaceholder}
								value={repoPath}
								onChange={(e) => handleRepoPathChange(e.currentTarget.value)}
								description={repoPathDescription}
								error={repoPathError}
								required
								disabled={isCloning}
							/>
						}
					>
						<DirectoryPicker
							label={t("repositoryPath")}
							placeholder={pathPlaceholder}
							value={repoPath}
							onChange={handleRepoPathChange}
							description={repoPathDescription}
							error={repoPathError}
							required
							disabled={isCloning}
						/>
					</Suspense>
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
					{createProjectStream.needsAuth && !isCloning && (
						<Alert icon={<IconAlertCircle size={16} />} title={t("authRequired")} color="yellow">
							<Stack gap="xs" mt="xs">
								<Text size="sm">{t("authRequiredMessage")}</Text>
								<TextInput
									label={t("authUsername")}
									placeholder={t("authUsernamePlaceholder")}
									value={cloneUsername}
									onChange={(e) => setCloneUsername(e.currentTarget.value)}
									size="sm"
								/>
								<PasswordInput
									label={t("authPassword")}
									placeholder={t("authPasswordPlaceholder")}
									value={clonePassword}
									autoComplete="off"
									onChange={(e) => setClonePassword(e.currentTarget.value)}
									size="sm"
								/>
								<Button
									size="xs"
									mt="xs"
									onClick={() => {
										createProjectStream.retryWithCredentials(cloneUsername, clonePassword);
									}}
									disabled={!cloneUsername.trim()}
								>
									{t("authRetry")}
								</Button>
							</Stack>
						</Alert>
					)}
					{mutationError && !createProjectStream.needsAuth && (
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
