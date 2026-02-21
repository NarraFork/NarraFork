import {
	ActionIcon,
	Affix,
	Badge,
	Button,
	Group,
	Loader,
	NativeSelect,
	NumberInput,
	Paper,
	PasswordInput,
	Select,
	Slider,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
	Transition,
} from "@mantine/core";
import {
	IconEye,
	IconEyeOff,
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
import { TERMINAL_THEMES } from "../../components/terminal/terminal-theme";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { BUILTIN_MODELS, groupModelsByProvider, type ModelOption } from "../../lib/constants";

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
	const [customModels, setCustomModels] = useState<
		Array<{ value: string; label: string; provider?: string }>
	>([]);
	const [newModelValue, setNewModelValue] = useState("");
	const [newModelLabel, setNewModelLabel] = useState("");
	const [newModelProvider, setNewModelProvider] = useState("openai");
	const [extendedContext, setExtendedContext] = useState(false);
	const [maxTurns, setMaxTurns] = useState(200);
	const [hiddenModels, setHiddenModels] = useState<string[]>([]);
	const [localFontSize, setLocalFontSize] = useState<number | null>(null);
	// OpenAI
	const [openaiApiKey, setOpenaiApiKey] = useState("");
	const [openaiBaseUrl, setOpenaiBaseUrl] = useState("");
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
		customModels: [] as Array<{ value: string; label: string; provider?: string }>,
		hiddenModels: [] as string[],
		extendedContext: false,
		maxTurns: 200,
		maxWorktrees: 10,
		maxContainers: 5,
		sizeWarning: 500,
		autoSave: true,
		dormantMinutes: 0,
		portStart: 10000,
		portEnd: 20000,
		editor: "vscode",
		openaiApiKey: "",
		openaiBaseUrl: "",
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
				hiddenModels: settings.agent?.hiddenModels ?? [],
				extendedContext: settings.agent?.extendedContext ?? false,
				maxTurns: settings.agent?.maxTurns ?? 200,
				maxWorktrees: settings.chapters?.maxActiveWorktrees ?? 10,
				maxContainers: settings.chapters?.maxActiveContainers ?? 5,
				sizeWarning: settings.chapters?.worktreeSizeWarningMb ?? 500,
				autoSave: settings.chapters?.autoSaveOnDormant ?? true,
				dormantMinutes: settings.chapters?.dormantAfterMinutes ?? 0,
				portStart: settings.containers?.portRangeStart ?? 10000,
				portEnd: settings.containers?.portRangeEnd ?? 20000,
				editor: settings.editor?.type ?? "vscode",
				openaiApiKey: settings.openai?.apiKey ?? "",
				openaiBaseUrl: settings.openai?.baseUrl ?? "",
			};
			serverSnapshot.current = snap;
			setPort(snap.port);
			setProjectDir(snap.projectDir);
			setDefaultModel(snap.defaultModel);
			setPermissionMode(snap.permissionMode);
			setSummaryModel(snap.summaryModel);
			setCustomModels(snap.customModels);
			setHiddenModels(snap.hiddenModels);
			setExtendedContext(snap.extendedContext);
			setMaxTurns(snap.maxTurns);
			setMaxWorktrees(snap.maxWorktrees);
			setMaxContainers(snap.maxContainers);
			setSizeWarning(snap.sizeWarning);
			setAutoSave(snap.autoSave);
			setDormantMinutes(snap.dormantMinutes);
			setPortStart(snap.portStart);
			setPortEnd(snap.portEnd);
			setEditor(snap.editor);
			setOpenaiApiKey(snap.openaiApiKey);
			setOpenaiBaseUrl(snap.openaiBaseUrl);
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
			JSON.stringify(hiddenModels) !== JSON.stringify(s.hiddenModels) ||
			extendedContext !== s.extendedContext ||
			maxTurns !== s.maxTurns ||
			maxWorktrees !== s.maxWorktrees ||
			maxContainers !== s.maxContainers ||
			sizeWarning !== s.sizeWarning ||
			autoSave !== s.autoSave ||
			dormantMinutes !== s.dormantMinutes ||
			portStart !== s.portStart ||
			portEnd !== s.portEnd ||
			editor !== s.editor ||
			openaiApiKey !== s.openaiApiKey ||
			openaiBaseUrl !== s.openaiBaseUrl
		);
	}, [
		initialized,
		port,
		projectDir,
		defaultModel,
		permissionMode,
		summaryModel,
		customModels,
		hiddenModels,
		extendedContext,
		maxTurns,
		maxWorktrees,
		maxContainers,
		sizeWarning,
		autoSave,
		dormantMinutes,
		portStart,
		portEnd,
		editor,
		openaiApiKey,
		openaiBaseUrl,
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

				.map((m: any) => ({
					value: String(m.model_id ?? m.modelId ?? ""),
					label: String(
						m.model_short_name ??
							m.modelShortName ??
							m.model_name ??
							m.modelName ??
							m.model_id ??
							m.modelId ??
							"",
					),
					rateMultiplier: m.rate_multiplier ?? m.rateMultiplier,
				}))
				.filter((m: ModelOption) => m.value)
		: BUILTIN_MODELS;
	const visibleModels = allModels.filter((m) => !hiddenModels.includes(m.value));
	const groupedModels = groupModelsByProvider(visibleModels, {
		openai: t("modelProviderOpenAI"),
	});

	const handleAddModel = () => {
		const v = newModelValue.trim();
		const l = newModelLabel.trim();
		if (!v || !l) return;
		if (allModels.some((m) => m.value === v)) return;
		setCustomModels([...customModels, { value: v, label: l, provider }]);
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
					hiddenModels,
					extendedContext,
					maxTurns,
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
				openai: {
					apiKey: openaiApiKey,
					baseUrl: openaiBaseUrl,
				},
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
						hiddenModels: [...hiddenModels],
						extendedContext,
						maxTurns,
						maxWorktrees,
						maxContainers,
						sizeWarning,
						autoSave,
						dormantMinutes,
						portStart,
						portEnd,
						editor,
						openaiApiKey,
						openaiBaseUrl,
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
						data={groupedModels}
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
						data={groupedModels}
						searchable
						value={summaryModel}
						onChange={(v) => setSummaryModel(v ?? "claude-haiku")}
					/>
					<Switch
						label={t("extendedContext")}
						description={t("extendedContextDesc")}
						checked={extendedContext}
						onChange={(e) => setExtendedContext(e.currentTarget.checked)}
					/>
					<NumberInput
						label={t("maxTurns")}
						description={t("maxTurnsDesc")}
						value={maxTurns}
						onChange={(v) => setMaxTurns(typeof v === "number" ? v : 200)}
						min={1}
						max={1000}
					/>
					<Stack gap="xs">
						<Text size="sm" fw={500}>
							{t("customModels")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("customModelsDesc")}
						</Text>
							const isHidden = hiddenModels.includes(m.value);
							return (
								<Group key={m.value} gap="xs" style={isHidden ? { opacity: 0.5 } : undefined}>
									<TextInput value={m.value} disabled style={{ flex: 1 }} />
									<TextInput value={m.label} disabled style={{ flex: 1 }} />
									<Badge size="sm" variant="light" color="violet" w={70}>
									</Badge>
									<ActionIcon
										variant="subtle"
										color={isHidden ? "gray" : "blue"}
										onClick={() =>
											setHiddenModels((prev) =>
												isHidden ? prev.filter((id) => id !== m.value) : [...prev, m.value],
											)
										}
									>
										{isHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
									</ActionIcon>
								</Group>
							);
						})}
						{customModels.map((m) => (
							<Group key={m.value} gap="xs">
								<TextInput value={m.value} disabled style={{ flex: 1 }} />
								<TextInput value={m.label} disabled style={{ flex: 1 }} />
								<Badge
									size="sm"
									variant="light"
									w={70}
								>
								</Badge>
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
								<Badge size="sm" variant="light" color="teal" w={90}>
									OpenAI
								</Badge>
							) : (
								<NativeSelect
									size="xs"
									data={[
										{ value: "openai", label: "OpenAI" },
									]}
									value={newModelProvider}
									onChange={(e) => setNewModelProvider(e.currentTarget.value)}
									w={90}
								/>
							)}
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

			{/* OpenAI */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("openaiSection")}</Title>
					<Text size="xs" c="dimmed">
						{t("openaiSectionDesc")}
					</Text>
					<PasswordInput
						label={t("openaiApiKey")}
						placeholder={t("openaiApiKeyPlaceholder")}
						value={openaiApiKey}
						onChange={(e) => setOpenaiApiKey(e.currentTarget.value)}
					/>
					<TextInput
						label={t("openaiBaseUrl")}
						placeholder={t("openaiBaseUrlPlaceholder")}
						value={openaiBaseUrl}
						onChange={(e) => setOpenaiBaseUrl(e.currentTarget.value)}
					/>
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
					<Switch
						label={t("replyInUserLanguage")}
						description={t("replyInUserLanguageDesc")}
						checked={userPrefs?.replyInUserLanguage ?? true}
						onChange={(e) =>
							updateUserPref.mutate({ replyInUserLanguage: e.currentTarget.checked })
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
						onChange={(e) => updateUserPref.mutate({ wordWrapMarkdown: e.currentTarget.checked })}
					/>
					<Switch
						label={t("wordWrapCode")}
						checked={userPrefs?.wordWrapCode ?? true}
						onChange={(e) => updateUserPref.mutate({ wordWrapCode: e.currentTarget.checked })}
					/>
					<Switch
						label={t("wordWrapDiff")}
						checked={userPrefs?.wordWrapDiff ?? true}
						onChange={(e) => updateUserPref.mutate({ wordWrapDiff: e.currentTarget.checked })}
					/>
				</Stack>
			</Paper>

			{/* Terminal */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("terminalSection")}</Title>
					<Select
						label={t("terminalTheme")}
						data={[
							{ value: "auto", label: t("terminalThemeAuto") },
							...TERMINAL_THEMES.map((th) => ({ value: th.key, label: th.label })),
						]}
						value={userPrefs?.terminalTheme ?? "auto"}
						onChange={(v) => updateUserPref.mutate({ terminalTheme: v ?? "auto" })}
					/>
					<Stack gap={4}>
						<Text size="sm" fw={500}>
							{t("terminalFontSize")}
						</Text>
						<Group>
							<Slider
								value={localFontSize ?? userPrefs?.terminalFontSize ?? 14}
								onChange={setLocalFontSize}
								onChangeEnd={(v) => {
									setLocalFontSize(null);
									updateUserPref.mutate({ terminalFontSize: v });
								}}
								min={8}
								max={32}
								step={1}
								style={{ flex: 1 }}
								marks={[
									{ value: 8, label: "8" },
									{ value: 14, label: "14" },
									{ value: 20, label: "20" },
									{ value: 32, label: "32" },
								]}
							/>
						</Group>
					</Stack>
				</Stack>
			</Paper>

			{/* Debug (per-user preferences) */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("debugSection")}</Title>
					<Switch
						label={t("showTokenUsage")}
						description={t("showTokenUsageDesc")}
						checked={userPrefs?.showTokenUsage ?? false}
						onChange={(e) => updateUserPref.mutate({ showTokenUsage: e.currentTarget.checked })}
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
