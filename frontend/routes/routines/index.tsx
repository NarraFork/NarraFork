import {
	ActionIcon,
	Badge,
	Button,
	Collapse,
	Container,
	Group,
	Modal,
	Paper,
	SegmentedControl,
	Select,
	Stack,
	Switch,
	Tabs,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconChevronDown,
	IconChevronRight,
	IconPlug,
	IconPlugOff,
	IconPlus,
	IconTrash,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { type CommandDef, CommandsEditor } from "../../components/common/CommandsEditor";
import {
	useConnectMcpServer,
	useCreateMcpServer,
	useDeleteMcpServer,
	useDisconnectMcpServer,
	useImportMcpServers,
	useMcpServers,
	useTestMcpConnection,
	useUpdateMcpServer,
} from "../../hooks/useMcp";
import { useProjects } from "../../hooks/useProjects";
import {
	useCreateGlobalSkill,
	useDeleteGlobalSkill,
	useGlobalSkills,
	useSkills,
	useUpdateGlobalSkill,
} from "../../hooks/useSkills";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";

export const Route = createFileRoute("/routines/")({
	component: RoutinesPage,
});

// === Helpers ===

function getSourceLabel(location: string): string {
	if (location.includes("/.narrafork/")) return ".narrafork";
	if (location.includes("/.claude/")) return ".claude";
	if (location.includes("/.agents/")) return ".agents";
	return "other";
}

function getSourceColor(source: string): string {
	if (source === ".narrafork") return "indigo";
	if (source === ".claude") return "violet";
	if (source === ".agents") return "teal";
	return "gray";
}

// === Skill type for list items ===
interface SkillSummary {
	name: string;
	description: string;
	location: string;
	files: string[];
}

// === Main Page ===

function RoutinesPage() {
	const { t } = useTranslation("routines");

	return (
		<Container size="md" py="lg">
			<Stack gap="xs" mb="md">
				<Title order={2}>{t("title")}</Title>
				<Text size="sm" c="dimmed">
					{t("subtitle")}
				</Text>
			</Stack>

			<Tabs defaultValue="commands" keepMounted={false}>
				<Tabs.List mb="md">
					<Tabs.Tab value="commands">{t("tabCommands")}</Tabs.Tab>
					<Tabs.Tab value="global-skills">{t("tabGlobalSkills")}</Tabs.Tab>
					<Tabs.Tab value="project-skills">{t("tabProjectSkills")}</Tabs.Tab>
					<Tabs.Tab value="mcp-tools">{t("tabMcpTools")}</Tabs.Tab>
				</Tabs.List>

				<Tabs.Panel value="commands">
					<CommandsTab />
				</Tabs.Panel>
				<Tabs.Panel value="global-skills">
					<GlobalSkillsTab />
				</Tabs.Panel>
				<Tabs.Panel value="project-skills">
					<ProjectSkillsTab />
				</Tabs.Panel>
				<Tabs.Panel value="mcp-tools">
					<McpToolsTab />
				</Tabs.Panel>
			</Tabs>
		</Container>
	);
}

// === Tab 1: Commands ===

function CommandsTab() {
	const { t } = useTranslation("routines");
	const { data: userPrefs } = useUserPreferences();
	const updateUserPref = useUpdateUserPreferences();

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("commandsDesc")}
			</Text>
			<CommandsEditor
				commands={(userPrefs?.commands ?? []) as CommandDef[]}
				onChange={(cmds) => updateUserPref.mutate({ commands: cmds })}
			/>
		</Stack>
	);
}

// === Tab 2: Global Skills ===

interface SkillDraft {
	name: string;
	description: string;
	content: string;
}

function GlobalSkillsTab() {
	const { t } = useTranslation("routines");
	const { data: skills, isLoading } = useGlobalSkills();
	const createMutation = useCreateGlobalSkill();
	const updateMutation = useUpdateGlobalSkill();
	const deleteMutation = useDeleteGlobalSkill();

	const [editOpened, { open: openEdit, close: closeEdit }] = useDisclosure(false);
	const [deleteOpened, { open: openDelete, close: closeDelete }] = useDisclosure(false);
	const [viewOpened, { open: openView, close: closeView }] = useDisclosure(false);

	const [editingSkill, setEditingSkill] = useState<string | null>(null); // null = create
	const [draft, setDraft] = useState<SkillDraft>({ name: "", description: "", content: "" });
	const [deleteTarget, setDeleteTarget] = useState<string>("");
	const [viewTarget, setViewTarget] = useState<SkillSummary | null>(null);

	const handleCreate = useCallback(() => {
		setEditingSkill(null);
		setDraft({ name: "", description: "", content: "" });
		openEdit();
	}, [openEdit]);

	const handleEdit = useCallback(
		(skill: SkillSummary) => {
			setEditingSkill(skill.name);
			setDraft({ name: skill.name, description: skill.description, content: "" });
			// Fetch full content
			api.getGlobalSkill(skill.name).then((full) => {
				setDraft({ name: full.name, description: full.description, content: full.content });
			});
			openEdit();
		},
		[openEdit],
	);

	const handleSave = useCallback(() => {
		const data = {
			name: draft.name.trim(),
			description: draft.description.trim(),
			content: draft.content.trim(),
		};
		if (!data.name || !data.description) return;

		if (editingSkill) {
			updateMutation.mutate(
				{ currentName: editingSkill, ...data },
				{ onSuccess: () => closeEdit() },
			);
		} else {
			createMutation.mutate(data, { onSuccess: () => closeEdit() });
		}
	}, [draft, editingSkill, createMutation, updateMutation, closeEdit]);

	const handleDelete = useCallback(
		(name: string) => {
			setDeleteTarget(name);
			openDelete();
		},
		[openDelete],
	);

	const confirmDelete = useCallback(() => {
		deleteMutation.mutate(deleteTarget, { onSuccess: () => closeDelete() });
	}, [deleteTarget, deleteMutation, closeDelete]);

	const handleView = useCallback(
		(skill: SkillSummary) => {
			setViewTarget(skill);
			openView();
		},
		[openView],
	);

	return (
		<Stack>
			<Group justify="space-between">
				<Text size="sm" c="dimmed" style={{ flex: 1 }}>
					{t("globalSkillsDesc")}
				</Text>
				<Button
					size="xs"
					variant="light"
					leftSection={<IconPlus size={14} />}
					onClick={handleCreate}
				>
					{t("createSkill")}
				</Button>
			</Group>

			{isLoading && (
				<Text size="sm" c="dimmed">
					Loading...
				</Text>
			)}

			{!isLoading && (!skills || skills.length === 0) && (
				<Text size="sm" c="dimmed">
					{t("noGlobalSkills")}
				</Text>
			)}

			{skills?.map((skill) => {
				const source = getSourceLabel(skill.location);
				return (
					<Paper key={skill.name} withBorder p="sm">
						<Group justify="space-between" wrap="nowrap">
							<div style={{ flex: 1, minWidth: 0 }}>
								<Group gap="xs">
									<Text size="sm" fw={600}>
										{skill.name}
									</Text>
									<Badge size="xs" variant="light" color={getSourceColor(source)}>
										{source}
									</Badge>
								</Group>
								<Text size="xs" c="dimmed" truncate="end">
									{skill.description}
								</Text>
							</div>
							<Group gap={4}>
								<Button variant="subtle" size="compact-xs" onClick={() => handleView(skill)}>
									{t("viewSkill")}
								</Button>
								<Button variant="subtle" size="compact-xs" onClick={() => handleEdit(skill)}>
									{t("editSkill")}
								</Button>
								<ActionIcon
									variant="subtle"
									color="red"
									size="sm"
									onClick={() => handleDelete(skill.name)}
								>
									<IconTrash size={14} />
								</ActionIcon>
							</Group>
						</Group>
					</Paper>
				);
			})}

			{/* Create / Edit Modal */}
			<Modal
				opened={editOpened}
				onClose={closeEdit}
				title={editingSkill ? t("editSkill") : t("createSkill")}
				size="lg"
			>
				<Stack>
					<TextInput
						label={t("skillName")}
						placeholder={t("skillNamePlaceholder")}
						value={draft.name}
						onChange={(e) => setDraft((d) => ({ ...d, name: e.currentTarget.value }))}
					/>
					<TextInput
						label={t("skillDescription")}
						placeholder={t("skillDescriptionPlaceholder")}
						value={draft.description}
						onChange={(e) => setDraft((d) => ({ ...d, description: e.currentTarget.value }))}
					/>
					<Textarea
						label={t("skillContent")}
						placeholder={t("skillContentPlaceholder")}
						value={draft.content}
						onChange={(e) => setDraft((d) => ({ ...d, content: e.currentTarget.value }))}
						autosize
						minRows={8}
						maxRows={20}
					/>
					<Group justify="flex-end" gap="xs">
						<Button variant="subtle" onClick={closeEdit}>
							{t("cancel")}
						</Button>
						<Button
							onClick={handleSave}
							disabled={!draft.name.trim() || !draft.description.trim()}
							loading={createMutation.isPending || updateMutation.isPending}
						>
							{t("save")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			{/* Delete Confirm Modal */}
			<Modal
				opened={deleteOpened}
				onClose={closeDelete}
				title={t("deleteConfirmTitle")}
				size="sm"
				centered
			>
				<Stack>
					<Text size="sm">{t("deleteConfirm", { name: deleteTarget })}</Text>
					<Group justify="flex-end" gap="xs">
						<Button variant="subtle" onClick={closeDelete}>
							{t("cancel")}
						</Button>
						<Button color="red" onClick={confirmDelete} loading={deleteMutation.isPending}>
							{t("deleteSkill")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			{/* View Modal */}
			<Modal opened={viewOpened} onClose={closeView} title={viewTarget?.name ?? ""} size="lg">
				{viewTarget && (
					<Stack>
						<Text size="sm" c="dimmed">
							{viewTarget.description}
						</Text>
						<Text size="xs" c="dimmed">
							{t("skillLocation")}: {viewTarget.location}
						</Text>
						{viewTarget.files.length > 0 && (
							<Text size="xs" c="dimmed">
								Files: {viewTarget.files.join(", ")}
							</Text>
						)}
					</Stack>
				)}
			</Modal>
		</Stack>
	);
}

// === Tab 3: Project Skills ===

function ProjectSkillsTab() {
	const { t } = useTranslation("routines");
	const { data: projects } = useProjects();
	const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
	const { data: skills, isLoading } = useSkills(selectedProjectId ?? "", !!selectedProjectId);
	const { data: globalSkills } = useGlobalSkills();

	const globalNames = new Set(globalSkills?.map((s) => s.name) ?? []);

	const projectOptions =
		projects?.map((p: { id: string; name: string }) => ({
			value: p.id,
			label: p.name,
		})) ?? [];

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("projectSkillsDesc")}
			</Text>
			<Select
				placeholder={t("selectProject")}
				data={projectOptions}
				value={selectedProjectId}
				onChange={setSelectedProjectId}
				searchable
				clearable
			/>

			{!selectedProjectId && (
				<Text size="sm" c="dimmed">
					{t("noProjectSelected")}
				</Text>
			)}

			{selectedProjectId && isLoading && (
				<Text size="sm" c="dimmed">
					Loading...
				</Text>
			)}

			{selectedProjectId && !isLoading && (!skills || skills.length === 0) && (
				<Text size="sm" c="dimmed">
					{t("noProjectSkills")}
				</Text>
			)}

			{skills?.map((skill) => {
				const source = getSourceLabel(skill.location);
				const overridesGlobal = globalNames.has(skill.name);
				return (
					<Paper key={skill.name} withBorder p="sm">
						<div style={{ minWidth: 0 }}>
							<Group gap="xs">
								<Text size="sm" fw={600}>
									{skill.name}
								</Text>
								<Badge size="xs" variant="light" color={getSourceColor(source)}>
									{source}
								</Badge>
								{overridesGlobal && (
									<Badge size="xs" variant="outline" color="yellow">
										{t("overriddenByProject")}
									</Badge>
								)}
							</Group>
							<Text size="xs" c="dimmed" truncate="end">
								{skill.description}
							</Text>
							<Text size="xs" c="dimmed" truncate="end" mt={2}>
								{skill.location}
							</Text>
						</div>
					</Paper>
				);
			})}
		</Stack>
	);
}

// === Tab 4: MCP Tools ===

interface McpServerDraft {
	name: string;
	transport: "stdio" | "streamable-http" | "sse";
	command: string;
	args: string;
	cwd: string;
	url: string;
	env: Array<{ key: string; value: string }>;
	headers: Array<{ key: string; value: string }>;
	enabled: boolean;
}

const EMPTY_DRAFT: McpServerDraft = {
	name: "",
	transport: "stdio",
	command: "",
	args: "",
	cwd: "",
	url: "",
	env: [],
	headers: [],
	enabled: true,
};

function statusColor(status: string): string {
	if (status === "connected") return "green";
	if (status === "connecting") return "yellow";
	if (status === "error") return "red";
	return "gray";
}

function McpToolsTab() {
	const { t } = useTranslation("routines");
	const { data: servers, isLoading } = useMcpServers();
	const createMutation = useCreateMcpServer();
	const updateMutation = useUpdateMcpServer();
	const deleteMutation = useDeleteMcpServer();
	const connectMutation = useConnectMcpServer();
	const disconnectMutation = useDisconnectMcpServer();
	const testMutation = useTestMcpConnection();

	const [editOpened, { open: openEdit, close: closeEdit }] = useDisclosure(false);
	const [deleteOpened, { open: openDelete, close: closeDelete }] = useDisclosure(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState<McpServerDraft>({ ...EMPTY_DRAFT });
	const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
	const [expandedServer, setExpandedServer] = useState<string | null>(null);

	// Import state
	const [importOpened, { open: openImport, close: closeImport }] = useDisclosure(false);
	const importMutation = useImportMcpServers();
	const [importJson, setImportJson] = useState("");
	const [importError, setImportError] = useState<string | null>(null);
	const [importResult, setImportResult] = useState<string | null>(null);

	// biome-ignore lint/suspicious/noExplicitAny: MCP tool response structure varies
		queryKey: ["mcp-tools"],
		retry: false,
	});
	// biome-ignore lint/suspicious/noExplicitAny: MCP tool list structure

	const handleImport = useCallback(() => {
		setImportError(null);
		setImportResult(null);
		let parsed: unknown;
		try {
			parsed = JSON.parse(importJson);
		} catch {
			setImportError(t("mcpImportInvalidJson"));
			return;
		}
		importMutation.mutate(parsed, {
			onSuccess: (data) => {
				setImportResult(t("mcpImportSuccess", { added: data.added, skipped: data.skipped }));
				setImportError(null);
				setImportJson("");
			},
			onError: (err) => {
				setImportError(
					t("mcpImportError", { error: err instanceof Error ? err.message : String(err) }),
				);
				setImportResult(null);
			},
		});
	}, [importJson, importMutation, t]);

	const handleCreate = useCallback(() => {
		setEditingId(null);
		setDraft({ ...EMPTY_DRAFT });
		testMutation.reset();
		openEdit();
	}, [openEdit, testMutation]);

	const handleEditServer = useCallback(
		(server: {
			id: string;
			name?: string;
			transport?: string;
			command?: string;
			args?: string[];
			cwd?: string;
			url?: string;
			env?: Record<string, string>;
			headers?: Record<string, string>;
			enabled?: boolean;
		}) => {
			setEditingId(server.id);
			setDraft({
				name: server.name ?? "",
				transport: (server.transport as McpServerDraft["transport"]) ?? "stdio",
				command: server.command ?? "",
				args: Array.isArray(server.args) ? server.args.join("\n") : "",
				cwd: server.cwd ?? "",
				url: server.url ?? "",
				env: server.env
					? Object.entries(server.env).map(([key, value]) => ({
							key,
							value: value as string,
						}))
					: [],
				headers: server.headers
					? Object.entries(server.headers).map(([key, value]) => ({
							key,
							value: value as string,
						}))
					: [],
				enabled: server.enabled ?? true,
			});
			testMutation.reset();
			openEdit();
		},
		[openEdit, testMutation],
	);

	const draftToPayload = useCallback((d: McpServerDraft) => {
		const payload: Record<string, unknown> = {
			name: d.name.trim(),
			transport: d.transport,
			enabled: d.enabled,
		};
		if (d.transport === "stdio") {
			payload.command = d.command.trim();
			payload.args = d.args
				.split("\n")
				.map((a) => a.trim())
				.filter(Boolean);
			if (d.cwd.trim()) payload.cwd = d.cwd.trim();
		} else {
			payload.url = d.url.trim();
			const hdrs = d.headers.filter((h) => h.key.trim());
			if (hdrs.length > 0) {
				payload.headers = Object.fromEntries(hdrs.map((h) => [h.key.trim(), h.value]));
			}
		}
		const envEntries = d.env.filter((e) => e.key.trim());
		if (envEntries.length > 0) {
			payload.env = Object.fromEntries(envEntries.map((e) => [e.key.trim(), e.value]));
		}
		return payload;
	}, []);

	const handleSave = useCallback(() => {
		const payload = draftToPayload(draft);
		if (!payload.name) return;

		if (editingId) {
			updateMutation.mutate({ id: editingId, ...payload }, { onSuccess: () => closeEdit() });
		} else {
			createMutation.mutate(payload, { onSuccess: () => closeEdit() });
		}
	}, [draft, editingId, createMutation, updateMutation, closeEdit, draftToPayload]);

	const handleTest = useCallback(() => {
		testMutation.mutate(draftToPayload(draft));
	}, [draft, testMutation, draftToPayload]);

	const handleDelete = useCallback(
		(id: string, name: string) => {
			setDeleteTarget({ id, name });
			openDelete();
		},
		[openDelete],
	);

	const confirmDelete = useCallback(() => {
		if (deleteTarget) {
			deleteMutation.mutate(deleteTarget.id, { onSuccess: () => closeDelete() });
		}
	}, [deleteTarget, deleteMutation, closeDelete]);

	return (
		<Stack>
			{/* External MCP Servers */}
			<Group justify="space-between">
				<Text size="sm" c="dimmed" style={{ flex: 1 }}>
					{t("mcpServersDesc")}
				</Text>
				<Group gap="xs">
					<Button
						size="xs"
						variant="subtle"
						onClick={() => {
							setImportJson("");
							setImportError(null);
							setImportResult(null);
							openImport();
						}}
					>
						{t("mcpImport")}
					</Button>
					<Button
						size="xs"
						variant="light"
						leftSection={<IconPlus size={14} />}
						onClick={handleCreate}
					>
						{t("addMcpServer")}
					</Button>
				</Group>
			</Group>

			{isLoading && (
				<Text size="sm" c="dimmed">
					Loading...
				</Text>
			)}

			{!isLoading && (!servers || servers.length === 0) && (
				<Text size="sm" c="dimmed">
					{t("mcpNoServers")}
				</Text>
			)}

			{servers?.map((server) => {
				const isExpanded = expandedServer === server.id;
				return (
					<Paper key={server.id} withBorder p="sm">
						<Stack gap="xs">
							<Group justify="space-between" wrap="nowrap">
								<Group
									gap="xs"
									style={{ cursor: "pointer", flex: 1 }}
									onClick={() => setExpandedServer(isExpanded ? null : server.id)}
								>
									{isExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
									<Text size="sm" fw={600}>
										{server.name}
									</Text>
									<Badge size="xs" variant="light" color={statusColor(server.status)}>
										{t(
											`mcpStatus${server.status.charAt(0).toUpperCase()}${server.status.slice(1)}` as "mcpStatusConnected",
										)}
									</Badge>
									<Badge size="xs" variant="outline">
										{server.transport}
									</Badge>
									{server.status === "connected" && (
										<Text size="xs" c="dimmed">
											{t("mcpToolCount", { count: server.tools.length })}
										</Text>
									)}
								</Group>
								<Group gap={4}>
									{server.status === "connected" ? (
										<ActionIcon
											variant="subtle"
											size="sm"
											color="orange"
											onClick={() => disconnectMutation.mutate(server.id)}
											loading={disconnectMutation.isPending}
											title={t("mcpDisconnect")}
										>
											<IconPlugOff size={14} />
										</ActionIcon>
									) : (
										<ActionIcon
											variant="subtle"
											size="sm"
											color="green"
											onClick={() => connectMutation.mutate(server.id)}
											loading={connectMutation.isPending}
											title={t("mcpConnect")}
										>
											<IconPlug size={14} />
										</ActionIcon>
									)}
									<Button
										variant="subtle"
										size="compact-xs"
										onClick={() => handleEditServer(server)}
									>
										{t("editMcpServer")}
									</Button>
									<ActionIcon
										variant="subtle"
										color="red"
										size="sm"
										onClick={() => handleDelete(server.id, server.name)}
									>
										<IconTrash size={14} />
									</ActionIcon>
								</Group>
							</Group>
							{server.error && (
								<Text size="xs" c="red">
									{server.error}
								</Text>
							)}
							<Collapse in={isExpanded}>
								<Stack gap={4} mt="xs">
									{server.tools.length === 0 && (
										<Text size="xs" c="dimmed">
											{t("noMcpTools")}
										</Text>
									)}
									{server.tools.map((tool) => (
										<Paper key={tool.name} p="xs" bg="var(--mantine-color-dark-7)">
											<Text size="xs" fw={600}>
												{tool.name}
											</Text>
											{tool.description && (
												<Text size="xs" c="dimmed">
													{tool.description}
												</Text>
											)}
										</Paper>
									))}
								</Stack>
							</Collapse>
						</Stack>
					</Paper>
				);
			})}

				<>
					<Text size="sm" fw={600} mt="md">
						{t("mcpBuiltinTools")}
					</Text>
					<Text size="xs" c="dimmed">
						{t("mcpBuiltinToolsDesc")}
					</Text>
						<Paper key={tool.name} withBorder p="sm">
							<Text size="sm" fw={600}>
								{tool.name}
							</Text>
							{tool.description && (
								<Text size="xs" c="dimmed">
									{tool.description}
								</Text>
							)}
						</Paper>
					))}
				</>
			)}

			{/* Create / Edit Modal */}
			<Modal
				opened={editOpened}
				onClose={closeEdit}
				title={editingId ? t("editMcpServer") : t("addMcpServer")}
				size="lg"
			>
				<Stack>
					<TextInput
						label={t("mcpServerName")}
						placeholder={t("mcpServerNamePlaceholder")}
						value={draft.name}
						onChange={(e) => setDraft((d) => ({ ...d, name: e.currentTarget.value }))}
					/>
					<div>
						<Text size="sm" fw={500} mb={4}>
							{t("mcpTransportType")}
						</Text>
						<SegmentedControl
							value={draft.transport}
							onChange={(v) =>
								setDraft((d) => ({
									...d,
									transport: v as McpServerDraft["transport"],
								}))
							}
							data={[
								{ value: "stdio", label: t("mcpTransportStdio") },
								{ value: "streamable-http", label: t("mcpTransportHttp") },
								{ value: "sse", label: t("mcpTransportSse") },
							]}
							size="xs"
						/>
					</div>

					{draft.transport === "stdio" ? (
						<>
							<TextInput
								label={t("mcpCommand")}
								placeholder={t("mcpCommandPlaceholder")}
								value={draft.command}
								onChange={(e) => setDraft((d) => ({ ...d, command: e.currentTarget.value }))}
							/>
							<Textarea
								label={t("mcpArgs")}
								placeholder={t("mcpArgsPlaceholder")}
								value={draft.args}
								onChange={(e) => setDraft((d) => ({ ...d, args: e.currentTarget.value }))}
								autosize
								minRows={2}
								maxRows={6}
							/>
							<TextInput
								label={t("mcpCwd")}
								placeholder={t("mcpCwdPlaceholder")}
								value={draft.cwd}
								onChange={(e) => setDraft((d) => ({ ...d, cwd: e.currentTarget.value }))}
							/>
						</>
					) : (
						<>
							<TextInput
								label={t("mcpUrl")}
								placeholder={t("mcpUrlPlaceholder")}
								value={draft.url}
								onChange={(e) => setDraft((d) => ({ ...d, url: e.currentTarget.value }))}
							/>
							{/* Headers */}
							<div>
								<Group justify="space-between" mb={4}>
									<Text size="sm" fw={500}>
										{t("mcpHeaders")}
									</Text>
									<Button
										size="compact-xs"
										variant="subtle"
										onClick={() =>
											setDraft((d) => ({
												...d,
												headers: [...d.headers, { key: "", value: "" }],
											}))
										}
									>
										{t("mcpAddHeader")}
									</Button>
								</Group>
								{draft.headers.map((h, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: dynamic key-value pairs without stable IDs
									<Group key={i} gap="xs" mb={4}>
										<TextInput
											placeholder={t("mcpHeaderKey")}
											value={h.key}
											onChange={(e) => {
												const headers = [...draft.headers];
												headers[i] = { ...h, key: e.currentTarget.value };
												setDraft((d) => ({ ...d, headers }));
											}}
											size="xs"
											style={{ flex: 1 }}
										/>
										<TextInput
											placeholder={t("mcpHeaderValue")}
											value={h.value}
											onChange={(e) => {
												const headers = [...draft.headers];
												headers[i] = { ...h, value: e.currentTarget.value };
												setDraft((d) => ({ ...d, headers }));
											}}
											size="xs"
											style={{ flex: 1 }}
										/>
										<ActionIcon
											variant="subtle"
											color="red"
											size="sm"
											onClick={() => {
												const headers = draft.headers.filter((_, j) => j !== i);
												setDraft((d) => ({ ...d, headers }));
											}}
										>
											<IconTrash size={12} />
										</ActionIcon>
									</Group>
								))}
							</div>
						</>
					)}

					{/* Environment Variables */}
					<div>
						<Group justify="space-between" mb={4}>
							<Text size="sm" fw={500}>
								{t("mcpEnv")}
							</Text>
							<Button
								size="compact-xs"
								variant="subtle"
								onClick={() =>
									setDraft((d) => ({
										...d,
										env: [...d.env, { key: "", value: "" }],
									}))
								}
							>
								{t("mcpAddEnv")}
							</Button>
						</Group>
						{draft.env.map((e, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: dynamic key-value pairs without stable IDs
							<Group key={i} gap="xs" mb={4}>
								<TextInput
									placeholder={t("mcpEnvKey")}
									value={e.key}
									onChange={(ev) => {
										const env = [...draft.env];
										env[i] = { ...e, key: ev.currentTarget.value };
										setDraft((d) => ({ ...d, env }));
									}}
									size="xs"
									style={{ flex: 1 }}
								/>
								<TextInput
									placeholder={t("mcpEnvValue")}
									value={e.value}
									onChange={(ev) => {
										const env = [...draft.env];
										env[i] = { ...e, value: ev.currentTarget.value };
										setDraft((d) => ({ ...d, env }));
									}}
									size="xs"
									style={{ flex: 1 }}
								/>
								<ActionIcon
									variant="subtle"
									color="red"
									size="sm"
									onClick={() => {
										const env = draft.env.filter((_, j) => j !== i);
										setDraft((d) => ({ ...d, env }));
									}}
								>
									<IconTrash size={12} />
								</ActionIcon>
							</Group>
						))}
					</div>

					<Switch
						label={t("mcpEnabled")}
						checked={draft.enabled}
						onChange={(e) => setDraft((d) => ({ ...d, enabled: e.currentTarget.checked }))}
					/>

					{/* Test result */}
					{testMutation.data && (
						<Text size="sm" c={testMutation.data.ok ? "green" : "red"}>
							{testMutation.data.ok
								? t("mcpTestSuccess", {
										count: testMutation.data.tools?.length ?? 0,
									})
								: t("mcpTestFailed", {
										error: testMutation.data.error ?? "Unknown error",
									})}
						</Text>
					)}

					<Group justify="flex-end" gap="xs">
						<Button variant="light" onClick={handleTest} loading={testMutation.isPending}>
							{testMutation.isPending ? t("mcpTesting") : t("mcpTestConnection")}
						</Button>
						<Button variant="subtle" onClick={closeEdit}>
							{t("cancel")}
						</Button>
						<Button
							onClick={handleSave}
							disabled={!draft.name.trim()}
							loading={createMutation.isPending || updateMutation.isPending}
						>
							{t("save")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			{/* Delete Confirm Modal */}
			<Modal
				opened={deleteOpened}
				onClose={closeDelete}
				title={t("mcpDeleteConfirmTitle")}
				size="sm"
				centered
			>
				<Stack>
					<Text size="sm">{t("mcpDeleteConfirm", { name: deleteTarget?.name ?? "" })}</Text>
					<Group justify="flex-end" gap="xs">
						<Button variant="subtle" onClick={closeDelete}>
							{t("cancel")}
						</Button>
						<Button color="red" onClick={confirmDelete} loading={deleteMutation.isPending}>
							{t("deleteMcpServer")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			{/* Import Modal */}
			<Modal opened={importOpened} onClose={closeImport} title={t("mcpImportTitle")} size="lg">
				<Stack>
					<Text size="sm" c="dimmed">
						{t("mcpImportDesc")}
					</Text>
					<Textarea
						placeholder={t("mcpImportPlaceholder")}
						value={importJson}
						onChange={(e) => setImportJson(e.currentTarget.value)}
						autosize
						minRows={8}
						maxRows={16}
						styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
					/>
					{importError && (
						<Text size="sm" c="red">
							{importError}
						</Text>
					)}
					{importResult && (
						<Text size="sm" c="green">
							{importResult}
						</Text>
					)}
					<Group justify="flex-end" gap="xs">
						<Button variant="subtle" onClick={closeImport}>
							{t("cancel")}
						</Button>
						<Button
							onClick={handleImport}
							loading={importMutation.isPending}
							disabled={!importJson.trim()}
						>
							{t("mcpImportBtn")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	);
}
