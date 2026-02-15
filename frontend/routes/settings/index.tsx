import {
	ActionIcon,
	Affix,
	Button,
	Group,
	Loader,
	NumberInput,
	Paper,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
	Transition,
} from "@mantine/core";
import {
	IconHandStop,
	IconPencilCheck,
	IconShield,
	IconShieldOff,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "../../components/LanguageSwitcher";
import { ThemeSwitcher } from "../../components/ThemeSwitcher";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { BUILTIN_MODELS } from "../../lib/constants";

export const Route = createFileRoute("/settings/")({
	component: SettingsPage,
});

function SettingsPage() {
	const { data: settings, isLoading } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});
	const qc = useQueryClient();
	const updateSettings = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
	});
	const { t } = useTranslation("settings");
	const { t: tn } = useTranslation("narrator");

	// Per-user preferences (account-independent)
	const { data: userPrefs } = useUserPreferences();
	const updateUserPref = useUpdateUserPreferences();

	// Server
	const [port, setPort] = useState<number | undefined>();
	const [projectDir, setProjectDir] = useState("");
	// Agent
	const [defaultModel, setDefaultModel] = useState("claude-sonnet");
	const [permissionMode, setPermissionMode] = useState("default");
	const [summaryModel, setSummaryModel] = useState("claude-haiku");
	const [customModels, setCustomModels] = useState<Array<{ value: string; label: string }>>([]);
	const [newModelValue, setNewModelValue] = useState("");
	const [newModelLabel, setNewModelLabel] = useState("");
	// Chapters
	const [maxWorktrees, setMaxWorktrees] = useState(10);
	const [maxContainers, setMaxContainers] = useState(5);
	const [sizeWarning, setSizeWarning] = useState(500);
	const [autoSave, setAutoSave] = useState(true);
	const [dormantMinutes, setDormantMinutes] = useState(0);
	// Containers
	const [portStart, setPortStart] = useState(10000);
	const [portEnd, setPortEnd] = useState(20000);
	// Editor
	const [editor, setEditor] = useState("vscode");

	const [initialized, setInitialized] = useState(false);
	const [highlight, setHighlight] = useState(false);
	const prevDirty = useRef(false);

	// Snapshot of server values for dirty comparison
	const serverSnapshot = useRef({
		port: 7778 as number | undefined,
		projectDir: "",
		defaultModel: "claude-sonnet",
		permissionMode: "default",
		summaryModel: "claude-haiku",
		customModels: [] as Array<{ value: string; label: string }>,
		maxWorktrees: 10,
		maxContainers: 5,
		sizeWarning: 500,
		autoSave: true,
		dormantMinutes: 0,
		portStart: 10000,
		portEnd: 20000,
		editor: "vscode",
	});

	useEffect(() => {
		if (settings && !initialized) {
			const snap = {
				port: settings.server?.port ?? 7778,
				projectDir: settings.paths?.defaultProjectDir ?? "",
				defaultModel: settings.agent?.defaultModel ?? "claude-sonnet",
				permissionMode: settings.agent?.defaultPermissionMode ?? "default",
				summaryModel: settings.agent?.summaryModel ?? "claude-haiku",
				customModels: settings.agent?.customModels ?? [],
				maxWorktrees: settings.chapters?.maxActiveWorktrees ?? 10,
				maxContainers: settings.chapters?.maxActiveContainers ?? 5,
				sizeWarning: settings.chapters?.worktreeSizeWarningMb ?? 500,
				autoSave: settings.chapters?.autoSaveOnDormant ?? true,
				dormantMinutes: settings.chapters?.dormantAfterMinutes ?? 0,
				portStart: settings.containers?.portRangeStart ?? 10000,
				portEnd: settings.containers?.portRangeEnd ?? 20000,
				editor: settings.editor?.type ?? "vscode",
			};
			serverSnapshot.current = snap;
			setPort(snap.port);
			setProjectDir(snap.projectDir);
			setDefaultModel(snap.defaultModel);
			setPermissionMode(snap.permissionMode);
			setSummaryModel(snap.summaryModel);
			setCustomModels(snap.customModels);
			setMaxWorktrees(snap.maxWorktrees);
			setMaxContainers(snap.maxContainers);
			setSizeWarning(snap.sizeWarning);
			setAutoSave(snap.autoSave);
			setDormantMinutes(snap.dormantMinutes);
			setPortStart(snap.portStart);
			setPortEnd(snap.portEnd);
			setEditor(snap.editor);
			setInitialized(true);
		}
	}, [settings, initialized]);

	const isDirty = useMemo(() => {
		if (!initialized) return false;
		const s = serverSnapshot.current;
		return (
			port !== s.port ||
			projectDir !== s.projectDir ||
			defaultModel !== s.defaultModel ||
			permissionMode !== s.permissionMode ||
			summaryModel !== s.summaryModel ||
			JSON.stringify(customModels) !== JSON.stringify(s.customModels) ||
			maxWorktrees !== s.maxWorktrees ||
			maxContainers !== s.maxContainers ||
			sizeWarning !== s.sizeWarning ||
			autoSave !== s.autoSave ||
			dormantMinutes !== s.dormantMinutes ||
			portStart !== s.portStart ||
			portEnd !== s.portEnd ||
			editor !== s.editor
		);
	}, [
		initialized,
		port,
		projectDir,
		defaultModel,
		permissionMode,
		summaryModel,
		customModels,
		maxWorktrees,
		maxContainers,
		sizeWarning,
		autoSave,
		dormantMinutes,
		portStart,
		portEnd,
		editor,
	]);

	// Trigger highlight animation when transitioning from clean to dirty
	useEffect(() => {
		if (isDirty && !prevDirty.current) {
			setHighlight(true);
			const timer = setTimeout(() => setHighlight(false), 1500);
			return () => clearTimeout(timer);
		}
		prevDirty.current = isDirty;
	}, [isDirty]);

	if (isLoading) return <Loader />;

	const allModels = [...BUILTIN_MODELS, ...customModels];

	const handleAddModel = () => {
		const v = newModelValue.trim();
		const l = newModelLabel.trim();
		if (!v || !l) return;
		if (allModels.some((m) => m.value === v)) return;
		setCustomModels([...customModels, { value: v, label: l }]);
		setNewModelValue("");
		setNewModelLabel("");
	};

	const handleRemoveModel = (value: string) => {
		setCustomModels(customModels.filter((m) => m.value !== value));
	};

	const handleSave = () => {
		updateSettings.mutate(
			{
				server: { port },
				paths: { defaultProjectDir: projectDir },
				agent: {
					defaultModel,
					defaultPermissionMode: permissionMode,
					summaryModel,
					customModels,
				},
				chapters: {
					maxActiveWorktrees: maxWorktrees,
					maxActiveContainers: maxContainers,
					worktreeSizeWarningMb: sizeWarning,
					autoSaveOnDormant: autoSave,
					dormantAfterMinutes: dormantMinutes,
				},
				containers: {
					portRangeStart: portStart,
					portRangeEnd: portEnd,
				},
				editor: { type: editor },
			},
			{
				onSuccess: () => {
					serverSnapshot.current = {
						port,
						projectDir,
						defaultModel,
						permissionMode,
						summaryModel,
						customModels: [...customModels],
						maxWorktrees,
						maxContainers,
						sizeWarning,
						autoSave,
						dormantMinutes,
						portStart,
						portEnd,
						editor,
					};
				},
			},
		);
	};

	return (
		<Stack>
			<Title order={2}>{t("title")}</Title>

			{/* Server */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("serverSection")}</Title>
					<NumberInput
						label={t("serverPort")}
						value={port}
						onChange={(v) => setPort(typeof v === "number" ? v : 7778)}
						min={1024}
						max={65535}
					/>
					<TextInput
						label={t("defaultProjectDir")}
						value={projectDir}
						onChange={(e) => setProjectDir(e.currentTarget.value)}
					/>
				</Stack>
			</Paper>

			{/* Agent */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("agentSection")}</Title>
					<Select
						label={t("defaultModel")}
						data={allModels}
						searchable
						value={defaultModel}
						onChange={(v) => setDefaultModel(v ?? "claude-sonnet")}
					/>
					<Select
						label={t("permissionMode")}
						data={[
							{ value: "default", label: tn("perm_default") },
							{ value: "acceptEdits", label: tn("perm_acceptEdits") },
							{ value: "bypassPermissions", label: tn("perm_bypassPermissions") },
							{ value: "dontAsk", label: tn("perm_dontAsk") },
						]}
						leftSection={
							permissionMode === "default" ? (
								<IconShield size={14} />
							) : permissionMode === "acceptEdits" ? (
								<IconPencilCheck size={14} />
							) : permissionMode === "bypassPermissions" ? (
								<IconShieldOff size={14} />
							) : permissionMode === "dontAsk" ? (
								<IconHandStop size={14} />
							) : (
								<IconShield size={14} />
							)
						}
						renderOption={({ option, checked }) => {
							const icons: Record<string, React.ReactNode> = {
								default: <IconShield size={14} />,
								acceptEdits: <IconPencilCheck size={14} />,
								bypassPermissions: <IconShieldOff size={14} />,
								dontAsk: <IconHandStop size={14} />,
							};
							return (
								<Group gap="xs" wrap="nowrap">
									{icons[option.value] ?? <IconShield size={14} />}
									<Text size="sm" fw={checked ? 600 : 400}>
										{option.label}
									</Text>
								</Group>
							);
						}}
						value={permissionMode}
						onChange={(v) => setPermissionMode(v ?? "default")}
					/>
					<Select
						label={t("summaryModel")}
						data={allModels}
						searchable
						value={summaryModel}
						onChange={(v) => setSummaryModel(v ?? "claude-haiku")}
					/>
					<Stack gap="xs">
						<Text size="sm" fw={500}>
							{t("customModels")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("customModelsDesc")}
						</Text>
						{BUILTIN_MODELS.map((m) => (
							<Group key={m.value} gap="xs">
								<TextInput value={m.value} disabled style={{ flex: 1 }} />
								<TextInput value={m.label} disabled style={{ flex: 1 }} />
							</Group>
						))}
						{customModels.map((m) => (
							<Group key={m.value} gap="xs">
								<TextInput value={m.value} disabled style={{ flex: 1 }} />
								<TextInput value={m.label} disabled style={{ flex: 1 }} />
								<ActionIcon color="red" variant="subtle" onClick={() => handleRemoveModel(m.value)}>
									✕
								</ActionIcon>
							</Group>
						))}
						<Group gap="xs">
							<TextInput
								placeholder={t("modelValuePlaceholder")}
								value={newModelValue}
								onChange={(e) => setNewModelValue(e.currentTarget.value)}
								style={{ flex: 1 }}
							/>
							<TextInput
								placeholder={t("modelLabelPlaceholder")}
								value={newModelLabel}
								onChange={(e) => setNewModelLabel(e.currentTarget.value)}
								style={{ flex: 1 }}
							/>
							<ActionIcon
								variant="light"
								onClick={handleAddModel}
								disabled={!newModelValue.trim() || !newModelLabel.trim()}
							>
								+
							</ActionIcon>
						</Group>
					</Stack>
				</Stack>
			</Paper>

			{/* Chapters */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("chaptersSection")}</Title>
					<NumberInput
						label={t("maxActiveWorktrees")}
						value={maxWorktrees}
						onChange={(v) => setMaxWorktrees(typeof v === "number" ? v : 10)}
						min={1}
						max={50}
					/>
					<NumberInput
						label={t("maxActiveContainers")}
						value={maxContainers}
						onChange={(v) => setMaxContainers(typeof v === "number" ? v : 5)}
						min={1}
						max={20}
					/>
					<NumberInput
						label={t("worktreeSizeWarning")}
						value={sizeWarning}
						onChange={(v) => setSizeWarning(typeof v === "number" ? v : 500)}
						min={100}
						suffix=" MB"
					/>
					<Switch
						label={t("autoSaveOnDormant")}
						checked={autoSave}
						onChange={(e) => setAutoSave(e.currentTarget.checked)}
					/>
					<NumberInput
						label={t("dormantAfterMinutes")}
						description={t("dormantAfterMinutesDesc")}
						value={dormantMinutes}
						onChange={(v) => setDormantMinutes(typeof v === "number" ? v : 0)}
						min={0}
					/>
				</Stack>
			</Paper>

			{/* Containers */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("containersSection")}</Title>
					<NumberInput
						label={t("portRangeStart")}
						value={portStart}
						onChange={(v) => setPortStart(typeof v === "number" ? v : 10000)}
						min={1024}
						max={65535}
					/>
					<NumberInput
						label={t("portRangeEnd")}
						value={portEnd}
						onChange={(v) => setPortEnd(typeof v === "number" ? v : 20000)}
						min={1024}
						max={65535}
					/>
				</Stack>
			</Paper>

			{/* Editor */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("editorSection")}</Title>
					<Select
						label={t("editorType")}
						data={[
							{ value: "vscode", label: "VS Code" },
							{ value: "cursor", label: "Cursor" },
							{ value: "windsurf", label: "Windsurf" },
							{ value: "zed", label: "Zed" },
						]}
						value={editor}
						onChange={(v) => setEditor(v ?? "vscode")}
					/>
				</Stack>
			</Paper>

			{/* Session (per-user preferences) */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("sessionSection")}</Title>
					<Switch
						label={t("autoLoadOlderMessages")}
						description={t("autoLoadOlderMessagesDesc")}
						checked={userPrefs?.autoLoadOlderMessages ?? true}
						onChange={(e) =>
							updateUserPref.mutate({ autoLoadOlderMessages: e.currentTarget.checked })
						}
					/>
				</Stack>
			</Paper>

			{/* Word Wrap Defaults (per-user preferences) */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("wordWrapSection")}</Title>
					<Switch
						label={t("wordWrapMarkdown")}
						checked={userPrefs?.wordWrapMarkdown ?? true}
						onChange={(e) =>
							updateUserPref.mutate({ wordWrapMarkdown: e.currentTarget.checked })
						}
					/>
					<Switch
						label={t("wordWrapCode")}
						checked={userPrefs?.wordWrapCode ?? true}
						onChange={(e) =>
							updateUserPref.mutate({ wordWrapCode: e.currentTarget.checked })
						}
					/>
					<Switch
						label={t("wordWrapDiff")}
						checked={userPrefs?.wordWrapDiff ?? true}
						onChange={(e) =>
							updateUserPref.mutate({ wordWrapDiff: e.currentTarget.checked })
						}
					/>
				</Stack>
			</Paper>

			{/* Theme */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("themeSection")}</Title>
					<ThemeSwitcher />
				</Stack>
			</Paper>

			{/* Language */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("languageSection")}</Title>
					<LanguageSwitcher />
				</Stack>
			</Paper>

			<Affix position={{ bottom: 24, right: 24 }}>
				<Transition transition="slide-up" mounted={isDirty}>
					{(styles) => (
						<Button
							onClick={handleSave}
							loading={updateSettings.isPending}
							size="md"
							style={{
								...styles,
								boxShadow: "0 4px 14px rgba(0, 0, 0, 0.25)",
								animation: highlight ? "settingsPulse 1.5s ease" : undefined,
							}}
						>
							{t("unsavedSave")}
						</Button>
					)}
				</Transition>
			</Affix>

			<style>{`
				@keyframes settingsPulse {
					0% { box-shadow: 0 0 0 0 var(--mantine-color-indigo-5); }
					40% { box-shadow: 0 0 0 10px transparent; }
					100% { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); }
				}
			`}</style>
		</Stack>
	);
}
