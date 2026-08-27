import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Collapse,
	Container,
	Group,
	JsonInput,
	Modal,
	NumberInput,
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
import { pickLocalizedValue } from "@shared/i18n-locales";
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
import { ProxyOverrideField } from "../../components/common/ProxyOverrideField";
import { ProjectSkillsManager } from "../../components/project/ProjectSkillsManager";
import { useCurrentUser } from "../../hooks/useAuth";
import {
	type CustomSubagentDef,
	useCreateCustomSubagent,
	useCustomSubagents,
	useDeleteCustomSubagent,
	useUpdateCustomSubagent,
} from "../../hooks/useCustomSubagents";
import {
	type HookRecord,
	useCreateHook,
	useDeleteHook,
	useHooks,
	useUpdateHook,
} from "../../hooks/useHooks";
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
import {
	useContentCapability,
	useMcpExternalServerManagementCapability,
	useMcpServerSettingsStorageCapability,
	useMcpTransportsCapability,
	useProviderRouteCapability,
} from "../../hooks/usePlatform";
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
	useToggleGlobalSkill,
	useUpdateGlobalSkill,
} from "../../hooks/useSkills";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { filterUnsupportedMcpImportTransports } from "../../lib/mcp-import";
import {
	MCP_SECRET_KEEP_PLACEHOLDER,
	type McpJsonParseErrorKey,
	mcpDraftToJsonText,
	parseMcpDraftJson,
} from "../../lib/mcp-json-draft";
import {
	buildMcpSecretPatch,
	createPreservedMcpSecretEntries,
	type McpSecretDraftEntry,
	secretEntriesToRecord,
} from "../../lib/mcp-secrets";
import type { ProxyOverride } from "../../lib/proxy";
import { normalizeUrlProtocol } from "../../lib/url";

export const Route = createFileRoute("/routines/")({
	component: RoutinesPage,
});

const ROUTINES_SETTINGS_QUERY_GC_TIME_MS = 60_000;

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

const MAX_SKILL_FILE_PREVIEW_ITEMS = 50;
const MAX_SKILL_FILE_PREVIEW_CHARS = 2_000;
const MAX_ROUTINE_LIST_TEXT_PREVIEW_CHARS = 1_000;
const MAX_ROUTINE_DETAIL_TEXT_PREVIEW_CHARS = 4_000;

function formatRoutineTextPreview(value: string | undefined, maxChars: number): string {
	if (!value) return "";
	return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function formatSkillFilesPreview(files: string[]): string {
	let text = "";
	let hidden = Math.max(0, files.length - MAX_SKILL_FILE_PREVIEW_ITEMS);
	for (const file of files.slice(0, MAX_SKILL_FILE_PREVIEW_ITEMS)) {
		const prefix = text ? ", " : "";
		if (text.length + prefix.length + file.length > MAX_SKILL_FILE_PREVIEW_CHARS) {
			hidden += 1;
			break;
		}
		text += `${prefix}${file}`;
	}
	return hidden > 0 ? `${text}, … (+${hidden})` : text;
}

// === Skill type for list items ===
interface SkillSummary {
	name: string;
	description: string;
	location: string;
	files: string[];
	disabled?: boolean;
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
					<Tabs.Tab value="hooks">{t("tabHooks")}</Tabs.Tab>
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
				<Tabs.Panel value="hooks">
					<HooksTab />
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
	const locale = i18n.resolvedLanguage ?? i18n.language;

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
								{formatRoutineTextPreview(
									pickLocalizedValue(
										{ en: routine.descriptionEn, "zh-CN": routine.descriptionZh },
										locale,
									),
									MAX_ROUTINE_LIST_TEXT_PREVIEW_CHARS,
								)}
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

// === Tab: Hooks ===

const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop", "Attention", "AttentionResolved"];
const HOOK_TYPES = ["command", "http"];

// Events whose matcher filters by attention reason (a fixed enum) instead of a
// free-form tool name. Each maps to the reason values it can meaningfully match.
const ATTENTION_EVENTS = new Set(["Attention", "AttentionResolved"]);
const ATTENTION_REASONS_BY_EVENT: Record<string, readonly string[]> = {
	// Attention can fire for any of the three reasons.
	Attention: ["waiting_permission", "done", "error"],
	// First scope: AttentionResolved only fires for resolved permission requests.
	AttentionResolved: ["waiting_permission"],
};

interface HookDraft {
	event: string;
	matcher: string;
	type: string;
	command: string;
	url: string;
	headers: string;
	proxy?: ProxyOverride;
	timeout: number;
	enabled: boolean;
}

const emptyHookDraft: HookDraft = {
	event: "PreToolUse",
	matcher: "",
	type: "command",
	command: "",
	url: "",
	headers: "",
	proxy: undefined,
	timeout: 30,
	enabled: true,
};

// Common fields present in every hook payload.
const HOOK_COMMON_FIELDS = [
	["hook_event_name", "hookFieldHookEventName"],
	["narrator_id", "hookFieldNarratorId"],
	["narrator_title", "hookFieldNarratorTitle"],
	["chapter_id", "hookFieldChapterId"],
	["project_id", "hookFieldProjectId"],
	["cwd", "hookFieldCwd"],
] as const;

// Extra fields keyed by event.
const HOOK_EVENT_FIELDS: Record<string, ReadonlyArray<readonly [string, string]>> = {
	PreToolUse: [
		["tool_name", "hookFieldToolName"],
		["tool_input", "hookFieldToolInput"],
		["tool_use_id", "hookFieldToolUseId"],
	],
	PostToolUse: [
		["tool_name", "hookFieldToolName"],
		["tool_input", "hookFieldToolInput"],
		["tool_use_id", "hookFieldToolUseId"],
		["tool_output", "hookFieldToolOutput"],
		["tool_is_error", "hookFieldToolIsError"],
	],
	Stop: [
		["stop_reason", "hookFieldStopReason"],
		["stop_error", "hookFieldStopError"],
		["last_assistant_text", "hookFieldLastAssistantText"],
		["duration_ms", "hookFieldDurationMs"],
		["total_tokens", "hookFieldTotalTokens"],
	],
	Attention: [
		["attention_reason", "hookFieldAttentionReason"],
		["attention_detail", "hookFieldAttentionDetail"],
	],
	AttentionResolved: [
		["attention_reason", "hookFieldAttentionReason"],
		["attention_detail", "hookFieldAttentionDetail"],
	],
};

function buildHookExample(event: string): string {
	const base: Record<string, unknown> = {
		hook_event_name: event,
		narrator_id: "n_abc123",
		narrator_title: "Refactor auth flow",
		chapter_id: "c_def456",
		project_id: "p_ghi789",
		cwd: "/home/user/project/.worktrees/feature",
	};
	if (event === "PreToolUse") {
		base.tool_name = "Bash";
		base.tool_input = { command: "ls -la", description: "List files" };
		base.tool_use_id = "toolu_xyz";
	} else if (event === "PostToolUse") {
		base.tool_name = "Bash";
		base.tool_input = { command: "ls -la" };
		base.tool_use_id = "toolu_xyz";
		base.tool_output = "total 24\ndrwxr-xr-x ...";
		base.tool_is_error = false;
	} else if (event === "Stop") {
		base.stop_reason = "done";
		base.stop_error = false;
		base.last_assistant_text = "Done. I've updated the file.";
		base.duration_ms = 12345;
		base.total_tokens = 8192;
	} else if (event === "Attention") {
		base.attention_reason = "waiting_permission";
	} else if (event === "AttentionResolved") {
		base.attention_reason = "waiting_permission";
		base.attention_detail = "allow";
	}
	return JSON.stringify(base, null, 2);
}

function HookPayloadHelp({ event, type }: { event: string; type: string }) {
	const { t } = useTranslation("routines");
	const [opened, { toggle }] = useDisclosure(false);
	const eventFields = HOOK_EVENT_FIELDS[event] ?? [];

	return (
		<Alert variant="light" color="gray" p="sm">
			<Text size="xs">{type === "http" ? t("hookHttpHelp") : t("hookCommandHelp")}</Text>
			<Button
				variant="subtle"
				size="compact-xs"
				mt="xs"
				leftSection={opened ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
				onClick={toggle}
			>
				{t("hookPayloadRefShow")}
			</Button>
			<Collapse expanded={opened}>
				<Stack gap="xs" mt="xs">
					<div>
						<Text size="xs" fw={600} mb={4}>
							{t("hookFieldsCommon")}
						</Text>
						<Stack gap={2}>
							{HOOK_COMMON_FIELDS.map(([field, descKey]) => (
								<Text key={field} size="xs" c="dimmed">
									<Text span ff="monospace" c="bright">
										{field}
									</Text>{" "}
									— {t(descKey)}
								</Text>
							))}
						</Stack>
					</div>
					{eventFields.length > 0 && (
						<div>
							<Text size="xs" fw={600} mb={4}>
								{t("hookFieldsEvent")}
							</Text>
							<Stack gap={2}>
								{eventFields.map(([field, descKey]) => (
									<Text key={field} size="xs" c="dimmed">
										<Text span ff="monospace" c="bright">
											{field}
										</Text>{" "}
										— {t(descKey)}
									</Text>
								))}
							</Stack>
						</div>
					)}
					<div>
						<Text size="xs" fw={600} mb={4}>
							{t("hookExampleLabel")}
						</Text>
						<Textarea
							value={buildHookExample(event)}
							readOnly
							autosize
							maxRows={16}
							styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
						/>
					</div>
				</Stack>
			</Collapse>
		</Alert>
	);
}

function HooksTab() {
	const { t } = useTranslation("routines");
	const { data: hooksList, isLoading } = useHooks();
	const createMutation = useCreateHook();
	const updateMutation = useUpdateHook();
	const deleteMutation = useDeleteHook();

	const [editOpened, { open: openEdit, close: closeEdit }] = useDisclosure(false);
	const [deleteOpened, { open: openDelete, close: closeDelete }] = useDisclosure(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState<HookDraft>(emptyHookDraft);
	const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
	const [headersError, setHeadersError] = useState<string | null>(null);

	const handleCreate = useCallback(() => {
		setEditingId(null);
		setDraft(emptyHookDraft);
		setHeadersError(null);
		openEdit();
	}, [openEdit]);

	const handleEdit = useCallback(
		(hook: HookRecord) => {
			setEditingId(hook.id);
			setDraft({
				event: hook.event,
				matcher: hook.matcher ?? "",
				type: hook.type,
				command: hook.command ?? "",
				url: hook.url ?? "",
				headers: hook.headers ? JSON.stringify(hook.headers, null, 2) : "",
				proxy: hook.proxyMode
					? { mode: hook.proxyMode, url: hook.proxyUrl ?? undefined }
					: undefined,
				timeout: hook.timeout ?? 30,
				enabled: hook.enabled ?? true,
			});
			setHeadersError(null);
			openEdit();
		},
		[openEdit],
	);

	const handleSave = useCallback(() => {
		const payload: Record<string, unknown> = {
			event: draft.event,
			matcher: draft.matcher,
			type: draft.type,
			timeout: draft.timeout,
			enabled: draft.enabled,
		};
		if (draft.type === "command") payload.command = draft.command;
		if (draft.type === "http") {
			const normalizedUrl = normalizeUrlProtocol(draft.url) ?? "";
			payload.url = normalizedUrl;
			if (normalizedUrl !== draft.url) setDraft((d) => ({ ...d, url: normalizedUrl }));
			if (draft.headers.trim()) {
				try {
					payload.headers = JSON.parse(draft.headers);
					setHeadersError(null);
				} catch (e) {
					setHeadersError(e instanceof Error ? e.message : "Invalid JSON");
					return;
				}
			}
			payload.proxyMode = draft.proxy?.mode ?? null;
			payload.proxyUrl = draft.proxy?.mode === "custom" ? (draft.proxy.url ?? null) : null;
		}

		if (editingId) {
			updateMutation.mutate({ id: editingId, ...payload }, { onSuccess: () => closeEdit() });
		} else {
			createMutation.mutate(payload, { onSuccess: () => closeEdit() });
		}
	}, [draft, editingId, createMutation, updateMutation, closeEdit]);

	const handleDelete = useCallback(
		(name: string) => {
			setDeleteTarget(name);
			openDelete();
		},
		[openDelete],
	);

	const confirmDelete = useCallback(() => {
		if (deleteTarget) {
			deleteMutation.mutate(deleteTarget, { onSuccess: () => closeDelete() });
		}
	}, [deleteTarget, deleteMutation, closeDelete]);

	const eventLabel = (event: string) => t(`hookEvent${event}` as "hookEventPreToolUse");

	const isValid =
		draft.event &&
		draft.type &&
		((draft.type === "command" && draft.command.trim()) ||
			(draft.type === "http" && draft.url.trim()));

	return (
		<Stack>
			<Group justify="space-between">
				<Text size="sm" c="dimmed" style={{ flex: 1 }}>
					{t("hooksDesc")}
				</Text>
				<Button
					size="xs"
					variant="light"
					leftSection={<IconPlus size={14} />}
					onClick={handleCreate}
				>
					{t("createHook")}
				</Button>
			</Group>

			{isLoading && (
				<Text size="sm" c="dimmed">
					Loading...
				</Text>
			)}

			{!isLoading && (!hooksList || hooksList.length === 0) && (
				<Text size="sm" c="dimmed">
					{t("noHooks")}
				</Text>
			)}

			{hooksList?.map((hook: HookRecord) => (
				<Paper key={hook.id} withBorder p="sm">
					<Group justify="space-between" wrap="nowrap">
						<div style={{ flex: 1, minWidth: 0 }}>
							<Group gap="xs">
								<Badge size="xs" variant="light" color="indigo">
									{eventLabel(hook.event)}
								</Badge>
								<Badge size="xs" variant="outline">
									{hook.type}
								</Badge>
								{hook.matcher && (
									<Badge size="xs" variant="dot">
										{hook.matcher}
									</Badge>
								)}
								{!hook.enabled && (
									<Badge size="xs" variant="outline" color="gray">
										disabled
									</Badge>
								)}
							</Group>
							<Text size="xs" c="dimmed" truncate="end" mt={4}>
								{hook.type === "command" ? hook.command : hook.url}
							</Text>
						</div>
						<Group gap={4}>
							<Button variant="subtle" size="compact-xs" onClick={() => handleEdit(hook)}>
								{t("editHook")}
							</Button>
							<ActionIcon
								variant="subtle"
								color="red"
								size="sm"
								onClick={() => handleDelete(hook.id)}
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
				title={editingId ? t("editHook") : t("createHook")}
				size="lg"
			>
				<Stack>
					<Select
						label={t("hookEvent")}
						data={HOOK_EVENTS.map((e) => ({
							value: e,
							label: eventLabel(e),
						}))}
						value={draft.event}
						onChange={(v) =>
							setDraft((d) => {
								const nextEvent = v ?? "PreToolUse";
								let matcher = d.matcher;
								if (nextEvent === "Stop") {
									// Stop hooks are not tied to a tool — clear any matcher.
									matcher = "";
								} else if (ATTENTION_EVENTS.has(nextEvent)) {
									// Attention matcher is a reason enum — drop any value that
									// isn't valid for the new event (e.g. a leftover tool name).
									const valid = ATTENTION_REASONS_BY_EVENT[nextEvent] ?? [];
									if (matcher && !valid.includes(matcher)) matcher = "";
								} else if (ATTENTION_EVENTS.has(d.event)) {
									// Switching from an attention event to a tool event — the
									// old reason value is meaningless as a tool matcher.
									matcher = "";
								}
								return { ...d, event: nextEvent, matcher };
							})
						}
					/>
					{ATTENTION_EVENTS.has(draft.event) ? (
						<Select
							label={t("hookAttentionReason")}
							data={[
								{ value: "", label: t("hookAttentionReasonAll") },
								...(ATTENTION_REASONS_BY_EVENT[draft.event] ?? []).map((r) => ({
									value: r,
									label: t(`hookAttentionReason_${r}` as "hookAttentionReason_waiting_permission"),
								})),
							]}
							value={draft.matcher}
							onChange={(v) => setDraft((d) => ({ ...d, matcher: v ?? "" }))}
						/>
					) : (
						draft.event !== "Stop" && (
							<TextInput
								label={t("hookMatcher")}
								placeholder={t("hookMatcherPlaceholder")}
								value={draft.matcher}
								onChange={(e) => {
									const val = e.currentTarget.value;
									setDraft((d) => ({ ...d, matcher: val }));
								}}
							/>
						)
					)}
					<Select
						label={t("hookType")}
						data={HOOK_TYPES.map((tp) => ({
							value: tp,
							label: tp,
						}))}
						value={draft.type}
						onChange={(v) => setDraft((d) => ({ ...d, type: v ?? "command" }))}
					/>

					<HookPayloadHelp event={draft.event} type={draft.type} />

					{draft.type === "command" && (
						<TextInput
							label={t("hookCommand")}
							placeholder={t("hookCommandPlaceholder")}
							value={draft.command}
							onChange={(e) => {
								const val = e.currentTarget.value;
								setDraft((d) => ({ ...d, command: val }));
							}}
						/>
					)}

					{draft.type === "http" && (
						<>
							<TextInput
								label={t("hookUrl")}
								placeholder={t("hookUrlPlaceholder")}
								value={draft.url}
								onChange={(e) => {
									const val = e.currentTarget.value;
									setDraft((d) => ({ ...d, url: val }));
								}}
							/>
							<Textarea
								label={t("hookHeaders")}
								placeholder={t("hookHeadersPlaceholder")}
								value={draft.headers}
								onChange={(e) => {
									const val = e.currentTarget.value;
									setDraft((d) => ({ ...d, headers: val }));
									if (headersError) setHeadersError(null);
								}}
								error={headersError}
								autosize
								minRows={2}
								maxRows={6}
								styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
							/>
							<ProxyOverrideField
								value={draft.proxy}
								onChange={(next) => setDraft((d) => ({ ...d, proxy: next }))}
							/>
						</>
					)}

					<NumberInput
						label={t("hookTimeout")}
						value={draft.timeout}
						onChange={(v) => setDraft((d) => ({ ...d, timeout: typeof v === "number" ? v : 30 }))}
						min={1}
						max={600}
					/>

					<Switch
						label={t("hookEnabled")}
						checked={draft.enabled}
						onChange={(e) => {
							const val = e.currentTarget.checked;
							setDraft((d) => ({ ...d, enabled: val }));
						}}
					/>

					<Group justify="flex-end" gap="xs">
						<Button variant="subtle" onClick={closeEdit}>
							{t("cancel")}
						</Button>
						<Button
							onClick={handleSave}
							disabled={!isValid}
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
				title={t("hookDeleteConfirmTitle")}
				size="sm"
				centered
			>
				<Stack>
					<Text size="sm">{t("hookDeleteConfirm")}</Text>
					<Group justify="flex-end" gap="xs">
						<Button variant="subtle" onClick={closeDelete}>
							{t("cancel")}
						</Button>
						<Button color="red" onClick={confirmDelete} loading={deleteMutation.isPending}>
							{t("deleteHook")}
						</Button>
					</Group>
				</Stack>
			</Modal>
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
	const contentCapability = useContentCapability();
	const skillsCapability = contentCapability.projectSkills;
	const skillsUnsupportedReason = skillsCapability.supported
		? undefined
		: (skillsCapability.reason ?? t("globalSkillsUnsupportedDesc"));
	const canManageGlobalSkills = skillsCapability.supported;
	const { data: skills, isLoading } = useGlobalSkills(canManageGlobalSkills);
	const createMutation = useCreateGlobalSkill();
	const updateMutation = useUpdateGlobalSkill();
	const deleteMutation = useDeleteGlobalSkill();
	const refreshMutation = useGlobalSkillsRefresh();
	const toggleMutation = useToggleGlobalSkill();

	const [editOpened, { open: openEdit, close: closeEdit }] = useDisclosure(false);
	const [deleteOpened, { open: openDelete, close: closeDelete }] = useDisclosure(false);
	const [viewOpened, { open: openView, close: closeView }] = useDisclosure(false);

	const [editingSkill, setEditingSkill] = useState<string | null>(null); // null = create
	const [draft, setDraft] = useState<SkillDraft>({ name: "", description: "", content: "" });
	const [deleteTarget, setDeleteTarget] = useState<string>("");
	const [viewTarget, setViewTarget] = useState<SkillSummary | null>(null);

	const handleCreate = useCallback(() => {
		if (!canManageGlobalSkills) return;
		setEditingSkill(null);
		setDraft({ name: "", description: "", content: "" });
		openEdit();
	}, [canManageGlobalSkills, openEdit]);

	const handleEdit = useCallback(
		(skill: SkillSummary) => {
			if (!canManageGlobalSkills) return;
			setEditingSkill(skill.name);
			setDraft({ name: skill.name, description: skill.description, content: "" });
			// Fetch full content
			api.getGlobalSkill(skill.name).then((full) => {
				setDraft({ name: full.name, description: full.description, content: full.content });
			});
			openEdit();
		},
		[canManageGlobalSkills, openEdit],
	);

	const handleSave = useCallback(() => {
		if (!canManageGlobalSkills) return;
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
	}, [canManageGlobalSkills, draft, editingSkill, createMutation, updateMutation, closeEdit]);

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
			if (!canManageGlobalSkills) return;
			setViewTarget(skill);
			openView();
		},
		[canManageGlobalSkills, openView],
	);

	const handleRefresh = useCallback(() => {
		if (!canManageGlobalSkills) return;
		refreshMutation.mutate();
	}, [canManageGlobalSkills, refreshMutation]);

	return (
		<Stack>
			<Group justify="space-between">
				<Text size="sm" c="dimmed" style={{ flex: 1 }}>
					{t("globalSkillsDesc")}
				</Text>
				{skillsUnsupportedReason && (
					<Alert color="yellow" variant="light" title={t("globalSkillsUnsupportedTitle")}>
						{skillsUnsupportedReason}
					</Alert>
				)}
				<Group gap="xs">
					<ActionIcon
						variant="subtle"
						size="sm"
						onClick={handleRefresh}
						loading={refreshMutation.isPending}
						disabled={!canManageGlobalSkills}
						title={!canManageGlobalSkills ? skillsUnsupportedReason : t("refreshSkills")}
					>
						<IconRefresh size={14} />
					</ActionIcon>
					<Button
						size="xs"
						variant="light"
						leftSection={<IconPlus size={14} />}
						onClick={handleCreate}
						disabled={!canManageGlobalSkills}
						title={!canManageGlobalSkills ? skillsUnsupportedReason : undefined}
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
				const isDisabled = !!skill.disabled;
				return (
					<Paper
						key={skill.name}
						withBorder
						p="sm"
						style={isDisabled ? { opacity: 0.55 } : undefined}
					>
						<Group justify="space-between" wrap="nowrap">
							<div style={{ flex: 1, minWidth: 0 }}>
								<Group gap="xs">
									<Text size="sm" fw={600}>
										{skill.name}
									</Text>
									<Badge size="xs" variant="light" color={getSourceColor(source)}>
										{source}
									</Badge>
									{isDisabled && (
										<Badge size="xs" variant="outline" color="gray">
											{t("skillDisabled")}
										</Badge>
									)}
								</Group>
								<Text size="xs" c="dimmed" truncate="end">
									{formatRoutineTextPreview(skill.description, MAX_ROUTINE_LIST_TEXT_PREVIEW_CHARS)}
								</Text>
							</div>
							<Group gap={4}>
								<Switch
									checked={!isDisabled}
									onChange={(e) => {
										if (!canManageGlobalSkills) return;
										toggleMutation.mutate({
											name: skill.name,
											enabled: e.currentTarget.checked,
										});
									}}
									size="sm"
									disabled={!canManageGlobalSkills}
									title={!canManageGlobalSkills ? skillsUnsupportedReason : undefined}
								/>
								<Button
									variant="subtle"
									size="compact-xs"
									onClick={() => handleView(skill)}
									disabled={!canManageGlobalSkills}
									title={!canManageGlobalSkills ? skillsUnsupportedReason : undefined}
								>
									{t("viewSkill")}
								</Button>
								<Button
									variant="subtle"
									size="compact-xs"
									onClick={() => handleEdit(skill)}
									disabled={!canManageGlobalSkills}
									title={!canManageGlobalSkills ? skillsUnsupportedReason : undefined}
								>
									{t("editSkill")}
								</Button>
								<ActionIcon
									variant="subtle"
									color="red"
									size="sm"
									onClick={() => handleDelete(skill.name)}
									disabled={!canManageGlobalSkills}
									title={!canManageGlobalSkills ? skillsUnsupportedReason : undefined}
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
							disabled={!canManageGlobalSkills || !draft.name.trim() || !draft.description.trim()}
							loading={createMutation.isPending || updateMutation.isPending}
							title={!canManageGlobalSkills ? skillsUnsupportedReason : undefined}
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
							{formatRoutineTextPreview(
								viewTarget.description,
								MAX_ROUTINE_DETAIL_TEXT_PREVIEW_CHARS,
							)}
						</Text>
						<Text size="xs" c="dimmed">
							{t("skillLocation")}: {viewTarget.location}
						</Text>
						{viewTarget.files.length > 0 && (
							<Text size="xs" c="dimmed">
								Files: {formatSkillFilesPreview(viewTarget.files)}
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
	const contentCapability = useContentCapability();
	const routinesCapability = contentCapability.projectRoutines;
	const { data: currentUser } = useCurrentUser();
	const globalPromptUnsupportedReason = routinesCapability.supported
		? undefined
		: (routinesCapability.reason ?? t("globalPromptUnsupportedDesc"));
	// Writing requires admin because the content reaches every narrator's system prompt
	// (mirrors `defaultSystemPrompt` in settings). Reading stays open: the same text is
	// already visible by asking any narrator, so gating it here would only break the
	// read-only view. Anyone can look; only an admin can change it.
	const isAdmin = currentUser?.role === "admin";
	const canManageGlobalPrompt = routinesCapability.supported && isAdmin;
	const { data, isLoading } = useGlobalPrompt(routinesCapability.supported);
	const updateMutation = useUpdateGlobalPrompt();

	// A byte-capped prefix must never be saved back: PUT writes what it is given, so
	// submitting the visible part would silently discard everything past the cut.
	const truncated = data?.truncated === true;
	const canSaveGlobalPrompt = canManageGlobalPrompt && !truncated;
	const saveBlockedReason = !routinesCapability.supported
		? globalPromptUnsupportedReason
		: !isAdmin
			? t("globalPromptAdminOnly")
			: truncated
				? t("globalPromptTruncatedTitle")
				: undefined;

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
			if (!canSaveGlobalPrompt) return;
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
		[canSaveGlobalPrompt, content, updateMutation],
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
			{globalPromptUnsupportedReason && (
				<Alert color="yellow" variant="light" title={t("globalPromptUnsupportedTitle")}>
					{globalPromptUnsupportedReason}
				</Alert>
			)}
			{routinesCapability.supported && !isAdmin && (
				<Alert color="gray" variant="light" title={t("globalPromptAdminOnly")}>
					{t("globalPromptAdminOnlyDesc")}
				</Alert>
			)}
			{truncated && (
				<Alert color="orange" variant="light" title={t("globalPromptTruncatedTitle")}>
					{t("globalPromptTruncatedDesc", {
						shown: content.length,
						total: data?.totalBytes ?? 0,
					})}
				</Alert>
			)}

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
				// Read-only rather than disabled for non-admins and truncated files: the text
				// stays selectable and copyable, which is the whole value of the read path.
				readOnly={!canSaveGlobalPrompt}
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
							disabled={!canSaveGlobalPrompt || !content.trim()}
							title={saveBlockedReason}
						>
							{t("globalPromptSaveTo")} {c.path.split("/").pop()}
						</Button>
					))
				) : (
					<Button
						size="xs"
						onClick={() => handleSave()}
						loading={updateMutation.isPending}
						disabled={!canSaveGlobalPrompt || !dirty}
						title={saveBlockedReason}
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
		gcTime: ROUTINES_SETTINGS_QUERY_GC_TIME_MS,
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
				// Send "" (not undefined) so clearing the prompt actually persists —
				// JSON.stringify drops undefined fields and the PATCH merge would
				// keep the previous value.
				agent: {
					defaultSystemPrompt: content,
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
								{formatRoutineTextPreview(
									sa.description || sa.prompt,
									MAX_ROUTINE_LIST_TEXT_PREVIEW_CHARS,
								)}
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
	const contentCapability = useContentCapability();
	const skillsCapability = contentCapability.projectSkills;
	const skillsUnsupportedReason = skillsCapability.supported
		? undefined
		: (skillsCapability.reason ?? t("projectSkillsUnsupportedDesc"));
	const { data: projects } = useProjects();
	const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

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
			{skillsUnsupportedReason && (
				<Alert color="yellow" variant="light" title={t("projectSkillsUnsupportedTitle")}>
					{skillsUnsupportedReason}
				</Alert>
			)}
			<Select
				placeholder={t("selectProject")}
				data={projectOptions}
				value={selectedProjectId}
				onChange={setSelectedProjectId}
				// Also disabled with nothing to choose: an enabled but empty dropdown reads as
				// a loading bug rather than as missing project access.
				disabled={!skillsCapability.supported || projectOptions.length === 0}
				searchable
				clearable
			/>

			{!selectedProjectId && (
				<Text size="sm" c="dimmed">
					{projectOptions.length === 0 ? t("noProjectsAvailable") : t("noProjectSelected")}
				</Text>
			)}

			{selectedProjectId && (
				<ProjectSkillsManager
					projectId={selectedProjectId}
					enabled={skillsCapability.supported}
					disabledReason={skillsUnsupportedReason}
				/>
			)}
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
	env: McpSecretDraftEntry[];
	headers: McpSecretDraftEntry[];
	originalEnvKeys: string[];
	originalHeaderKeys: string[];
	enabled: boolean;
	defaultBehavior: "" | "readOnly" | "readWrite" | "ask" | "deny";
}

interface McpToolPermissionDraft {
	toolName: string;
	behavior: string;
	enabled?: boolean;
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
	originalEnvKeys: [],
	originalHeaderKeys: [],
	enabled: true,
	defaultBehavior: "",
};

function statusColor(status: string): string {
	if (status === "connected") return "green";
	if (status === "connecting") return "yellow";
	if (status === "error") return "red";
	return "gray";
}

/**
 * The status values the server reports, and the badge key each maps to.
 *
 * An explicit table rather than `mcpStatus${capitalize(status)}` with a cast: the
 * computed form type-checks for ANY string, so a new server-side status would
 * silently render a raw missing key instead of failing at build time. Listing them
 * also makes the mapping greppable from the locale files.
 */
const MCP_STATUS_LABEL_KEYS = {
	connected: "mcpStatusConnected",
	disconnected: "mcpStatusDisconnected",
	connecting: "mcpStatusConnecting",
	error: "mcpStatusError",
} as const;

type McpStatusLabelKey = (typeof MCP_STATUS_LABEL_KEYS)[keyof typeof MCP_STATUS_LABEL_KEYS];

/**
 * Translation key for a server's badge.
 *
 * A disabled server and a manually disconnected one used to render identically
 * ("Disconnected", gray), which hid the fact that disconnecting persists. Only
 * the settled `disconnected` state is relabeled: a `connecting`/`error` entry
 * that still exists while `enabled` is already false is a real transient and
 * should be shown as such rather than dressed up as "Disabled".
 */
function mcpStatusLabelKey(
	status: string,
	enabled: boolean | undefined,
): McpStatusLabelKey | "mcpStatusDisabled" {
	if (enabled === false && status === "disconnected") return "mcpStatusDisabled";
	// An unrecognised status falls back to the disconnected label rather than
	// rendering a missing key: the badge is a hint, not a diagnostic surface.
	return (
		MCP_STATUS_LABEL_KEYS[status as keyof typeof MCP_STATUS_LABEL_KEYS] ?? "mcpStatusDisconnected"
	);
}

function McpToolsTab() {
	const { t } = useTranslation("routines");
	const { data: currentUser } = useCurrentUser();
	const isAdmin = currentUser?.role === "admin";
	const mcpServerSettingsStorageCapability = useMcpServerSettingsStorageCapability();
	const mcpExternalServerManagementCapability = useMcpExternalServerManagementCapability();
	const mcpTransportCapability = useMcpTransportsCapability();
	const showMcpServerSettingsStorageWarning =
		mcpServerSettingsStorageCapability.supported === false;
	const mcpServerManagementSupported = isAdmin && mcpExternalServerManagementCapability.supported;
	const mcpServerManagementFallbackReason = !isAdmin
		? t("mcpServerManagementAdminOnlyDesc")
		: (mcpExternalServerManagementCapability.reason ?? t("mcpServerManagementUnsupportedDesc"));
	const mcpServerManagementUnsupportedReason = mcpServerManagementSupported
		? undefined
		: mcpServerManagementFallbackReason;
	const mcpServerPermissionsSupported =
		mcpServerManagementSupported && mcpExternalServerManagementCapability.permissions !== false;
	const mcpServerImportSupported =
		mcpServerManagementSupported && mcpExternalServerManagementCapability.import !== false;
	const mcpServerImportUnsupportedReason = mcpServerImportSupported
		? undefined
		: mcpServerManagementFallbackReason;
	const getDraftTransportCapability = (transport: McpServerDraft["transport"]) => {
		if (transport === "streamable-http") return mcpTransportCapability.streamableHttp;
		return mcpTransportCapability[transport];
	};
	const getServerTransportCapability = (transport: string | undefined) => {
		if (transport === "stdio" || transport === "sse" || transport === "streamable-http") {
			return getDraftTransportCapability(transport);
		}
		return { supported: false, reason: t("mcpTransportUnsupportedDesc") };
	};
	const { data: servers, isLoading } = useMcpServers({ enabled: mcpServerManagementSupported });
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
	const draftTransportCapability = getDraftTransportCapability(draft.transport);
	const draftTransportUnsupportedReason = draftTransportCapability.supported
		? undefined
		: (draftTransportCapability.reason ?? t("mcpTransportUnsupportedDesc"));
	const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
	const [expandedServer, setExpandedServer] = useState<string | null>(null);

	// JSON editing mode for the current draft. `draft` stays the single source of
	// truth: every accepted keystroke is parsed straight back into it, so Save and
	// Test need no knowledge of which view is active. `jsonText` is only the edit
	// buffer, never regenerated from `draft` while typing (that would fight the
	// caret), which is why it is re-serialized on each mode switch instead.
	const [editMode, setEditMode] = useState<"form" | "json">("form");
	const [jsonText, setJsonText] = useState("");
	const [jsonError, setJsonError] = useState<{
		key: McpJsonParseErrorKey;
		params?: Record<string, string>;
	} | null>(null);
	const jsonErrorMessage = jsonError ? t(jsonError.key, jsonError.params) : undefined;

	const handleJsonChange = useCallback(
		(value: string) => {
			setJsonText(value);
			const result = parseMcpDraftJson(value, draft);
			if (!result.ok) {
				setJsonError({ key: result.errorKey, params: result.params });
				return;
			}
			setJsonError(null);
			setDraft(result.draft);
		},
		[draft],
	);

	const handleEditModeChange = useCallback(
		(value: string) => {
			const next = value === "json" ? "json" : "form";
			if (next === editMode) return;
			if (next === "json") {
				setJsonText(mcpDraftToJsonText(draft));
				setJsonError(null);
			} else if (jsonError) {
				// Returning to the form would render `draft`, which still holds the
				// last valid document — the invalid text would vanish without a trace.
				return;
			}
			setEditMode(next);
		},
		[draft, editMode, jsonError],
	);

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
		if (!mcpServerImportSupported) return;
		setImportError(null);
		setImportResult(null);
		let parsed: unknown;
		try {
			parsed = JSON.parse(importJson);
		} catch {
			setImportError(t("mcpImportInvalidJson"));
			return;
		}
		const filtered = filterUnsupportedMcpImportTransports(parsed);
		if (filtered.skippedUnsupportedTransport > 0) {
			console.warn("Skipped MCP servers with unsupported transport during import", {
				count: filtered.skippedUnsupportedTransport,
			});
		}
		const formatImportResult = (added: number, skipped: number) => {
			const totalSkipped = skipped + filtered.skippedUnsupportedTransport;
			const base = t("mcpImportSuccess", { added, skipped: totalSkipped });
			if (filtered.skippedUnsupportedTransport === 0) return base;
			return `${base} ${t("mcpImportSkippedUnsupportedTransport", {
				count: filtered.skippedUnsupportedTransport,
			})}`;
		};
		if (filtered.allRecognizedServersSkipped) {
			setImportResult(formatImportResult(0, 0));
			setImportError(null);
			setImportJson("");
			return;
		}
		importMutation.mutate(filtered.json, {
			onSuccess: (data) => {
				setImportResult(formatImportResult(data.added, data.skipped));
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
	}, [importJson, importMutation, mcpServerImportSupported, t]);

	const handleCreate = useCallback(() => {
		if (!mcpServerManagementSupported) return;
		setEditingId(null);
		setDraft({ ...EMPTY_DRAFT });
		setEditMode("form");
		setJsonError(null);
		testMutation.reset();
		openEdit();
	}, [mcpServerManagementSupported, openEdit, testMutation]);

	const handleEditServer = useCallback(
		(server: {
			id: string;
			name?: string;
			transport?: string;
			command?: string;
			args?: string[];
			cwd?: string;
			url?: string;
			envKeys?: string[];
			headerKeys?: string[];
			enabled?: boolean;
			defaultBehavior?: string;
		}) => {
			if (!mcpServerManagementSupported) return;
			const envKeys = server.envKeys ?? [];
			const headerKeys = server.headerKeys ?? [];
			setEditMode("form");
			setJsonError(null);
			setEditingId(server.id);
			setDraft({
				name: server.name ?? "",
				transport: (server.transport as McpServerDraft["transport"]) ?? "stdio",
				command: server.command ?? "",
				args: Array.isArray(server.args) ? server.args.join("\n") : "",
				cwd: server.cwd ?? "",
				url: server.url ?? "",
				env: createPreservedMcpSecretEntries(envKeys),
				headers: createPreservedMcpSecretEntries(headerKeys),
				originalEnvKeys: [...envKeys],
				originalHeaderKeys: [...headerKeys],
				enabled: server.enabled ?? true,
				defaultBehavior: (server.defaultBehavior as McpServerDraft["defaultBehavior"]) ?? "",
			});
			testMutation.reset();
			openEdit();
		},
		[mcpServerManagementSupported, openEdit, testMutation],
	);

	const draftToPayload = useCallback((d: McpServerDraft, includeClears = false) => {
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
			payload.url = normalizeUrlProtocol(d.url) ?? "";
		}

		if (includeClears) {
			const headerPatch = buildMcpSecretPatch(d.headers, d.originalHeaderKeys);
			const envPatch = buildMcpSecretPatch(d.env, d.originalEnvKeys);
			if (headerPatch) payload.headerPatch = headerPatch;
			if (envPatch) payload.envPatch = envPatch;
		} else {
			const headers = secretEntriesToRecord(d.headers);
			const env = secretEntriesToRecord(d.env);
			if (headers) payload.headers = headers;
			if (env) payload.env = env;
		}
		if (d.defaultBehavior) {
			payload.defaultBehavior = d.defaultBehavior;
		} else if (includeClears) {
			payload.defaultBehavior = null;
		}
		return payload;
	}, []);

	const handleSave = useCallback(() => {
		if (!mcpServerManagementSupported || draftTransportUnsupportedReason) return;
		// With invalid JSON on screen, `draft` still holds the last document that
		// parsed. Saving it would persist something the user is not looking at.
		if (jsonError) return;
		if (draft.transport !== "stdio") {
			const normalizedUrl = normalizeUrlProtocol(draft.url) ?? "";
			if (normalizedUrl !== draft.url) setDraft((d) => ({ ...d, url: normalizedUrl }));
		}
		const payload = draftToPayload(draft, Boolean(editingId));
		if (!mcpServerPermissionsSupported) delete payload.defaultBehavior;
		if (!payload.name) return;

		if (editingId) {
			updateMutation.mutate({ id: editingId, ...payload }, { onSuccess: () => closeEdit() });
		} else {
			createMutation.mutate(payload, { onSuccess: () => closeEdit() });
		}
	}, [
		draft,
		editingId,
		createMutation,
		updateMutation,
		closeEdit,
		draftToPayload,
		draftTransportUnsupportedReason,
		jsonError,
		mcpServerManagementSupported,
		mcpServerPermissionsSupported,
	]);

	const handleTest = useCallback(() => {
		if (!mcpServerManagementSupported || draftTransportUnsupportedReason) return;
		if (jsonError) return;
		if (draft.transport !== "stdio") {
			const normalizedUrl = normalizeUrlProtocol(draft.url) ?? "";
			if (normalizedUrl !== draft.url) setDraft((d) => ({ ...d, url: normalizedUrl }));
		}
		const payload = draftToPayload(draft, Boolean(editingId));
		if (!mcpServerPermissionsSupported) delete payload.defaultBehavior;
		testMutation.mutate({ id: editingId ?? undefined, data: payload });
	}, [
		draft,
		editingId,
		testMutation,
		draftToPayload,
		draftTransportUnsupportedReason,
		jsonError,
		mcpServerManagementSupported,
		mcpServerPermissionsSupported,
	]);

	const handleDelete = useCallback(
		(id: string, name: string) => {
			if (!mcpServerManagementSupported) return;
			setDeleteTarget({ id, name });
			openDelete();
		},
		[mcpServerManagementSupported, openDelete],
	);

	const confirmDelete = useCallback(() => {
		if (!mcpServerManagementSupported) return;
		if (deleteTarget) {
			deleteMutation.mutate(deleteTarget.id, { onSuccess: () => closeDelete() });
		}
	}, [deleteTarget, deleteMutation, closeDelete, mcpServerManagementSupported]);

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
						disabled={!mcpServerImportSupported}
						title={mcpServerImportUnsupportedReason}
						onClick={() => {
							if (!mcpServerImportSupported) return;
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
						disabled={!mcpServerManagementSupported}
						title={!mcpServerManagementSupported ? mcpServerManagementUnsupportedReason : undefined}
						onClick={handleCreate}
					>
						{t("addMcpServer")}
					</Button>
				</Group>
			</Group>

			{showMcpServerSettingsStorageWarning && (
				<Alert color="yellow" variant="light" title={t("mcpServerSettingsStorageWarning")}>
					{t("mcpServerSettingsStorageWarningDesc")}
				</Alert>
			)}

			{mcpServerManagementUnsupportedReason && (
				<Alert color="yellow" variant="light" title={t("mcpServerManagementUnsupportedTitle")}>
					{mcpServerManagementUnsupportedReason}
				</Alert>
			)}

			{mcpServerManagementSupported && !mcpServerPermissionsSupported && (
				<Alert color="yellow" variant="light" title={t("mcpServerPermissionsUnsupportedTitle")}>
					{t("mcpServerPermissionsUnsupportedDesc")}
				</Alert>
			)}

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
				const serverTransportCapability = getServerTransportCapability(server.transport);
				const canConnectServer =
					mcpServerManagementSupported && serverTransportCapability.supported;
				const connectUnsupportedReason = !mcpServerManagementSupported
					? mcpServerManagementUnsupportedReason
					: (serverTransportCapability.reason ?? t("mcpTransportUnsupportedDesc"));
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
										{t(mcpStatusLabelKey(server.status, server.enabled))}
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
									{/* These buttons write the persisted `enabled` intent, so they branch on
									    it rather than on the live socket state. An enabled-but-unreachable
									    server still needs a disable button here: branching on `connected`
									    alone would leave it with only "Connect", making it impossible to
									    stop from this list while it retries on every startup. */}
									{server.enabled && (
										<ActionIcon
											variant="subtle"
											size="sm"
											color="orange"
											disabled={!mcpServerManagementSupported}
											onClick={() => {
												if (!mcpServerManagementSupported) return;
												disconnectMutation.mutate(server.id);
											}}
											loading={disconnectMutation.isPending}
											title={
												mcpServerManagementSupported
													? server.status === "connected"
														? t("mcpDisconnect")
														: t("mcpDisableAndDisconnect")
													: mcpServerManagementUnsupportedReason
											}
										>
											<IconPlugOff size={14} />
										</ActionIcon>
									)}
									{server.status !== "connected" && (
										<ActionIcon
											variant="subtle"
											size="sm"
											color="green"
											disabled={!canConnectServer}
											onClick={() => {
												if (!canConnectServer) return;
												connectMutation.mutate(server.id);
											}}
											loading={connectMutation.isPending}
											title={canConnectServer ? t("mcpConnect") : connectUnsupportedReason}
										>
											<IconPlug size={14} />
										</ActionIcon>
									)}
									<Button
										variant="subtle"
										size="compact-xs"
										disabled={!mcpServerManagementSupported}
										title={
											!mcpServerManagementSupported
												? mcpServerManagementUnsupportedReason
												: undefined
										}
										onClick={() => handleEditServer(server)}
									>
										{t("editMcpServer")}
									</Button>
									<ActionIcon
										variant="subtle"
										color="red"
										size="sm"
										disabled={!mcpServerManagementSupported}
										title={
											!mcpServerManagementSupported
												? mcpServerManagementUnsupportedReason
												: undefined
										}
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
							<Collapse expanded={isExpanded}>
								<Stack gap={4} mt="xs">
									{server.tools.length === 0 && (
										<Text size="xs" c="dimmed">
											{t("noMcpTools")}
										</Text>
									)}
									{server.tools.length > 0 && (
										<Text size="xs" c="dimmed" mb={2}>
											{t("mcpToolPermissions")}
										</Text>
									)}
									{server.tools.map((tool) => {
										const toolPerms: McpToolPermissionDraft[] = server.toolPermissions ?? [];
										const perm = toolPerms.find((tp) => tp.toolName === tool.name);
										const currentBehavior = perm?.behavior ?? "";
										return (
											<Paper key={tool.name} p="xs" withBorder>
												<Group justify="space-between" wrap="nowrap" gap="xs">
													<div style={{ flex: 1, minWidth: 0 }}>
														<Text size="xs" fw={600}>
															{tool.name}
														</Text>
														{tool.description && (
															<Text size="xs" c="dimmed" lineClamp={1}>
																{formatRoutineTextPreview(
																	tool.description,
																	MAX_ROUTINE_LIST_TEXT_PREVIEW_CHARS,
																)}
															</Text>
														)}
													</div>
													<Select
														value={currentBehavior}
														disabled={!mcpServerPermissionsSupported}
														onChange={(v) => {
															if (!mcpServerPermissionsSupported) return;
															const newBehavior = v ?? "";
															updateMutation.mutate({
																id: server.id,
																toolPermissionPatch: {
																	toolName: tool.name,
																	behavior: newBehavior || null,
																},
															});
														}}
														data={[
															{ value: "", label: t("mcpBehaviorFollow") },
															{ value: "readOnly", label: t("mcpBehaviorReadOnly") },
															{ value: "readWrite", label: t("mcpBehaviorReadWrite") },
															{ value: "ask", label: t("mcpBehaviorAsk") },
															{ value: "deny", label: t("mcpBehaviorDeny") },
														]}
														clearable={false}
														size="xs"
														w={130}
														styles={{
															input: { minHeight: 28, height: 28 },
														}}
													/>
												</Group>
											</Paper>
										);
									})}
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
									{formatRoutineTextPreview(
										tool.description,
										MAX_ROUTINE_DETAIL_TEXT_PREVIEW_CHARS,
									)}
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
					<Group justify="flex-end">
						<SegmentedControl
							value={editMode}
							onChange={handleEditModeChange}
							data={[
								{ value: "form", label: t("mcpEditModeForm") },
								{
									value: "json",
									label: t("mcpEditModeJson"),
								},
							]}
							size="xs"
						/>
					</Group>

					{editMode === "json" ? (
						<>
							<Text size="xs" c="dimmed">
								{t("mcpJsonEditDesc", { placeholder: MCP_SECRET_KEEP_PLACEHOLDER })}
							</Text>
							<JsonInput
								value={jsonText}
								onChange={handleJsonChange}
								error={jsonErrorMessage}
								autosize
								minRows={12}
								maxRows={24}
								spellCheck={false}
								styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
							/>
						</>
					) : (
						<>
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
									onChange={(v) => {
										const nextTransport = v as McpServerDraft["transport"];
										if (!getDraftTransportCapability(nextTransport).supported) return;
										setDraft((d) => ({
											...d,
											transport: nextTransport,
										}));
									}}
									data={[
										{
											value: "stdio",
											label: t("mcpTransportStdio"),
											disabled: !mcpTransportCapability.stdio.supported,
										},
										{
											value: "streamable-http",
											label: t("mcpTransportHttp"),
											disabled: !mcpTransportCapability.streamableHttp.supported,
										},
										{
											value: "sse",
											label: t("mcpTransportSse"),
											disabled: !mcpTransportCapability.sse.supported,
										},
									]}
									size="xs"
								/>
							</div>

							{draftTransportUnsupportedReason && (
								<Alert color="yellow" variant="light" title={t("mcpTransportUnsupportedTitle")}>
									{draftTransportUnsupportedReason}
								</Alert>
							)}

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
														headers: [...d.headers, { key: "", value: "", dirty: false }],
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
													readOnly={h.preserved}
													onChange={(e) => {
														if (h.preserved) return;
														const val = e.currentTarget.value;
														const headers = [...draft.headers];
														headers[i] = { ...h, key: val };
														setDraft((d) => ({ ...d, headers }));
													}}
													size="xs"
													style={{ flex: 1 }}
												/>
												<TextInput
													placeholder={
														h.preserved && !h.value ? t("mcpSecretUnchanged") : t("mcpHeaderValue")
													}
													type="password"
													value={h.value}
													onChange={(e) => {
														const val = e.currentTarget.value;
														const headers = [...draft.headers];
														headers[i] = { ...h, value: val, dirty: true };
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
												env: [...d.env, { key: "", value: "", dirty: false }],
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
											readOnly={e.preserved}
											onChange={(ev) => {
												if (e.preserved) return;
												const val = ev.currentTarget.value;
												const env = [...draft.env];
												env[i] = { ...e, key: val };
												setDraft((d) => ({ ...d, env }));
											}}
											size="xs"
											style={{ flex: 1 }}
										/>
										<TextInput
											placeholder={
												e.preserved && !e.value ? t("mcpSecretUnchanged") : t("mcpEnvValue")
											}
											type="password"
											value={e.value}
											onChange={(ev) => {
												const val = ev.currentTarget.value;
												const env = [...draft.env];
												env[i] = { ...e, value: val, dirty: true };
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
								description={t("mcpEnabledDesc")}
								checked={draft.enabled}
								onChange={(e) => {
									const val = e.currentTarget.checked;
									setDraft((d) => ({ ...d, enabled: val }));
								}}
							/>

							<Select
								label={t("mcpDefaultBehavior")}
								description={t("mcpDefaultBehaviorDesc")}
								value={draft.defaultBehavior}
								disabled={!mcpServerPermissionsSupported}
								onChange={(v) => {
									if (!mcpServerPermissionsSupported) return;
									setDraft((d) => ({
										...d,
										defaultBehavior: (v ?? "") as McpServerDraft["defaultBehavior"],
									}));
								}}
								data={[
									{ value: "", label: t("mcpBehaviorFollow") },
									{ value: "readOnly", label: t("mcpBehaviorReadOnly") },
									{ value: "readWrite", label: t("mcpBehaviorReadWrite") },
									{ value: "ask", label: t("mcpBehaviorAsk") },
									{ value: "deny", label: t("mcpBehaviorDeny") },
								]}
								clearable={false}
								size="sm"
							/>
						</>
					)}

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
						<Button
							variant="light"
							onClick={handleTest}
							disabled={
								!mcpServerManagementSupported || !!draftTransportUnsupportedReason || !!jsonError
							}
							loading={testMutation.isPending}
						>
							{testMutation.isPending ? t("mcpTesting") : t("mcpTestConnection")}
						</Button>
						<Button variant="subtle" onClick={closeEdit}>
							{t("cancel")}
						</Button>
						<Button
							onClick={handleSave}
							disabled={
								!mcpServerManagementSupported ||
								!draft.name.trim() ||
								!!draftTransportUnsupportedReason ||
								!!jsonError
							}
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
						<Button
							color="red"
							onClick={confirmDelete}
							disabled={!mcpServerManagementSupported}
							loading={deleteMutation.isPending}
						>
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
							disabled={!mcpServerImportSupported || !importJson.trim()}
						>
							{t("mcpImportBtn")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	);
}
