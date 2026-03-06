import {
	ActionIcon,
	Badge,
	Button,
	Container,
	Group,
	Modal,
	Paper,
	Select,
	Stack,
	Tabs,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { type CommandDef, CommandsEditor } from "../../components/common/CommandsEditor";
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

function McpToolsTab() {
	const { t } = useTranslation("routines");
	// biome-ignore lint/suspicious/noExplicitAny: MCP tool response structure varies
	const { data, isLoading, error } = useQuery<any>({
		queryKey: ["mcp-tools"],
		retry: false,
	});

	// biome-ignore lint/suspicious/noExplicitAny: MCP tool list structure
	const tools: any[] = data?.tools ?? [];

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("mcpToolsDesc")}
			</Text>

			{isLoading && (
				<Text size="sm" c="dimmed">
					Loading...
				</Text>
			)}

			{error && (
				<Text size="sm" c="dimmed">
					{t("noMcpTools")}
				</Text>
			)}

			{!isLoading && !error && tools.length === 0 && (
				<Text size="sm" c="dimmed">
					{t("noMcpTools")}
				</Text>
			)}

			{tools.map((tool) => (
				<Paper key={tool.name} withBorder p="sm">
					<Text size="sm" fw={600}>
						{tool.name}
					</Text>
					{tool.description && (
						<Text size="xs" c="dimmed">
							{tool.description}
						</Text>
					)}
					{tool.inputSchema && (
						<Text size="xs" c="dimmed" mt={4} style={{ fontFamily: "monospace" }}>
							{t("mcpToolParams")}:{" "}
							{Object.keys(tool.inputSchema.properties ?? {}).join(", ") || "none"}
						</Text>
					)}
				</Paper>
			))}
		</Stack>
	);
}
