import { Accordion, Affix, Button, Group, Loader, Stack, Title, Transition } from "@mantine/core";
import {
	IconBell,
	IconBox,
	IconBrain,
	IconChevronDown,
	IconChevronUp,
	IconCpu,
	IconInfoCircle,
	IconPalette,
	IconServer,
	IconUser,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AvatarCropModal } from "../../components/AvatarCropModal";
import { AboutSection } from "../../components/settings/AboutSection";
import { AgentSection } from "../../components/settings/AgentSection";
import { AppearanceSection } from "../../components/settings/AppearanceSection";
import { ChaptersContainersSection } from "../../components/settings/ChaptersContainersSection";
import { ModelsSection } from "../../components/settings/ModelsSection";
import { NotificationSection } from "../../components/settings/NotificationSection";
import { ProfileSection } from "../../components/settings/ProfileSection";
import { ServerSystemSection } from "../../components/settings/ServerSystemSection";
import {
	useCurrentUser,
	useDeleteAvatar,
	useUpdateProfile,
	useUploadAvatar,
} from "../../hooks/useAuth";
import { useLocalPref } from "../../hooks/useLocalPref";
import { useAllModels } from "../../hooks/useModels";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";

/** Ensure a model value has a "provider:" prefix. */
function ensurePrefix(val: string): string {
	if (!val || val.includes(":")) return val;
	return `openai:${val}`;
}

const ALL_SECTIONS = [
	"profile",
	"models",
	"agent",
	"chaptersContainers",
	"notifications",
	"appearance",
	"serverSystem",
	"about",
];

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
	const navigate = useNavigate();

	// Accordion state — profile & about expanded by default
	const [openSections, setOpenSections] = useState<string[]>(["profile", "about"]);

	// Version / health info
	const { data: healthData } = useQuery({
		queryKey: ["health"],
		queryFn: api.health,
		staleTime: 5 * 60 * 1000,
	});

	// Avatar
	const { data: currentUser } = useCurrentUser();
	const uploadAvatar = useUploadAvatar();
	const deleteAvatar = useDeleteAvatar();
	const [cropSrc, setCropSrc] = useState<string | null>(null);

	const clearCropSrc = () => {
		setCropSrc((prev) => {
			if (prev) URL.revokeObjectURL(prev);
			return null;
		});
	};

	const handleAvatarFileSelected = (file: File | null) => {
		if (!file) return;
		const url = URL.createObjectURL(file);
		setCropSrc((prev) => {
			if (prev) URL.revokeObjectURL(prev);
			return url;
		});
	};

	const handleCropConfirm = (blob: Blob) => {
		const file = new File([blob], "avatar.webp", { type: "image/webp" });
		uploadAvatar.mutate(file, {
			onSuccess: () => {
				clearCropSrc();
			},
		});
	};

	const handleDeleteAvatar = () => {
		if (window.confirm(t("avatarDeleteConfirm"))) {
			deleteAvatar.mutate();
		}
	};

	// Git config
	const updateProfile = useUpdateProfile();
	const [gitUsername, setGitUsername] = useState("");
	const [gitEmail, setGitEmail] = useState("");
	const [gitDirty, setGitDirty] = useState(false);

	useEffect(() => {
		if (currentUser) {
			setGitUsername(currentUser.gitUsername ?? "");
			setGitEmail(currentUser.gitEmail ?? "");
		}
	}, [currentUser]);

	const handleGitSave = () => {
		updateProfile.mutate({ gitUsername, gitEmail }, { onSuccess: () => setGitDirty(false) });
	};

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

	// PWA cache refresh
	const [pwaUpdating, setPwaUpdating] = useState(false);

	const handlePwaUpdate = async () => {
		setPwaUpdating(true);
		const { clearPwaCacheAndReload } = await import("@frontend/lib/pwa");
		await clearPwaCacheAndReload();
	};

	// Server
	const [port, setPort] = useState<number | undefined>();
	const [host, setHost] = useState("localhost");
	const [projectDir, setProjectDir] = useState("");
	// Agent
	const [permissionMode, setPermissionMode] = useState("acceptEdits");
	const [maxTurns, setMaxTurns] = useState(200);
	const [subagentExploreModel, setSubagentExploreModel] = useState("");
	const [subagentPlanModel, setSubagentPlanModel] = useState("");
	const [legacyEncoding, setLegacyEncoding] = useState(false);
	const [translateReasoning, setTranslateReasoning] = useState(false);
	const [defaultRelaxedPlan, setDefaultRelaxedPlan] = useState(false);
	const [codexDefaultReasoningEffort, setCodexDefaultReasoningEffort] = useState("high");
	const [globalWhitelistDirs, setGlobalWhitelistDirs] = useState<
		Array<{ path: string; accessLevel: string; enabled?: boolean }>
	>([]);
	const [globalBlacklistDirs, setGlobalBlacklistDirs] = useState<
		Array<{ path: string; denyLevel: string; enabled?: boolean }>
	>([]);
	const [globalCommandWhitelist, setGlobalCommandWhitelist] = useState<
		Array<{ pattern: string; enabled?: boolean }>
	>([]);
	const [globalCommandBlacklist, setGlobalCommandBlacklist] = useState<
		Array<{ pattern: string; denyPrompt?: string; enabled?: boolean }>
	>([]);
	// Chapters
	const [maxWorktrees, setMaxWorktrees] = useState(10);
	const [maxContainers, setMaxContainers] = useState(5);
	const [sizeWarning, setSizeWarning] = useState(500);
	const [autoSave, setAutoSave] = useState(true);
	const [dormantMinutes, setDormantMinutes] = useState(0);
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
		permissionMode: "acceptEdits",
		maxTurns: 200,
		subagentExploreModel: "",
		subagentPlanModel: "",
		maxWorktrees: 10,
		maxContainers: 5,
		sizeWarning: 500,
		autoSave: true,
		dormantMinutes: 0,
		portStart: 10000,
		portEnd: 20000,
		proxyEnabled: false,
		proxyPort: 7780,
		legacyEncoding: false,
		translateReasoning: false,
		defaultRelaxedPlan: false,
		codexDefaultReasoningEffort: "high",
		globalWhitelistDirs: [] as Array<{
			path: string;
			accessLevel: string;
			enabled?: boolean;
		}>,
		globalBlacklistDirs: [] as Array<{
			path: string;
			denyLevel: string;
			enabled?: boolean;
		}>,
		globalCommandWhitelist: [] as Array<{
			pattern: string;
			enabled?: boolean;
		}>,
		globalCommandBlacklist: [] as Array<{
			pattern: string;
			denyPrompt?: string;
			enabled?: boolean;
		}>,
	});

	useEffect(() => {
		if (settings && !initialized) {
			const snap = {
				port: settings.server?.port ?? 7778,
				host: settings.server?.host ?? "localhost",
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
				portStart: settings.containers?.portRangeStart ?? 10000,
				portEnd: settings.containers?.portRangeEnd ?? 20000,
				proxyEnabled: settings.containers?.proxy?.enabled ?? false,
				proxyPort: settings.containers?.proxy?.port ?? 7780,
				legacyEncoding: settings.agent?.legacyEncoding ?? false,
				translateReasoning: settings.agent?.translateReasoning ?? false,
				defaultRelaxedPlan: settings.agent?.defaultRelaxedPlan ?? false,
				codexDefaultReasoningEffort: settings.codex?.defaultReasoningEffort ?? "",
				globalWhitelistDirs: settings.agent?.whitelistDirs ?? [],
				globalBlacklistDirs: settings.agent?.blacklistDirs ?? [],
				globalCommandWhitelist: settings.agent?.commandWhitelist ?? [],
				globalCommandBlacklist: settings.agent?.commandBlacklist ?? [],
			};
			serverSnapshot.current = snap;
			setPort(snap.port);
			setHost(snap.host);
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
			setPortStart(snap.portStart);
			setPortEnd(snap.portEnd);
			setProxyEnabled(snap.proxyEnabled);
			setProxyPort(snap.proxyPort);
			setLegacyEncoding(snap.legacyEncoding);
			setTranslateReasoning(snap.translateReasoning);
			setDefaultRelaxedPlan(snap.defaultRelaxedPlan);
			setCodexDefaultReasoningEffort(snap.codexDefaultReasoningEffort);
			setGlobalWhitelistDirs(snap.globalWhitelistDirs);
			setGlobalBlacklistDirs(snap.globalBlacklistDirs);
			setGlobalCommandWhitelist(snap.globalCommandWhitelist);
			setGlobalCommandBlacklist(snap.globalCommandBlacklist);
			setInitialized(true);
		}
	}, [settings, initialized]);

	const isDirty = useMemo(() => {
		if (!initialized) return false;
		const s = serverSnapshot.current;
		return (
			port !== s.port ||
			host !== s.host ||
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
			portStart !== s.portStart ||
			portEnd !== s.portEnd ||
			proxyEnabled !== s.proxyEnabled ||
			proxyPort !== s.proxyPort ||
			legacyEncoding !== s.legacyEncoding ||
			translateReasoning !== s.translateReasoning ||
			defaultRelaxedPlan !== s.defaultRelaxedPlan ||
			codexDefaultReasoningEffort !== s.codexDefaultReasoningEffort ||
			JSON.stringify(globalWhitelistDirs) !== JSON.stringify(s.globalWhitelistDirs) ||
			JSON.stringify(globalBlacklistDirs) !== JSON.stringify(s.globalBlacklistDirs) ||
			JSON.stringify(globalCommandWhitelist) !== JSON.stringify(s.globalCommandWhitelist) ||
			JSON.stringify(globalCommandBlacklist) !== JSON.stringify(s.globalCommandBlacklist)
		);
	}, [
		initialized,
		port,
		host,
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
		portStart,
		portEnd,
		proxyEnabled,
		proxyPort,
		legacyEncoding,
		translateReasoning,
		defaultRelaxedPlan,
		codexDefaultReasoningEffort,
		globalWhitelistDirs,
		globalBlacklistDirs,
		globalCommandWhitelist,
		globalCommandBlacklist,
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
				server: { port, host },
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
					translateReasoning,
					defaultRelaxedPlan,
					whitelistDirs: globalWhitelistDirs,
					blacklistDirs: globalBlacklistDirs,
					commandWhitelist: globalCommandWhitelist,
					commandBlacklist: globalCommandBlacklist,
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
						portStart,
						portEnd,
						proxyEnabled,
						proxyPort,
						legacyEncoding,
						translateReasoning,
						defaultRelaxedPlan,
						codexDefaultReasoningEffort,
						globalWhitelistDirs,
						globalBlacklistDirs,
						globalCommandWhitelist,
						globalCommandBlacklist,
					};
				},
			},
		);
	};

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={2}>{t("title")}</Title>
				<Button
					variant="subtle"
					size="xs"
					leftSection={
						openSections.length === ALL_SECTIONS.length ? (
							<IconChevronUp size={14} />
						) : (
							<IconChevronDown size={14} />
						)
					}
					onClick={() =>
						setOpenSections(openSections.length === ALL_SECTIONS.length ? [] : [...ALL_SECTIONS])
					}
				>
					{openSections.length === ALL_SECTIONS.length ? t("collapseAll") : t("expandAll")}
				</Button>
			</Group>

			<Accordion multiple variant="separated" value={openSections} onChange={setOpenSections}>
				{/* Profile */}
				<Accordion.Item value="profile">
					<Accordion.Control icon={<IconUser size={20} />}>{t("profileSection")}</Accordion.Control>
					<Accordion.Panel>
						<ProfileSection
							currentUser={currentUser}
							gitUsername={gitUsername}
							setGitUsername={setGitUsername}
							gitEmail={gitEmail}
							setGitEmail={setGitEmail}
							gitDirty={gitDirty}
							setGitDirty={setGitDirty}
							handleAvatarFileSelected={handleAvatarFileSelected}
							handleDeleteAvatar={handleDeleteAvatar}
							handleGitSave={handleGitSave}
							uploadAvatar={uploadAvatar}
							deleteAvatar={deleteAvatar}
							updateProfile={updateProfile}
						/>
					</Accordion.Panel>
				</Accordion.Item>

				{/* Models */}
				<Accordion.Item value="models">
					<Accordion.Control icon={<IconCpu size={20} />}>{t("modelsSection")}</Accordion.Control>
					<Accordion.Panel>
						<ModelsSection
							defaultModel={defaultModel}
							setDefaultModel={setDefaultModel}
							summaryModel={summaryModel}
							setSummaryModel={setSummaryModel}
							subagentExploreModel={subagentExploreModel}
							setSubagentExploreModel={setSubagentExploreModel}
							subagentPlanModel={subagentPlanModel}
							setSubagentPlanModel={setSubagentPlanModel}
							codexDefaultReasoningEffort={codexDefaultReasoningEffort}
							setCodexDefaultReasoningEffort={setCodexDefaultReasoningEffort}
							groupedModels={groupedModels}
							navigate={navigate}
						/>
					</Accordion.Panel>
				</Accordion.Item>

				{/* AI Agent */}
				<Accordion.Item value="agent">
					<Accordion.Control icon={<IconBrain size={20} />}>{t("agentSection")}</Accordion.Control>
					<Accordion.Panel>
						<AgentSection
							permissionMode={permissionMode}
							setPermissionMode={setPermissionMode}
							maxTurns={maxTurns}
							setMaxTurns={setMaxTurns}
							legacyEncoding={legacyEncoding}
							setLegacyEncoding={setLegacyEncoding}
							translateReasoning={translateReasoning}
							setTranslateReasoning={setTranslateReasoning}
							defaultRelaxedPlan={defaultRelaxedPlan}
							setDefaultRelaxedPlan={setDefaultRelaxedPlan}
							globalWhitelistDirs={globalWhitelistDirs}
							setGlobalWhitelistDirs={setGlobalWhitelistDirs}
							globalBlacklistDirs={globalBlacklistDirs}
							setGlobalBlacklistDirs={setGlobalBlacklistDirs}
							globalCommandWhitelist={globalCommandWhitelist}
							setGlobalCommandWhitelist={setGlobalCommandWhitelist}
							globalCommandBlacklist={globalCommandBlacklist}
							setGlobalCommandBlacklist={setGlobalCommandBlacklist}
							userPrefs={userPrefs}
							updateUserPref={updateUserPref}
						/>
					</Accordion.Panel>
				</Accordion.Item>

				{/* Chapters & Containers */}
				<Accordion.Item value="chaptersContainers">
					<Accordion.Control icon={<IconBox size={20} />}>
						{t("chaptersAndContainersSection")}
					</Accordion.Control>
					<Accordion.Panel>
						<ChaptersContainersSection
							maxWorktrees={maxWorktrees}
							setMaxWorktrees={setMaxWorktrees}
							maxContainers={maxContainers}
							setMaxContainers={setMaxContainers}
							sizeWarning={sizeWarning}
							setSizeWarning={setSizeWarning}
							autoSave={autoSave}
							setAutoSave={setAutoSave}
							dormantMinutes={dormantMinutes}
							setDormantMinutes={setDormantMinutes}
							portStart={portStart}
							setPortStart={setPortStart}
							portEnd={portEnd}
							setPortEnd={setPortEnd}
							proxyEnabled={proxyEnabled}
							setProxyEnabled={setProxyEnabled}
							proxyPort={proxyPort}
							setProxyPort={setProxyPort}
						/>
					</Accordion.Panel>
				</Accordion.Item>

				{/* Notifications */}
				<Accordion.Item value="notifications">
					<Accordion.Control icon={<IconBell size={20} />}>
						{t("notificationSection")}
					</Accordion.Control>
					<Accordion.Panel>
						<NotificationSection userPrefs={userPrefs} updateUserPref={updateUserPref} />
					</Accordion.Panel>
				</Accordion.Item>

				{/* Appearance */}
				<Accordion.Item value="appearance">
					<Accordion.Control icon={<IconPalette size={20} />}>
						{t("appearanceSection")}
					</Accordion.Control>
					<Accordion.Panel>
						<AppearanceSection
							userPrefs={userPrefs}
							updateUserPref={updateUserPref}
							oledMode={oledMode}
							setOledMode={setOledMode}
							isFullscreen={isFullscreen}
							setIsFullscreen={setIsFullscreen}
						/>
					</Accordion.Panel>
				</Accordion.Item>

				{/* Server & System */}
				<Accordion.Item value="serverSystem">
					<Accordion.Control icon={<IconServer size={20} />}>
						{t("serverAndSystemSection")}
					</Accordion.Control>
					<Accordion.Panel>
						<ServerSystemSection
							port={port}
							setPort={setPort}
							host={host}
							setHost={setHost}
							projectDir={projectDir}
							setProjectDir={setProjectDir}
							pwaUpdating={pwaUpdating}
							handlePwaUpdate={handlePwaUpdate}
						/>
					</Accordion.Panel>
				</Accordion.Item>

				{/* About */}
				<Accordion.Item value="about">
					<Accordion.Control icon={<IconInfoCircle size={20} />}>
						{t("versionSection")}
					</Accordion.Control>
					<Accordion.Panel>
						<AboutSection healthData={healthData} />
					</Accordion.Panel>
				</Accordion.Item>
			</Accordion>

			{cropSrc && (
				<AvatarCropModal
					opened={!!cropSrc}
					onClose={clearCropSrc}
					imageSrc={cropSrc}
					onConfirm={handleCropConfirm}
					loading={uploadAvatar.isPending}
				/>
			)}

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
