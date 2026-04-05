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
	IconRefresh,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type CommandDef, CommandsEditor } from "../../components/common/CommandsEditor";
import {
	type CustomSubagentDef,
	useCreateCustomSubagent,
	useCustomSubagents,
	useDeleteCustomSubagent,
	useUpdateCustomSubagent,
} from "../../hooks/useCustomSubagents";
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
	useGlobalPrompt,
	useRoutines,
	useToggleRoutine,
	useUpdateGlobalPrompt,
} from "../../hooks/useRoutines";
import {
	useCreateGlobalSkill,
	useDeleteGlobalSkill,
	useGlobalSkills,
	useGlobalSkillsRefresh,
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
					<Tabs.Tab value="optional-tools">{t("tabOptionalTools")}</Tabs.Tab>
					<Tabs.Tab value="tool-permissions">{t("tabToolPermissions")}</Tabs.Tab>
					<Tabs.Tab value="global-skills">{t("tabGlobalSkills")}</Tabs.Tab>
					<Tabs.Tab value="project-skills">{t("tabProjectSkills")}</Tabs.Tab>
					<Tabs.Tab value="custom-subagents">{t("tabCustomSubagents")}</Tabs.Tab>
					<Tabs.Tab value="global-prompt">{t("tabGlobalPrompt")}</Tabs.Tab>
					<Tabs.Tab value="default-system-prompt">{t("tabDefaultSystemPrompt")}</Tabs.Tab>
					<Tabs.Tab value="mcp-tools">{t("tabMcpTools")}</Tabs.Tab>
				</Tabs.List>

				<Tabs.Panel value="commands">
					<CommandsTab />
				</Tabs.Panel>
				<Tabs.Panel value="optional-tools">
					<OptionalToolsTab />
				</Tabs.Panel>
				<Tabs.Panel value="tool-permissions">
					<ToolPermissionsTab />
				</Tabs.Panel>
				<Tabs.Panel value="global-skills">
					<GlobalSkillsTab />
				</Tabs.Panel>
				<Tabs.Panel value="project-skills">
					<ProjectSkillsTab />
				</Tabs.Panel>
				<Tabs.Panel value="custom-subagents">
					<CustomSubagentsTab />
				</Tabs.Panel>
				<Tabs.Panel value="global-prompt">
					<GlobalPromptTab />
				</Tabs.Panel>
				<Tabs.Panel value="default-system-prompt">
					<DefaultSystemPromptTab />
				</Tabs.Panel>
				<Tabs.Panel value="mcp-tools">
					<McpToolsTab />
				</Tabs.Panel>
			</Tabs>
		</Container>
	);
}

// === Tab: Optional Tools ===

function OptionalToolsTab() {
	const { t, i18n } = useTranslation("routines");
	const { data } = useRoutines();
	const toggleMutation = useToggleRoutine();
	const isZh = i18n.language?.startsWith("zh");

	const toolRoutines = data?.routines?.filter((r) => r.type === "tool") ?? [];

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("optionalToolsDesc")}
			</Text>
			{toolRoutines.length === 0 && (
				<Text size="sm" c="dimmed">
					{t("noOptionalTools")}
				</Text>
			)}
			{toolRoutines.map((routine) => (
				<Paper key={routine.id} withBorder p="sm">
					<Group justify="space-between" wrap="nowrap">
						<div style={{ flex: 1, minWidth: 0 }}>
							<Group gap="xs">
								<Text size="sm" fw={600}>
									{routine.name}
								</Text>
								<Badge size="xs" variant="light" color="yellow">
									/load {routine.id}
								</Badge>
							</Group>
							<Text size="xs" c="dimmed">
								{isZh ? routine.descriptionZh : routine.descriptionEn}
							</Text>
						</div>
						<Switch
							checked={routine.enabled}
							onChange={(e) =>
								toggleMutation.mutate({
									id: routine.id,
									enabled: e.currentTarget.checked,
								})
							}
							size="sm"
						/>
					</Group>
				</Paper>
			))}
		</Stack>
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

// === Tab: Tool Permissions (link to detail page) ===

function ToolPermissionsTab() {
	const { t } = useTranslation("routines");
	const navigate = useNavigate();

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("toolPermissionsDesc")}
			</Text>
			<Button variant="light" onClick={() => navigate({ to: "/routines/tool-permissions" })}>
				{t("toolPermissionsManage")}
			</Button>
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
	const refreshMutation = useGlobalSkillsRefresh();

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
				<Group gap="xs">
					<ActionIcon
						variant="subtle"
						size="sm"
						onClick={() => refreshMutation.mutate()}
						loading={refreshMutation.isPending}
						title={t("refreshSkills")}
					>
						<IconRefresh size={14} />
					</ActionIcon>
					<Button
						size="xs"
						variant="light"
						leftSection={<IconPlus size={14} />}
						onClick={handleCreate}
					>
						{t("createSkill")}
					</Button>
				</Group>
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
						onChange={(e) => {
							const val = e.currentTarget.value;
							setDraft((d) => ({ ...d, name: val }));
						}}
					/>
					<TextInput
						label={t("skillDescription")}
						placeholder={t("skillDescriptionPlaceholder")}
						value={draft.description}
						onChange={(e) => {
							const val = e.currentTarget.value;
							setDraft((d) => ({ ...d, description: val }));
						}}
					/>
					<Textarea
						label={t("skillContent")}
						placeholder={t("skillContentPlaceholder")}
						value={draft.content}
						onChange={(e) => {
							const val = e.currentTarget.value;
							setDraft((d) => ({ ...d, content: val }));
						}}
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

// === Tab: Global Prompt ===

function GlobalPromptTab() {
	const { t } = useTranslation("routines");
	const { data, isLoading } = useGlobalPrompt();
	const updateMutation = useUpdateGlobalPrompt();

	const [content, setContent] = useState("");
	const [dirty, setDirty] = useState(false);
	const [saved, setSaved] = useState(false);

	// Sync fetched content into local state (skip if user is actively editing)
	useEffect(() => {
		if (data?.content != null && !dirty) {
			setContent(data.content);
		}
	}, [data?.content, dirty]);

	const handleChange = useCallback((val: string) => {
		setContent(val);
		setDirty(true);
		setSaved(false);
	}, []);

	const handleSave = useCallback(
		(filePath?: string) => {
			updateMutation.mutate(
				{ content, filePath },
				{
					onSuccess: () => {
						setDirty(false);
						setSaved(true);
					},
				},
			);
		},
		[content, updateMutation],
	);

	if (isLoading) {
		return (
			<Text size="sm" c="dimmed">
				Loading...
			</Text>
		);
	}

	const activeFile = data?.filePath;
	const candidates = data?.candidates ?? [];

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("globalPromptDesc")}
			</Text>

			{/* Candidate paths */}
			<Stack gap={4}>
				<Text size="xs" fw={600}>
					{t("globalPromptCandidates")}
				</Text>
				{candidates.map((c) => (
					<Group key={c.path} gap="xs">
						<Badge
							size="xs"
							variant={c.exists ? "filled" : "outline"}
							color={c.exists ? "green" : "gray"}
						>
							{c.exists ? t("globalPromptExists") : t("globalPromptNotFound")}
						</Badge>
						<Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>
							{c.path}
						</Text>
						{c.path === activeFile && (
							<Badge size="xs" variant="light" color="indigo">
								{t("globalPromptActiveFile")}
							</Badge>
						)}
					</Group>
				))}
			</Stack>

			{!activeFile && !dirty && (
				<Text size="sm" c="dimmed">
					{t("globalPromptEmpty")}
				</Text>
			)}

			<Textarea
				placeholder={t("globalPromptPlaceholder")}
				value={content}
				onChange={(e) => handleChange(e.currentTarget.value)}
				autosize
				minRows={10}
				maxRows={30}
				styles={{ input: { fontFamily: "monospace", fontSize: 13 } }}
			/>

			<Group justify="flex-end" gap="xs">
				{saved && (
					<Text size="xs" c="green">
						{t("globalPromptSaved")}
					</Text>
				)}
				{/* If no file exists yet, let user pick which path to create */}
				{!activeFile && candidates.length > 0 ? (
					candidates.map((c) => (
						<Button
							key={c.path}
							size="xs"
							variant="light"
							onClick={() => handleSave(c.path)}
							loading={updateMutation.isPending}
							disabled={!content.trim()}
						>
							{t("globalPromptSaveTo")} {c.path.split("/").pop()}
						</Button>
					))
				) : (
					<Button
						size="xs"
						onClick={() => handleSave()}
						loading={updateMutation.isPending}
						disabled={!dirty}
					>
						{t("globalPromptSave")}
					</Button>
				)}
			</Group>
		</Stack>
	);
}

// === Tab: Default System Prompt ===

function DefaultSystemPromptTab() {
	const { t } = useTranslation("routines");
	const { data: settings, isLoading } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});
	const qc = useQueryClient();
	const updateMutation = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: (data) => {
			qc.setQueryData(["settings"], data);
		},
	});

	const [content, setContent] = useState("");
	const [dirty, setDirty] = useState(false);
	const [saved, setSaved] = useState(false);

	// Sync fetched content into local state
	useEffect(() => {
		const val = settings?.agent?.defaultSystemPrompt ?? "";
		if (!dirty) {
			setContent(val);
		}
	}, [settings?.agent?.defaultSystemPrompt, dirty]);

	const handleChange = useCallback((val: string) => {
		setContent(val);
		setDirty(true);
		setSaved(false);
	}, []);

	const handleSave = useCallback(() => {
		updateMutation.mutate(
			{
				agent: {
					defaultSystemPrompt: content || undefined,
				},
			},
			{
				onSuccess: () => {
					setDirty(false);
					setSaved(true);
				},
			},
		);
	}, [content, updateMutation]);

	if (isLoading) {
		return (
			<Text size="sm" c="dimmed">
				Loading...
			</Text>
		);
	}

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("defaultSystemPromptDesc")}
			</Text>

			<Textarea
				placeholder={t("defaultSystemPromptPlaceholder")}
				value={content}
				onChange={(e) => handleChange(e.currentTarget.value)}
				autosize
				minRows={10}
				maxRows={30}
				styles={{ input: { fontFamily: "monospace", fontSize: 13 } }}
			/>

			<Group justify="flex-end" gap="xs">
				{saved && (
					<Text size="xs" c="green">
						{t("defaultSystemPromptSaved")}
					</Text>
				)}
				<Button size="xs" onClick={handleSave} loading={updateMutation.isPending} disabled={!dirty}>
					{t("defaultSystemPromptSave")}
				</Button>
			</Group>
		</Stack>
	);
}

// === Tab: Custom Subagents ===

const TOOL_ACCESS_OPTIONS = [
	{ value: "readOnly", label: "Read-only" },
	{ value: "general", label: "General (write access)" },
	{ value: "custom", label: "Custom tool list" },
];

const AVAILABLE_TOOLS = [
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"Bash",
	"Write",
	"Edit",
	"AskUserQuestion",
	"Skill",
	"ShareFile",
	"Terminal",
	"TaskCreate",
];

interface SubagentDraft {
	name: string;
	description: string;
	toolAccess: string;
	customTools: string[];
	defaultModel: string;
	prompt: string;
}

const emptyDraft: SubagentDraft = {
	name: "",
	description: "",
	toolAccess: "readOnly",
	customTools: [],
	defaultModel: "",
	prompt: "",
};

function CustomSubagentsTab() {
	const { t } = useTranslation("routines");
	const { data: subagents, isLoading } = useCustomSubagents();
	const createMutation = useCreateCustomSubagent();
	const updateMutation = useUpdateCustomSubagent();
	const deleteMutation = useDeleteCustomSubagent();

	const [editOpened, { open: openEdit, close: closeEdit }] = useDisclosure(false);
	const [deleteOpened, { open: openDelete, close: closeDelete }] = useDisclosure(false);

	const [editingName, setEditingName] = useState<string | null>(null);
	const [draft, setDraft] = useState<SubagentDraft>(emptyDraft);
	const [deleteTarget, setDeleteTarget] = useState("");

	const handleCreate = useCallback(() => {
		setEditingName(null);
		setDraft(emptyDraft);
		openEdit();
	}, [openEdit]);

	const handleEdit = useCallback(
		(sa: CustomSubagentDef) => {
			setEditingName(sa.name);
			setDraft({
				name: sa.name,
				description: sa.description,
				toolAccess: sa.toolAccess,
				customTools: sa.customTools,
				defaultModel: sa.defaultModel,
				prompt: sa.prompt,
			});
			openEdit();
		},
		[openEdit],
	);

	const handleSave = useCallback(() => {
		const data = {
			name: draft.name.trim(),
			description: draft.description.trim(),
			toolAccess: draft.toolAccess,
			customTools: draft.customTools,
			defaultModel: draft.defaultModel.trim(),
			prompt: draft.prompt.trim(),
		};
		if (!data.name) return;

		if (editingName) {
			updateMutation.mutate(
				{ currentName: editingName, ...data },
				{ onSuccess: () => closeEdit() },
			);
		} else {
			createMutation.mutate(data, { onSuccess: () => closeEdit() });
		}
	}, [draft, editingName, createMutation, updateMutation, closeEdit]);

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

	const toolAccessLabel = (ta: string) =>
		TOOL_ACCESS_OPTIONS.find((o) => o.value === ta)?.label ?? ta;

	return (
		<Stack>
			<Group justify="space-between">
				<Text size="sm" c="dimmed" style={{ flex: 1 }}>
					{t("customSubagentsDesc")}
				</Text>
				<Button
					size="xs"
					variant="light"
					leftSection={<IconPlus size={14} />}
					onClick={handleCreate}
				>
					{t("createSubagent")}
				</Button>
			</Group>

			{isLoading && (
				<Text size="sm" c="dimmed">
					Loading...
				</Text>
			)}

			{!isLoading && (!subagents || subagents.length === 0) && (
				<Text size="sm" c="dimmed">
					{t("noCustomSubagents")}
				</Text>
			)}

			{subagents?.map((sa) => (
				<Paper key={sa.name} withBorder p="sm">
					<Group justify="space-between" wrap="nowrap">
						<div style={{ flex: 1, minWidth: 0 }}>
							<Group gap="xs">
								<Text size="sm" fw={600}>
									{sa.name}
								</Text>
								<Badge size="xs" variant="light" color="teal">
									{toolAccessLabel(sa.toolAccess)}
								</Badge>
							</Group>
							<Text size="xs" c="dimmed" truncate="end">
								{sa.description || sa.prompt.slice(0, 80)}
							</Text>
						</div>
						<Group gap={4}>
							<Button variant="subtle" size="compact-xs" onClick={() => handleEdit(sa)}>
								{t("editSubagent")}
							</Button>
							<ActionIcon
								variant="subtle"
								color="red"
								size="sm"
								onClick={() => handleDelete(sa.name)}
							>
								<IconTrash size={14} />
							</ActionIcon>
						</Group>
					</Group>
				</Paper>
			))}

			{/* Create / Edit Modal */}
			<Modal
				opened={editOpened}
				onClose={closeEdit}
				title={editingName ? t("editSubagent") : t("createSubagent")}
				size="lg"
			>
				<Stack>
					<TextInput
						label={t("subagentName")}
						placeholder={t("subagentNamePlaceholder")}
						value={draft.name}
						onChange={(e) => {
							const val = e.currentTarget.value;
							setDraft((d) => ({ ...d, name: val }));
						}}
					/>
					<TextInput
						label={t("subagentDescription")}
						placeholder={t("subagentDescriptionPlaceholder")}
						value={draft.description}
						onChange={(e) => {
							const val = e.currentTarget.value;
							setDraft((d) => ({ ...d, description: val }));
						}}
					/>
					<Select
						label={t("subagentToolAccess")}
						data={TOOL_ACCESS_OPTIONS}
						value={draft.toolAccess}
						onChange={(v) => setDraft((d) => ({ ...d, toolAccess: v ?? "readOnly" }))}
					/>
					{draft.toolAccess === "custom" && (
						<div>
							<Text size="sm" fw={500} mb={4}>
								{t("subagentCustomTools")}
							</Text>
							<Group gap="xs">
								{AVAILABLE_TOOLS.map((tool) => (
									<Badge
										key={tool}
										size="sm"
										variant={draft.customTools.includes(tool) ? "filled" : "outline"}
										color={draft.customTools.includes(tool) ? "indigo" : "gray"}
										style={{ cursor: "pointer" }}
										onClick={() =>
											setDraft((d) => ({
												...d,
												customTools: d.customTools.includes(tool)
													? d.customTools.filter((t) => t !== tool)
													: [...d.customTools, tool],
											}))
										}
									>
										{tool}
									</Badge>
								))}
							</Group>
						</div>
					)}
					<TextInput
						label={t("subagentDefaultModel")}
						placeholder={t("subagentDefaultModelPlaceholder")}
						value={draft.defaultModel}
						onChange={(e) => {
							const val = e.currentTarget.value;
							setDraft((d) => ({ ...d, defaultModel: val }));
						}}
					/>
					<Textarea
						label={t("subagentPrompt")}
						placeholder={t("subagentPromptPlaceholder")}
						value={draft.prompt}
						onChange={(e) => {
							const val = e.currentTarget.value;
							setDraft((d) => ({ ...d, prompt: val }));
						}}
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
				title={t("deleteConfirmTitle")}
				size="sm"
				centered
			>
				<Stack>
					<Text size="sm">{t("deleteSubagentConfirm", { name: deleteTarget })}</Text>
					<Group justify="flex-end" gap="xs">
						<Button variant="subtle" onClick={closeDelete}>
							{t("cancel")}
						</Button>
						<Button color="red" onClick={confirmDelete} loading={deleteMutation.isPending}>
							{t("deleteSubagent")}
						</Button>
					</Group>
				</Stack>
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
										<Paper key={tool.name} p="xs" withBorder>
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
						onChange={(e) => {
							const val = e.currentTarget.value;
							setDraft((d) => ({ ...d, name: val }));
						}}
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
								onChange={(e) => {
									const val = e.currentTarget.value;
									setDraft((d) => ({ ...d, command: val }));
								}}
							/>
							<Textarea
								label={t("mcpArgs")}
								placeholder={t("mcpArgsPlaceholder")}
								value={draft.args}
								onChange={(e) => {
									const val = e.currentTarget.value;
									setDraft((d) => ({ ...d, args: val }));
								}}
								autosize
								minRows={2}
								maxRows={6}
							/>
							<TextInput
								label={t("mcpCwd")}
								placeholder={t("mcpCwdPlaceholder")}
								value={draft.cwd}
								onChange={(e) => {
									const val = e.currentTarget.value;
									setDraft((d) => ({ ...d, cwd: val }));
								}}
							/>
						</>
					) : (
						<>
							<TextInput
								label={t("mcpUrl")}
								placeholder={t("mcpUrlPlaceholder")}
								value={draft.url}
								onChange={(e) => {
									const val = e.currentTarget.value;
									setDraft((d) => ({ ...d, url: val }));
								}}
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
												const val = e.currentTarget.value;
												const headers = [...draft.headers];
												headers[i] = { ...h, key: val };
												setDraft((d) => ({ ...d, headers }));
											}}
											size="xs"
											style={{ flex: 1 }}
										/>
										<TextInput
											placeholder={t("mcpHeaderValue")}
											value={h.value}
											onChange={(e) => {
												const val = e.currentTarget.value;
												const headers = [...draft.headers];
												headers[i] = { ...h, value: val };
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
										const val = ev.currentTarget.value;
										const env = [...draft.env];
										env[i] = { ...e, key: val };
										setDraft((d) => ({ ...d, env }));
									}}
									size="xs"
									style={{ flex: 1 }}
								/>
								<TextInput
									placeholder={t("mcpEnvValue")}
									value={e.value}
									onChange={(ev) => {
										const val = ev.currentTarget.value;
										const env = [...draft.env];
										env[i] = { ...e, value: val };
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
						onChange={(e) => {
							const val = e.currentTarget.checked;
							setDraft((d) => ({ ...d, enabled: val }));
						}}
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
