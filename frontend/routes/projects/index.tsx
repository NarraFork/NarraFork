import { MobileNavButton } from "@frontend/components/nav/MobileNavButton";
import { ProjectListCard } from "@frontend/components/project/ProjectListCard";
import { sortProjects } from "@frontend/components/project/project-page-model";
import {
	Alert,
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
import { IconAlertCircle, IconPlus, IconSearch } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePlatform } from "../../hooks/usePlatform";
import { useProjectSummaries } from "../../hooks/useProjectOverview";
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
			spacing="sm"
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
	// One request for every card's numbers (running sessions, teams, waiting, last activity).
	const summaries = useProjectSummaries(!!projects?.length);
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
	const summaryMap = useMemo(
		() => new Map((summaries.data?.summaries ?? []).map((row) => [row.projectId, row])),
		[summaries.data],
	);
	// Waiting on you first, then the most recent activity.
	const sortedProjects = useMemo(
		() =>
			sortProjects(
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				filteredProjects.map((project: any) => ({ ...project, id: String(project.id) })),
				summaryMap,
			),
		[filteredProjects, summaryMap],
	);
	const displayedProjects = sortedProjects.slice(0, PROJECT_LIST_RENDER_LIMIT);
	const hiddenProjectCount = Math.max(0, sortedProjects.length - displayedProjects.length);
	const now = new Date();

	// Parse git clone progress for a progress bar
	const progressPercent = parseGitProgress(createProjectStream.cloneProgress);

	// Unified error from either mutation
	const mutationError = createProjectStream.error ?? createProject.error;

	return (
		<Stack gap="md" data-testid="project-list">
			<Stack gap={6}>
				<Group justify="space-between" wrap="wrap" gap="sm">
					<Group gap="xs" wrap="nowrap">
						<MobileNavButton />
						<Title order={2}>{t("title")}</Title>
						{!!projects?.length && (
							<Text c="dimmed" size="lg" style={{ fontVariantNumeric: "tabular-nums" }}>
								{projects.length}
							</Text>
						)}
					</Group>
					<Group gap="xs" wrap="nowrap" style={{ flex: "1 1 260px", justifyContent: "flex-end" }}>
						{!!projects?.length && (
							<TextInput
								placeholder={t("projectSearchPlaceholder")}
								value={projectFilter}
								leftSection={<IconSearch size={14} aria-hidden />}
								onChange={(event) => setProjectFilter(event.currentTarget.value)}
								style={{ flex: "1 1 auto", maxWidth: 260 }}
								aria-label={t("projectSearchPlaceholder")}
							/>
						)}
						<Button
							variant="default"
							leftSection={<IconPlus size={14} aria-hidden />}
							onClick={guardedOpen}
							style={{ flexShrink: 0 }}
						>
							{t("newProject")}
						</Button>
					</Group>
				</Group>
				{!!projects?.length && (
					<Text size="sm" c="dimmed">
						{t("list.subtitle")}
					</Text>
				)}
			</Stack>

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
					{filteredProjects.length === 0 ? (
						<Text c="dimmed">{t("noProjectMatches")}</Text>
					) : (
						<>
							<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
								{displayedProjects.map((project) => (
									<ProjectListCard
										key={project.id}
										project={{
											id: project.id,
											name: String(project.name ?? ""),
											gitPath: project.gitPath ? String(project.gitPath) : null,
											status: project.status ? String(project.status) : null,
											updatedAt: project.updatedAt ? String(project.updatedAt) : null,
										}}
										summary={summaryMap.get(project.id)}
										now={now}
									/>
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
						{/* Suggestions open upwards: the dialog's Create button sits right below. */}
						<DirectoryPicker
							label={t("repositoryPath")}
							placeholder={pathPlaceholder}
							value={repoPath}
							onChange={handleRepoPathChange}
							description={repoPathDescription}
							error={repoPathError}
							required
							disabled={isCloning}
							dropdownPosition="top"
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
