import { NarratorPanel } from "@frontend/components/narrator/NarratorPanel";
import { ProjectSessionList } from "@frontend/components/project/ProjectSessionList";
import { ProjectSummaryCard } from "@frontend/components/project/ProjectSummaryCard";
import { useProject, useProjects } from "@frontend/hooks/useProjects";
import { clearToken, endSession, getToken, onTokenChange } from "@frontend/lib/api/client";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { queryClient } from "@frontend/lib/query-client";
import {
	Alert,
	Box,
	Button,
	Group,
	Loader,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import {
	createRootRoute,
	createRoute,
	Link,
	Navigate,
	Outlet,
	useParams,
} from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { RemoteLoginPage } from "./LoginPage";
import { clearRemoteRuntime, isRemoteSessionAuthenticated, remoteIdentity } from "./runtime";

function useSession() {
	return useSyncExternalStore(onTokenChange, getToken, () => null);
}
function Unsupported() {
	const { t } = useTranslation("remote");
	return <Alert>{t("unsupported")}</Alert>;
}
function Shell() {
	const { t } = useTranslation("remote");
	const token = useSession();
	const [closed, setClosed] = useState(false);
	const [connectionState, setConnectionState] = useState("paired");
	useEffect(() => {
		const ended = () => {
			clearToken();
			narratorWSManager.disconnect();
			queryClient.clear();
			setClosed(true);
		};
		const changed = (event: Event) => {
			const state = (event as CustomEvent<string>).detail;
			if (
				["connecting", "paired", "authenticating", "ready", "recovering", "failed"].includes(state)
			)
				setConnectionState(state);
		};
		window.addEventListener("narrafork:remote-session-ended", ended);
		window.addEventListener("narrafork:remote-state", changed);
		return () => {
			window.removeEventListener("narrafork:remote-session-ended", ended);
			window.removeEventListener("narrafork:remote-state", changed);
		};
	}, []);
	useEffect(() => {
		if (!token || !isRemoteSessionAuthenticated()) return;
		narratorWSManager.connect();
		return () => narratorWSManager.disconnect();
	}, [token]);
	if (closed)
		return (
			<Alert color="yellow">
				<Stack align="flex-start" gap="sm">
					<Text>{t("sessionEnded")}</Text>
					<Button onClick={() => window.location.reload()}>{t("reconnect")}</Button>
				</Stack>
			</Alert>
		);
	return (
		<Stack h="100dvh" gap={0}>
			<Group
				justify="space-between"
				p="xs"
				style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-default-border)" }}
			>
				<Group>
					<Text fw={600}>{t("title")}</Text>
					<Text size="xs" role="status">
						{t(connectionState)}
					</Text>
					<Text size="xs" c="dimmed">
						{remoteIdentity().nfVersion}
					</Text>
				</Group>
				{token && (
					<Group>
						<Link to="/projects">{t("projects")}</Link>
						<Button
							size="xs"
							variant="subtle"
							onClick={async () => {
								try {
									await endSession();
								} finally {
									clearToken();
									narratorWSManager.disconnect();
									queryClient.clear();
									clearRemoteRuntime();
									setClosed(true);
								}
							}}
						>
							{t("logout")}
						</Button>
					</Group>
				)}
			</Group>
			<Box style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
				<Outlet />
			</Box>
		</Stack>
	);
}
function RequireSession() {
	const token = useSession();
	return token && isRemoteSessionAuthenticated() ? <Outlet /> : <Navigate to="/login" replace />;
}
function Login() {
	const token = useSession();
	return token && isRemoteSessionAuthenticated() ? (
		<Navigate to="/projects" replace />
	) : (
		<RemoteLoginPage />
	);
}
function Projects() {
	const { t } = useTranslation("remote");
	const { data, isPending, isError } = useProjects();
	const [filter, setFilter] = useState("");
	const [limit, setLimit] = useState(200);
	const rows =
		data?.filter((project) =>
			`${project.name ?? ""}\n${project.description ?? ""}`
				.toLowerCase()
				.includes(filter.toLowerCase()),
		) ?? [];
	return (
		<Stack p="md">
			<Title order={2}>{t("projects")}</Title>
			<TextInput
				aria-label={t("projects")}
				value={filter}
				onChange={(event) => {
					setFilter(event.currentTarget.value);
					setLimit(200);
				}}
			/>
			{isPending && <Loader />}
			{isError && <Alert color="red">{t("failed")}</Alert>}
			<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
				{rows.slice(0, limit).map((project) => (
					<ProjectSummaryCard key={project.id} project={project} />
				))}
			</SimpleGrid>
			{!isPending && !isError && !rows.length && <Text>{t("empty")}</Text>}
			{rows.length > limit && (
				<Button onClick={() => setLimit((value) => value + 200)}>{t("loadMore")}</Button>
			)}
		</Stack>
	);
}
function Project() {
	const { projectId } = useParams({ strict: false });
	const { t } = useTranslation("remote");
	const project = useProject(projectId ?? "");
	if (!projectId || project.isError) return <Alert color="red">{t("failed")}</Alert>;
	return (
		<Stack p="md">
			<Title order={2}>{project.data?.name ?? t("loading")}</Title>
			<Text size="sm" c="dimmed">
				{project.data?.gitPath}
			</Text>
			<Text>{project.data?.description}</Text>
			<ProjectSessionList projectId={projectId} enabled={!project.isError} />
		</Stack>
	);
}
function Narrator() {
	const { narratorId } = useParams({ strict: false });
	return narratorId ? (
		<Box h="100%" style={{ minHeight: 0 }}>
			<NarratorPanel narratorId={narratorId} />
		</Box>
	) : (
		<Unsupported />
	);
}
const root = createRootRoute({
	component: Shell,
	notFoundComponent: Unsupported,
	errorComponent: Unsupported,
});
const index = createRoute({
	getParentRoute: () => root,
	path: "/",
	component: () => <Navigate to="/projects" replace />,
});
const login = createRoute({ getParentRoute: () => root, path: "login", component: Login });
const guarded = createRoute({
	getParentRoute: () => root,
	id: "authenticated",
	component: RequireSession,
});
const projects = createRoute({
	getParentRoute: () => guarded,
	path: "projects",
	component: Projects,
});
const project = createRoute({
	getParentRoute: () => guarded,
	path: "projects/$projectId",
	component: Project,
});
const narrator = createRoute({
	getParentRoute: () => guarded,
	path: "narrators/$narratorId",
	component: Narrator,
});
const unsupported = createRoute({
	getParentRoute: () => root,
	path: "unsupported",
	component: Unsupported,
});
export const remoteRouteTree = root.addChildren([
	index,
	login,
	guarded.addChildren([projects, project, narrator]),
	unsupported,
]);
