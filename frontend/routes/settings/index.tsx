import {
	Affix,
	Badge,
	Button,
	FileInput,
	Group,
	Loader,
	NumberInput,
	Paper,
	PasswordInput,
	SegmentedControl,
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
	IconBell,
	IconHandStop,
	IconPencilCheck,
	IconPlayerPlay,
	IconRefresh,
	IconShield,
	IconShieldOff,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type CommandDef, CommandsEditor } from "../../components/common/CommandsEditor";
import { LanguageSwitcher } from "../../components/LanguageSwitcher";
import { ThemeSwitcher } from "../../components/ThemeSwitcher";
import { TERMINAL_THEMES } from "../../components/terminal/terminal-theme";
import { useLocalPref } from "../../hooks/useLocalPref";
import { useAllModels } from "../../hooks/useModels";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import {
	BUILTIN_SOUND_NAMES,
	playBuiltinSound,
	playCustomSound,
} from "../../lib/notification-sound";

function ensurePrefix(val: string): string {
	if (!val || val.includes(":")) return val;
	return `openai:${val}`;
}

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
	const navigate = useNavigate();

	// Per-user preferences (account-independent)
	const { data: userPrefs } = useUserPreferences();
	const updateUserPref = useUpdateUserPreferences();

	// Fullscreen mode (local-only)
	const [isFullscreen, setIsFullscreen] = useLocalPref("narrafork_fullscreen");
	useEffect(() => {
		const handler = () => {
			const fs = !!document.fullscreenElement;
			setIsFullscreen(fs);
		};
		document.addEventListener("fullscreenchange", handler);
		return () => document.removeEventListener("fullscreenchange", handler);
	}, [setIsFullscreen]);

	// OLED mode (local-only)
	const [oledMode, setOledMode] = useLocalPref("narrafork_oled");

	// PWA cache refresh (does not check for backend updates)
	const [pwaUpdating, setPwaUpdating] = useState(false);

	const handlePwaUpdate = async () => {
		setPwaUpdating(true);
		try {
			// Unregister service worker so stale cache won't be served
			const reg = await navigator.serviceWorker?.getRegistration();
			await reg?.unregister();
			// Purge all caches (workbox precache, runtime, etc.)
			const keys = await caches.keys();
			await Promise.all(keys.map((k) => caches.delete(k)));
		} catch {
			// ignore — proceed to reload regardless
		}
		window.location.reload();
	};

	// Server
	const [port, setPort] = useState<number | undefined>();
	const [projectDir, setProjectDir] = useState("");
	// Agent
	const [permissionMode, setPermissionMode] = useState("default");
	const [maxTurns, setMaxTurns] = useState(200);
	const [subagentExploreModel, setSubagentExploreModel] = useState("");
	const [subagentPlanModel, setSubagentPlanModel] = useState("");
	const [legacyEncoding, setLegacyEncoding] = useState(false);
	const [planTimeoutAction, setPlanTimeoutAction] = useState("deny");
	const [codexDefaultReasoningEffort, setCodexDefaultReasoningEffort] = useState("");
	const [localFontSize, setLocalFontSize] = useState<number | null>(null);
	// Chapters
	const [maxWorktrees, setMaxWorktrees] = useState(10);
	const [maxContainers, setMaxContainers] = useState(5);
	const [sizeWarning, setSizeWarning] = useState(500);
	const [autoSave, setAutoSave] = useState(true);
	const [dormantMinutes, setDormantMinutes] = useState(0);
	// Auto-commit thresholds
	const [acReminderLines, setAcReminderLines] = useState(1000);
	const [acReminderFiles, setAcReminderFiles] = useState(10);
	const [acForceLines, setAcForceLines] = useState(2000);
	const [acForceFiles, setAcForceFiles] = useState(25);
	// Containers
	const [portStart, setPortStart] = useState(10000);
	const [portEnd, setPortEnd] = useState(20000);
	const [proxyEnabled, setProxyEnabled] = useState(false);
	const [proxyPort, setProxyPort] = useState(7780);
	// Editor (kept for backward compat but no longer shown in UI)
	const [editor] = useState("vscode");

	const [initialized, setInitialized] = useState(false);
	const [highlight, setHighlight] = useState(false);
	const prevDirty = useRef(false);

	// Snapshot of server values for dirty comparison
	const serverSnapshot = useRef({
		port: 7778 as number | undefined,
		projectDir: "",
		permissionMode: "default",
		maxTurns: 200,
		subagentExploreModel: "",
		subagentPlanModel: "",
		maxWorktrees: 10,
		maxContainers: 5,
		sizeWarning: 500,
		autoSave: true,
		dormantMinutes: 0,
		acReminderLines: 1000,
		acReminderFiles: 10,
		acForceLines: 2000,
		acForceFiles: 25,
		portStart: 10000,
		portEnd: 20000,
		proxyEnabled: false,
		proxyPort: 7780,
		legacyEncoding: false,
		planTimeoutAction: "deny",
		codexDefaultReasoningEffort: "",
	});

	useEffect(() => {
		if (settings && !initialized) {
			const snap = {
				port: settings.server?.port ?? 7778,
				projectDir: settings.paths?.defaultProjectDir ?? "",
				permissionMode: settings.agent?.defaultPermissionMode ?? "default",
				maxTurns: settings.agent?.maxTurns ?? 200,
				subagentExploreModel: ensurePrefix(settings.agent?.subagentModels?.explore ?? ""),
				subagentPlanModel: ensurePrefix(settings.agent?.subagentModels?.plan ?? ""),
				maxWorktrees: settings.chapters?.maxActiveWorktrees ?? 10,
				maxContainers: settings.chapters?.maxActiveContainers ?? 5,
				sizeWarning: settings.chapters?.worktreeSizeWarningMb ?? 500,
				autoSave: settings.chapters?.autoSaveOnDormant ?? true,
				dormantMinutes: settings.chapters?.dormantAfterMinutes ?? 0,
				acReminderLines: settings.chapters?.autoCommitReminderLines ?? 1000,
				acReminderFiles: settings.chapters?.autoCommitReminderFiles ?? 10,
				acForceLines: settings.chapters?.autoCommitForceLines ?? 2000,
				acForceFiles: settings.chapters?.autoCommitForceFiles ?? 25,
				portStart: settings.containers?.portRangeStart ?? 10000,
				portEnd: settings.containers?.portRangeEnd ?? 20000,
				proxyEnabled: settings.containers?.proxy?.enabled ?? false,
				proxyPort: settings.containers?.proxy?.port ?? 7780,
				legacyEncoding: settings.agent?.legacyEncoding ?? false,
				planTimeoutAction: settings.agent?.planTimeoutAction ?? "deny",
				codexDefaultReasoningEffort: settings.codex?.defaultReasoningEffort ?? "",
			};
			serverSnapshot.current = snap;
			setPort(snap.port);
			setProjectDir(snap.projectDir);
			setDefaultModel(snap.defaultModel);
			setPermissionMode(snap.permissionMode);
			setSummaryModel(snap.summaryModel);
			setMaxTurns(snap.maxTurns);
			setSubagentExploreModel(snap.subagentExploreModel);
			setSubagentPlanModel(snap.subagentPlanModel);
			setMaxWorktrees(snap.maxWorktrees);
			setMaxContainers(snap.maxContainers);
			setSizeWarning(snap.sizeWarning);
			setAutoSave(snap.autoSave);
			setDormantMinutes(snap.dormantMinutes);
			setAcReminderLines(snap.acReminderLines);
			setAcReminderFiles(snap.acReminderFiles);
			setAcForceLines(snap.acForceLines);
			setAcForceFiles(snap.acForceFiles);
			setPortStart(snap.portStart);
			setPortEnd(snap.portEnd);
			setProxyEnabled(snap.proxyEnabled);
			setProxyPort(snap.proxyPort);
			setLegacyEncoding(snap.legacyEncoding);
			setPlanTimeoutAction(snap.planTimeoutAction);
			setCodexDefaultReasoningEffort(snap.codexDefaultReasoningEffort);
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
			maxTurns !== s.maxTurns ||
			subagentExploreModel !== s.subagentExploreModel ||
			subagentPlanModel !== s.subagentPlanModel ||
			maxWorktrees !== s.maxWorktrees ||
			maxContainers !== s.maxContainers ||
			sizeWarning !== s.sizeWarning ||
			autoSave !== s.autoSave ||
			dormantMinutes !== s.dormantMinutes ||
			acReminderLines !== s.acReminderLines ||
			acReminderFiles !== s.acReminderFiles ||
			acForceLines !== s.acForceLines ||
			acForceFiles !== s.acForceFiles ||
			portStart !== s.portStart ||
			portEnd !== s.portEnd ||
			proxyEnabled !== s.proxyEnabled ||
			proxyPort !== s.proxyPort ||
			legacyEncoding !== s.legacyEncoding ||
			planTimeoutAction !== s.planTimeoutAction ||
			codexDefaultReasoningEffort !== s.codexDefaultReasoningEffort
		);
	}, [
		initialized,
		port,
		projectDir,
		defaultModel,
		permissionMode,
		summaryModel,
		maxTurns,
		subagentExploreModel,
		subagentPlanModel,
		maxWorktrees,
		maxContainers,
		sizeWarning,
		autoSave,
		dormantMinutes,
		acReminderLines,
		acReminderFiles,
		acForceLines,
		acForceFiles,
		portStart,
		portEnd,
		proxyEnabled,
		proxyPort,
		legacyEncoding,
		planTimeoutAction,
		codexDefaultReasoningEffort,
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

	// Models from central hook (must be before early returns)
	const { groupedModels } = useAllModels();

	if (isLoading) return <Loader />;

	const handleSave = () => {
		updateSettings.mutate(
			{
				server: { port },
				paths: { defaultProjectDir: projectDir },
				agent: {
					defaultModel,
					defaultPermissionMode: permissionMode,
					summaryModel,
					maxTurns,
					subagentModels: {
						explore: subagentExploreModel,
						plan: subagentPlanModel,
					},
					legacyEncoding,
					planTimeoutAction,
				},
				chapters: {
					maxActiveWorktrees: maxWorktrees,
					maxActiveContainers: maxContainers,
					worktreeSizeWarningMb: sizeWarning,
					autoSaveOnDormant: autoSave,
					dormantAfterMinutes: dormantMinutes,
					autoCommitReminderLines: acReminderLines,
					autoCommitReminderFiles: acReminderFiles,
					autoCommitForceLines: acForceLines,
					autoCommitForceFiles: acForceFiles,
				},
				containers: {
					portRangeStart: portStart,
					portRangeEnd: portEnd,
					proxy: {
						enabled: proxyEnabled,
						port: proxyPort,
					},
				},
				editor: { type: editor },
				codex: {
					defaultReasoningEffort:
						(codexDefaultReasoningEffort as "low" | "medium" | "high" | "xhigh") || null,
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
						maxTurns,
						subagentExploreModel,
						subagentPlanModel,
						maxWorktrees,
						maxContainers,
						sizeWarning,
						autoSave,
						dormantMinutes,
						acReminderLines,
						acReminderFiles,
						acForceLines,
						acForceFiles,
						portStart,
						portEnd,
						proxyEnabled,
						proxyPort,
						legacyEncoding,
						planTimeoutAction,
						codexDefaultReasoningEffort,
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
							{t("subagentModels")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("subagentModelsDesc")}
						</Text>
						<Select
							label={t("subagentExploreModel")}
							data={groupedModels}
							searchable
							clearable
							placeholder={t("subagentModelInherit")}
							value={subagentExploreModel || null}
							onChange={(v) => setSubagentExploreModel(v ?? "")}
						/>
						<Select
							label={t("subagentPlanModel")}
							data={groupedModels}
							searchable
							clearable
							placeholder={t("subagentModelInherit")}
							value={subagentPlanModel || null}
							onChange={(v) => setSubagentPlanModel(v ?? "")}
						/>
					</Stack>
					<Switch
						label={t("legacyEncoding")}
						description={t("legacyEncodingDesc")}
						checked={legacyEncoding}
						onChange={(e) => setLegacyEncoding(e.currentTarget.checked)}
					/>
					<Select
						label={t("planTimeoutAction")}
						description={t("planTimeoutActionDesc")}
						data={[
							{ value: "deny", label: t("planTimeoutDeny") },
							{ value: "auto_approve", label: t("planTimeoutAutoApprove") },
						]}
						value={planTimeoutAction}
						onChange={(v) => setPlanTimeoutAction(v ?? "deny")}
					/>
					<Select
						label={t("codexDefaultReasoningEffort")}
						description={t("codexDefaultReasoningEffortDesc")}
						data={[
							{ value: "auto", label: tn("reasoning_auto") },
							{ value: "low", label: tn("reasoning_low") },
							{ value: "medium", label: tn("reasoning_medium") },
							{ value: "high", label: tn("reasoning_high") },
							{ value: "xhigh", label: tn("reasoning_xhigh") },
						]}
						value={codexDefaultReasoningEffort || "auto"}
						onChange={(v) => setCodexDefaultReasoningEffort(v === "auto" ? "" : (v ?? ""))}
					/>
					<Button variant="light" onClick={() => navigate({ to: "/admin/providers" })}>
						{t("customModels")} →
					</Button>
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
					<Title order={5} mt="sm">
						{t("autoCommitSection")}
					</Title>
					<NumberInput
						label={t("autoCommitReminderLines")}
						description={t("autoCommitReminderLinesDesc")}
						value={acReminderLines}
						onChange={(v) => setAcReminderLines(typeof v === "number" ? v : 1000)}
						min={0}
						step={50}
					/>
					<NumberInput
						label={t("autoCommitReminderFiles")}
						description={t("autoCommitReminderFilesDesc")}
						value={acReminderFiles}
						onChange={(v) => setAcReminderFiles(typeof v === "number" ? v : 10)}
						min={0}
					/>
					<NumberInput
						label={t("autoCommitForceLines")}
						description={t("autoCommitForceLinesDesc")}
						value={acForceLines}
						onChange={(v) => setAcForceLines(typeof v === "number" ? v : 2000)}
						min={0}
						step={100}
					/>
					<NumberInput
						label={t("autoCommitForceFiles")}
						description={t("autoCommitForceFilesDesc")}
						value={acForceFiles}
						onChange={(v) => setAcForceFiles(typeof v === "number" ? v : 25)}
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
					<Switch
						label={t("proxyEnabled")}
						description={t("proxyEnabledDesc")}
						checked={proxyEnabled}
						onChange={(e) => setProxyEnabled(e.currentTarget.checked)}
					/>
					{proxyEnabled && (
						<NumberInput
							label={t("proxyPort")}
							description={t("proxyPortDesc")}
							value={proxyPort}
							onChange={(v) => setProxyPort(typeof v === "number" ? v : 7780)}
							min={1024}
							max={65535}
						/>
					)}
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

			{/* Notifications (per-user preferences) */}
			<NotificationSettings userPrefs={userPrefs} updateUserPref={updateUserPref} t={t} />

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
					<Switch
						label={t("showOutputStats")}
						description={t("showOutputStatsDesc")}
						checked={userPrefs?.showOutputStats ?? false}
						onChange={(e) => updateUserPref.mutate({ showOutputStats: e.currentTarget.checked })}
					/>
				</Stack>
			</Paper>

			{/* Theme */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("themeSection")}</Title>
					<ThemeSwitcher />
					<Switch
						label={t("oledMode")}
						description={t("oledModeDesc")}
						checked={oledMode}
						onChange={(e) => setOledMode(e.currentTarget.checked)}
					/>
				</Stack>
			</Paper>

			{/* Display */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("displaySection")}</Title>
					<Switch
						label={t("ignoreSafeArea")}
						description={t("ignoreSafeAreaDesc")}
						checked={isFullscreen}
						onChange={(e) => {
							const on = e.currentTarget.checked;
							setIsFullscreen(on);
							localStorage.setItem("narrafork_fullscreen", String(on));
							if (on) {
								document.documentElement.requestFullscreen?.().catch(() => {});
							} else if (document.fullscreenElement) {
								document.exitFullscreen?.().catch(() => {});
							}
						}}
					/>
				</Stack>
			</Paper>

			{/* Language */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("languageSection")}</Title>
					<LanguageSwitcher />
				</Stack>
			</Paper>

			{/* Slash Commands */}
			<Paper withBorder p="md">
				<Stack>
					<div>
						<Title order={4}>{t("commandsSection")}</Title>
						<Text size="xs" c="dimmed">
							{t("commandsSectionDesc")}
						</Text>
					</div>
					<CommandsEditor
						commands={(userPrefs?.commands ?? []) as CommandDef[]}
						onChange={(cmds) => updateUserPref.mutate({ commands: cmds })}
					/>
				</Stack>
			</Paper>

			{/* PWA Update */}
			<Paper withBorder p="md">
				<Stack>
					<Title order={4}>{t("pwaSection")}</Title>
					<Text size="sm" c="dimmed">
						{t("pwaForceUpdateDesc")}
					</Text>
					<Button
						leftSection={<IconRefresh size={16} />}
						variant="default"
						loading={pwaUpdating}
						onClick={handlePwaUpdate}
					>
						{pwaUpdating ? t("pwaUpdating") : t("pwaForceUpdate")}
					</Button>
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

// === Notification Settings Sub-component ===

function NotificationSettings({
	userPrefs,
	updateUserPref,
	t,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic prefs type
	userPrefs: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation hook type
	updateUserPref: any;
	t: (key: string, opts?: Record<string, unknown>) => string;
}) {
	const [pwaPermission, setPwaPermission] = useState(
		"Notification" in window ? Notification.permission : "denied",
	);
	const [testingDingtalk, setTestingDingtalk] = useState(false);
	const [testingFeishu, setTestingFeishu] = useState(false);
	const [testResult, setTestResult] = useState<{
		type: string;
		ok: boolean;
		error?: string;
	} | null>(null);
	// Local state for webhook fields (only saved on blur to avoid masked-value issues)
	const [dingtalkWebhook, setDingtalkWebhook] = useState("");
	const [dingtalkSecret, setDingtalkSecret] = useState("");
	const [feishuWebhook, setFeishuWebhook] = useState("");
	const [feishuSecret, setFeishuSecret] = useState("");
	const [webhookInited, setWebhookInited] = useState(false);

	// Initialize local webhook state from prefs (once)
	useEffect(() => {
		if (userPrefs && !webhookInited) {
			setDingtalkWebhook(userPrefs.notifyDingtalkWebhook ?? "");
			setDingtalkSecret(userPrefs.notifyDingtalkSecret ?? "");
			setFeishuWebhook(userPrefs.notifyFeishuWebhook ?? "");
			setFeishuSecret(userPrefs.notifyFeishuSecret ?? "");
			setWebhookInited(true);
		}
	}, [userPrefs, webhookInited]);

	const soundOptions = BUILTIN_SOUND_NAMES.map((name) => ({
		value: name,
		label: t(`notifySound${name.charAt(0).toUpperCase()}${name.slice(1)}`),
	}));

	const handleRequestPwaPermission = async () => {
		if (!("Notification" in window)) return;
		const result = await Notification.requestPermission();
		setPwaPermission(result);
		if (result === "granted") {
			updateUserPref.mutate({ notifyPwaEnabled: true });
		}
	};

	const handleSoundUpload = async (file: File | null) => {
		if (!file) return;
		try {
			const result = await api.uploadNotificationSound(file);
			updateUserPref.mutate({
				notifySoundType: "custom",
				notifySoundFileId: result.id,
			});
		} catch {
			// upload failed — ignore
		}
	};

	const handleTestDingtalk = async () => {
		setTestingDingtalk(true);
		setTestResult(null);
		try {
			const res = await api.testDingtalkWebhook(dingtalkWebhook, dingtalkSecret);
			setTestResult({ type: "dingtalk", ok: res.ok, error: res.error });
		} catch (err) {
			setTestResult({
				type: "dingtalk",
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		setTestingDingtalk(false);
	};

	const handleTestFeishu = async () => {
		setTestingFeishu(true);
		setTestResult(null);
		try {
			const res = await api.testFeishuWebhook(feishuWebhook, feishuSecret);
			setTestResult({ type: "feishu", ok: res.ok, error: res.error });
		} catch (err) {
			setTestResult({
				type: "feishu",
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		setTestingFeishu(false);
	};

	const saveWebhookField = (field: string, value: string) => {
		// Don't save masked values back
		if (value.startsWith("*")) return;
		updateUserPref.mutate({ [field]: value });
	};

	return (
		<Paper withBorder p="md">
			<Stack>
				<Group gap="xs">
					<IconBell size={20} />
					<Title order={4}>{t("notificationSection")}</Title>
				</Group>

				{/* Trigger toggles */}
				<Switch
					label={t("notifyOnDone")}
					description={t("notifyOnDoneDesc")}
					checked={userPrefs?.notifyOnDone ?? true}
					onChange={(e) => updateUserPref.mutate({ notifyOnDone: e.currentTarget.checked })}
				/>
				<Switch
					label={t("notifyOnWaiting")}
					description={t("notifyOnWaitingDesc")}
					checked={userPrefs?.notifyOnWaiting ?? true}
					onChange={(e) => updateUserPref.mutate({ notifyOnWaiting: e.currentTarget.checked })}
				/>

				{/* PWA notifications */}
				<Stack gap="xs" mt="sm">
					<Text size="sm" fw={600}>
						{t("notifyPwaEnabled")}
					</Text>
					<Switch
						label={t("notifyPwaEnabledDesc")}
						checked={userPrefs?.notifyPwaEnabled ?? false}
						onChange={(e) => updateUserPref.mutate({ notifyPwaEnabled: e.currentTarget.checked })}
						disabled={pwaPermission === "denied"}
					/>
					{pwaPermission === "default" && (
						<Button variant="light" size="xs" onClick={handleRequestPwaPermission}>
							{t("notifyPwaRequestPermission")}
						</Button>
					)}
					{pwaPermission === "granted" && (
						<Badge color="green" variant="light" size="sm">
							{t("notifyPwaPermissionGranted")}
						</Badge>
					)}
					{pwaPermission === "denied" && (
						<Text size="xs" c="dimmed">
							{t("notifyPwaPermissionDenied")}
						</Text>
					)}
				</Stack>

				{/* Sound notifications */}
				<Stack gap="xs" mt="sm">
					<Text size="sm" fw={600}>
						{t("notifySoundEnabled")}
					</Text>
					<Switch
						label={t("notifySoundEnabled")}
						checked={userPrefs?.notifySoundEnabled ?? true}
						onChange={(e) => updateUserPref.mutate({ notifySoundEnabled: e.currentTarget.checked })}
					/>
					{(userPrefs?.notifySoundEnabled ?? true) && (
						<>
							<SegmentedControl
								value={userPrefs?.notifySoundType ?? "builtin"}
								onChange={(v) =>
									updateUserPref.mutate({ notifySoundType: v as "builtin" | "custom" })
								}
								data={[
									{ value: "builtin", label: t("notifySoundBuiltin") },
									{ value: "custom", label: t("notifySoundCustom") },
								]}
								size="xs"
							/>
							{(userPrefs?.notifySoundType ?? "builtin") === "builtin" ? (
								<Group>
									<Select
										data={soundOptions}
										value={userPrefs?.notifySoundBuiltin ?? "gentle"}
										onChange={(v) => updateUserPref.mutate({ notifySoundBuiltin: v ?? "gentle" })}
										size="xs"
										style={{ flex: 1 }}
									/>
									<Button
										variant="subtle"
										size="xs"
										leftSection={<IconPlayerPlay size={14} />}
										onClick={() => playBuiltinSound(userPrefs?.notifySoundBuiltin ?? "gentle")}
									>
										{t("notifySoundPreview")}
									</Button>
								</Group>
							) : (
								<Group>
									<FileInput
										placeholder={t("notifySoundUpload")}
										description={t("notifySoundUploadDesc")}
										accept="audio/mpeg,audio/wav,audio/ogg,audio/webm"
										onChange={handleSoundUpload}
										size="xs"
										style={{ flex: 1 }}
									/>
									{userPrefs?.notifySoundFileId && (
										<Button
											variant="subtle"
											size="xs"
											leftSection={<IconPlayerPlay size={14} />}
											onClick={() =>
												playCustomSound(`/api/notification-sounds/${userPrefs.notifySoundFileId}`)
											}
										>
											{t("notifySoundPreview")}
										</Button>
									)}
								</Group>
							)}
						</>
					)}
				</Stack>

				{/* DingTalk */}
				<Stack gap="xs" mt="sm">
					<Text size="sm" fw={600}>
						{t("notifyDingtalkSection")}
					</Text>
					<Switch
						label={t("notifyDingtalkEnabled")}
						checked={userPrefs?.notifyDingtalkEnabled ?? false}
						onChange={(e) =>
							updateUserPref.mutate({ notifyDingtalkEnabled: e.currentTarget.checked })
						}
					/>
					{(userPrefs?.notifyDingtalkEnabled ?? false) && (
						<>
							<TextInput
								label={t("notifyDingtalkWebhook")}
								placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
								value={dingtalkWebhook}
								onChange={(e) => setDingtalkWebhook(e.currentTarget.value)}
								onBlur={() => saveWebhookField("notifyDingtalkWebhook", dingtalkWebhook)}
								size="xs"
							/>
							<PasswordInput
								label={t("notifyDingtalkSecret")}
								description={t("notifyDingtalkSecretDesc")}
								placeholder="SEC..."
								value={dingtalkSecret}
								onChange={(e) => setDingtalkSecret(e.currentTarget.value)}
								onBlur={() => saveWebhookField("notifyDingtalkSecret", dingtalkSecret)}
								size="xs"
							/>
							<Group>
								<Button
									variant="light"
									size="xs"
									loading={testingDingtalk}
									onClick={handleTestDingtalk}
									disabled={!dingtalkWebhook || dingtalkWebhook.startsWith("*")}
								>
									{t("notifyTestConnection")}
								</Button>
								{testResult?.type === "dingtalk" && (
									<Text size="xs" c={testResult.ok ? "green" : "red"}>
										{testResult.ok
											? t("notifyTestSuccess")
											: t("notifyTestFailed", { error: testResult.error })}
									</Text>
								)}
							</Group>
						</>
					)}
				</Stack>

				{/* Feishu */}
				<Stack gap="xs" mt="sm">
					<Text size="sm" fw={600}>
						{t("notifyFeishuSection")}
					</Text>
					<Switch
						label={t("notifyFeishuEnabled")}
						checked={userPrefs?.notifyFeishuEnabled ?? false}
						onChange={(e) =>
							updateUserPref.mutate({ notifyFeishuEnabled: e.currentTarget.checked })
						}
					/>
					{(userPrefs?.notifyFeishuEnabled ?? false) && (
						<>
							<TextInput
								label={t("notifyFeishuWebhook")}
								placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
								value={feishuWebhook}
								onChange={(e) => setFeishuWebhook(e.currentTarget.value)}
								onBlur={() => saveWebhookField("notifyFeishuWebhook", feishuWebhook)}
								size="xs"
							/>
							<PasswordInput
								label={t("notifyFeishuSecret")}
								description={t("notifyFeishuSecretDesc")}
								value={feishuSecret}
								onChange={(e) => setFeishuSecret(e.currentTarget.value)}
								onBlur={() => saveWebhookField("notifyFeishuSecret", feishuSecret)}
								size="xs"
							/>
							<Group>
								<Button
									variant="light"
									size="xs"
									loading={testingFeishu}
									onClick={handleTestFeishu}
									disabled={!feishuWebhook || feishuWebhook.startsWith("*")}
								>
									{t("notifyTestConnection")}
								</Button>
								{testResult?.type === "feishu" && (
									<Text size="xs" c={testResult.ok ? "green" : "red"}>
										{testResult.ok
											? t("notifyTestSuccess")
											: t("notifyTestFailed", { error: testResult.error })}
									</Text>
								)}
							</Group>
						</>
					)}
				</Stack>
			</Stack>
		</Paper>
	);
}
