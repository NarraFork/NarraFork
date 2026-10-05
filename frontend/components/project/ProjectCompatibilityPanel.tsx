import { Alert, Button, Card, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectAccess } from "../../hooks/useProjectAccess";
import { useProject } from "../../hooks/useProjects";
import { ProjectAccessPanel } from "./ProjectAccessPanel";

const ProjectSettingsModal = lazy(() =>
	import("./ProjectSettingsModal").then((m) => ({ default: m.ProjectSettingsModal })),
);
const ProjectSkillsModal = lazy(() =>
	import("./ProjectSkillsModal").then((m) => ({ default: m.ProjectSkillsModal })),
);
const ProjectRoutinesModal = lazy(() =>
	import("./ProjectRoutinesModal").then((m) => ({ default: m.ProjectRoutinesModal })),
);
const ProjectCommandsModal = lazy(() =>
	import("./ProjectCommandsModal").then((m) => ({ default: m.ProjectCommandsModal })),
);

/** Reuses the original project storage and permission gate. No cwd-based project discovery. */
export function ProjectCompatibilityPanel({ projectId }: { projectId: string }) {
	const { t } = useTranslation("projects");
	const project = useProject(projectId);
	const access = useProjectAccess(projectId);
	const [editor, setEditor] = useState<"settings" | "skills" | "routines" | "commands" | null>(
		null,
	);
	const canManage = !access.isError && access.data?.canManage === true;
	const close = () => setEditor(null);
	if (project.isLoading) return <Loader size="sm" />;
	if (project.isError || !project.data)
		return <Alert color="red">{t("compatibility.unavailable")}</Alert>;
	const source = project.data;
	return (
		<Stack>
			<Card withBorder>
				<Stack gap="sm">
					<Title order={4}>{t("compatibility.title")}</Title>
					<Text>{t("compatibility.source", { name: source.name })}</Text>
					<Text size="sm" c="dimmed">
						{t("compatibility.storageUnchanged")}
					</Text>
					<Text size="sm" c="dimmed">
						{t(canManage ? "compatibility.manage" : "compatibility.readOnly")}
					</Text>
					{access.isError && <Alert color="red">{t("compatibility.accessUnavailable")}</Alert>}
					<Group>
						<Button variant="light" disabled={!canManage} onClick={() => setEditor("settings")}>
							{t("compatibility.settingsTraits")}
						</Button>
						<Button variant="light" disabled={!canManage} onClick={() => setEditor("skills")}>
							{t("skills")}
						</Button>
						<Button variant="light" disabled={!canManage} onClick={() => setEditor("routines")}>
							{t("routines")}
						</Button>
						<Button variant="light" disabled={!canManage} onClick={() => setEditor("commands")}>
							{t("commands")}
						</Button>
					</Group>
					<Group>
						<Button variant="subtle" component={Link} to="/settings/chapters">
							{t("compatibility.workspaceContainers")}
						</Button>
						<Button variant="subtle" component={Link} to="/settings/devices">
							{t("compatibility.devices")}
						</Button>
						<Button variant="subtle" component={Link} to="/knowledge">
							{t("compatibility.knowledge")}
						</Button>
					</Group>
					<Text size="xs" c="dimmed">
						{t("compatibility.instanceSource")}
					</Text>
				</Stack>
			</Card>
			<ProjectAccessPanel projectId={projectId} />
			{canManage && editor && (
				<Suspense fallback={<Loader size="sm" />}>
					{editor === "settings" && (
						<ProjectSettingsModal
							projectId={projectId}
							proxyDomain={source.proxyDomain}
							chapterSettings={source.chapterSettings}
							opened
							onClose={close}
						/>
					)}
					{editor === "skills" && (
						<ProjectSkillsModal projectId={projectId} opened onClose={close} />
					)}
					{editor === "routines" && (
						<ProjectRoutinesModal projectId={projectId} opened onClose={close} />
					)}
					{editor === "commands" && (
						<ProjectCommandsModal projectId={projectId} opened onClose={close} />
					)}
				</Suspense>
			)}
		</Stack>
	);
}
