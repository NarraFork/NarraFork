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
import { ensurePrefix } from "../../components/providers/types";
import { AboutSection } from "../../components/settings/AboutSection";
import { AgentSection } from "../../components/settings/AgentSection";
import { AppearanceSection } from "../../components/settings/AppearanceSection";
import { ChaptersContainersSection } from "../../components/settings/ChaptersContainersSection";
import { ModelsSection, type SubagentAllowedModels } from "../../components/settings/ModelsSection";
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
	validateSearch: (search: Record<string, unknown>) => ({
		section: typeof search.section === "string" ? search.section : undefined,
		scrollTo: typeof search.scrollTo === "string" ? search.scrollTo : undefined,
	}),
});

function SettingsPage() {
	const { section: urlSection, scrollTo: urlScrollTo } = Route.useSearch();
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

	// Accordion state — profile & about expanded by default; URL section takes priority
	const [openSections, setOpenSections] = useState<string[]>(() => {
		const defaults = ["profile", "about"];
		if (urlSection && !defaults.includes(urlSection)) defaults.push(urlSection);
		return defaults;
	});

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

	// Wake lock (local-only)
	const [wakeLock, setWakeLock] = useLocalPref("narrafork_wakelock");

	// Advanced animation (local-only)
	const [advancedAnim, setAdvancedAnim] = useLocalPref("narrafork_advanced_anim");

	// Expand reasoning cards by default (local-only)
	const [expandReasoning, setExpandReasoning] = useLocalPref("narrafork_expand_reasoning");

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
	const [openBrowser, setOpenBrowser] = useState("app");
	// TLS
	const [tlsEnabled, setTlsEnabled] = useState(false);
	const [tlsCertFile, setTlsCertFile] = useState("");
	const [tlsKeyFile, setTlsKeyFile] = useState("");
	const [tlsPassphrase, setTlsPassphrase] = useState("");
	const [tlsCaFile, setTlsCaFile] = useState("");
	// Update server
	const [updateServerUrl, setUpdateServerUrl] = useState("");
	const [updateChannel, setUpdateChannel] = useState<"stable" | "beta">("stable");
	const [updateAutoDownload, setUpdateAutoDownload] = useState(false);
	// Agent
	const [permissionMode, setPermissionMode] = useState("acceptEdits");
	const [maxTurns, setMaxTurns] = useState(200);
	const [subagentExploreModel, setSubagentExploreModel] = useState("");
	const [subagentPlanModel, setSubagentPlanModel] = useState("");
	const [subagentAllowedModels, setSubagentAllowedModels] = useState<SubagentAllowedModels>({
		explore: [],
		plan: [],
		general: [],
	});
	const [legacyEncoding, setLegacyEncoding] = useState(false);
	const [freshShellEnv, setFreshShellEnv] = useState(false);
	const [translateReasoning, setTranslateReasoning] = useState(false);
	const [defaultRelaxedPlan, setDefaultRelaxedPlan] = useState(false);
	const [smartInterruptionCheck, setSmartInterruptionCheck] = useState(true);
	const [maxTransientRetries, setMaxTransientRetries] = useState(10);
	const [retryBackoffCeilMs, setRetryBackoffCeilMs] = useState(20000);
	const [customRetryRules, setCustomRetryRules] = useState<
		Array<{
			id: string;
			domain?: string;
			statusCode?: number;
			keyword?: string;
			enabled?: boolean;
			note?: string;
		}>
	>([]);
	const [contextThresholds, setContextThresholds] = useState({
		standard: { pruneStart: 95, compactStart: 99 },
		large: { pruneStart: 95, compactStart: 99 },
	});
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
	// WebFetch proxy
	const [webFetchProxyMode, setWebFetchProxyMode] = useState("system");
	const [webFetchProxyUrl, setWebFetchProxyUrl] = useState("");
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
		host: "localhost",
		openBrowser: "app",
		tlsEnabled: false,
		tlsCertFile: "",
		tlsKeyFile: "",
		tlsPassphrase: "",
		tlsCaFile: "",
		projectDir: "",
		permissionMode: "acceptEdits",
		maxTurns: 200,
		subagentExploreModel: "",
		subagentPlanModel: "",
		subagentAllowedModels: { explore: [], plan: [], general: [] } as SubagentAllowedModels,
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
		freshShellEnv: false,
		translateReasoning: false,
		defaultRelaxedPlan: false,
		smartInterruptionCheck: true,
		maxTransientRetries: 10,
		retryBackoffCeilMs: 20000,
		customRetryRules: [] as Array<{
			id: string;
			domain?: string;
			statusCode?: number;
			keyword?: string;
			enabled?: boolean;
			note?: string;
		}>,
		contextThresholds: {
			standard: { pruneStart: 95, compactStart: 99 },
			large: { pruneStart: 95, compactStart: 99 },
		},
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
		webFetchProxyMode: "system",
		webFetchProxyUrl: "",
		updateServerUrl: "",
		updateChannel: "stable" as "stable" | "beta",
		updateAutoDownload: false,
	});

	useEffect(() => {
		if (settings && !initialized) {
			const snap = {
				port: settings.server?.port ?? 7778,
				host: settings.server?.host ?? "localhost",
				openBrowser: settings.server?.openBrowser ?? "app",
				tlsEnabled: settings.server?.tls?.enabled ?? false,
				tlsCertFile: settings.server?.tls?.certFile ?? "",
				tlsKeyFile: settings.server?.tls?.keyFile ?? "",
				tlsPassphrase: "",
				tlsCaFile: settings.server?.tls?.caFile ?? "",
				projectDir: settings.paths?.defaultProjectDir ?? "",
				permissionMode: settings.agent?.defaultPermissionMode ?? "default",
				maxTurns: settings.agent?.maxTurns ?? 200,
				subagentExploreModel: ensurePrefix(settings.agent?.subagentModels?.explore ?? ""),
				subagentPlanModel: ensurePrefix(settings.agent?.subagentModels?.plan ?? ""),
				subagentAllowedModels: {
					explore: settings.agent?.subagentAllowedModels?.explore ?? [],
					plan: settings.agent?.subagentAllowedModels?.plan ?? [],
					general: settings.agent?.subagentAllowedModels?.general ?? [],
				},
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
				freshShellEnv: settings.agent?.freshShellEnv ?? false,
				translateReasoning: settings.agent?.translateReasoning ?? false,
				defaultRelaxedPlan: settings.agent?.defaultRelaxedPlan ?? false,
				smartInterruptionCheck: settings.agent?.smartInterruptionCheck ?? true,
				maxTransientRetries: settings.agent?.maxTransientRetries ?? 10,
				retryBackoffCeilMs: settings.agent?.retryBackoffCeilMs ?? 20000,
				customRetryRules: settings.agent?.customRetryRules ?? [],
				contextThresholds: settings.agent?.contextThresholds ?? {
					standard: { pruneStart: 95, compactStart: 99 },
					large: { pruneStart: 95, compactStart: 99 },
				},
				codexDefaultReasoningEffort: settings.codex?.defaultReasoningEffort ?? "",
				globalWhitelistDirs: settings.agent?.whitelistDirs ?? [],
				globalBlacklistDirs: settings.agent?.blacklistDirs ?? [],
				globalCommandWhitelist: settings.agent?.commandWhitelist ?? [],
				globalCommandBlacklist: settings.agent?.commandBlacklist ?? [],
				webFetchProxyMode: settings.agent?.webFetchPolicy?.proxy?.mode ?? "system",
				webFetchProxyUrl: settings.agent?.webFetchPolicy?.proxy?.url ?? "",
				updateServerUrl: settings.update?.serverUrl ?? "",
				updateChannel: settings.update?.channel ?? "stable",
				updateAutoDownload: settings.update?.autoDownload ?? false,
			};
			serverSnapshot.current = snap;
			setPort(snap.port);
			setHost(snap.host);
			setOpenBrowser(snap.openBrowser);
			setTlsEnabled(snap.tlsEnabled);
			setTlsCertFile(snap.tlsCertFile);
			setTlsKeyFile(snap.tlsKeyFile);
			setTlsPassphrase(snap.tlsPassphrase);
			setTlsCaFile(snap.tlsCaFile);
			setProjectDir(snap.projectDir);
			setDefaultModel(snap.defaultModel);
			setPermissionMode(snap.permissionMode);
			setSummaryModel(snap.summaryModel);
			setMaxTurns(snap.maxTurns);
			setSubagentExploreModel(snap.subagentExploreModel);
			setSubagentPlanModel(snap.subagentPlanModel);
			setSubagentAllowedModels(snap.subagentAllowedModels);
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
			setFreshShellEnv(snap.freshShellEnv);
			setTranslateReasoning(snap.translateReasoning);
			setDefaultRelaxedPlan(snap.defaultRelaxedPlan);
			setSmartInterruptionCheck(snap.smartInterruptionCheck);
			setMaxTransientRetries(snap.maxTransientRetries);
			setRetryBackoffCeilMs(snap.retryBackoffCeilMs);
			setCustomRetryRules(snap.customRetryRules);
			setContextThresholds(snap.contextThresholds);
			setCodexDefaultReasoningEffort(snap.codexDefaultReasoningEffort);
			setGlobalWhitelistDirs(snap.globalWhitelistDirs);
			setGlobalBlacklistDirs(snap.globalBlacklistDirs);
			setGlobalCommandWhitelist(snap.globalCommandWhitelist);
			setGlobalCommandBlacklist(snap.globalCommandBlacklist);
			setWebFetchProxyMode(snap.webFetchProxyMode);
			setWebFetchProxyUrl(snap.webFetchProxyUrl);
			setUpdateServerUrl(settings.update?.serverUrl ?? "");
			setUpdateChannel(settings.update?.channel ?? "stable");
			setUpdateAutoDownload(settings.update?.autoDownload ?? false);
			setInitialized(true);
		}
	}, [settings, initialized]);

	const isDirty = useMemo(() => {
		if (!initialized) return false;
		const s = serverSnapshot.current;
		return (
			port !== s.port ||
			host !== s.host ||
			openBrowser !== s.openBrowser ||
			tlsEnabled !== s.tlsEnabled ||
			tlsCertFile !== s.tlsCertFile ||
			tlsKeyFile !== s.tlsKeyFile ||
			tlsPassphrase !== s.tlsPassphrase ||
			tlsCaFile !== s.tlsCaFile ||
			projectDir !== s.projectDir ||
			defaultModel !== s.defaultModel ||
			permissionMode !== s.permissionMode ||
			summaryModel !== s.summaryModel ||
			maxTurns !== s.maxTurns ||
			subagentExploreModel !== s.subagentExploreModel ||
			subagentPlanModel !== s.subagentPlanModel ||
			JSON.stringify(subagentAllowedModels) !== JSON.stringify(s.subagentAllowedModels) ||
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
			freshShellEnv !== s.freshShellEnv ||
			translateReasoning !== s.translateReasoning ||
			defaultRelaxedPlan !== s.defaultRelaxedPlan ||
			smartInterruptionCheck !== s.smartInterruptionCheck ||
			maxTransientRetries !== s.maxTransientRetries ||
			retryBackoffCeilMs !== s.retryBackoffCeilMs ||
			JSON.stringify(customRetryRules) !== JSON.stringify(s.customRetryRules) ||
			JSON.stringify(contextThresholds) !== JSON.stringify(s.contextThresholds) ||
			codexDefaultReasoningEffort !== s.codexDefaultReasoningEffort ||
			JSON.stringify(globalWhitelistDirs) !== JSON.stringify(s.globalWhitelistDirs) ||
			JSON.stringify(globalBlacklistDirs) !== JSON.stringify(s.globalBlacklistDirs) ||
			JSON.stringify(globalCommandWhitelist) !== JSON.stringify(s.globalCommandWhitelist) ||
			JSON.stringify(globalCommandBlacklist) !== JSON.stringify(s.globalCommandBlacklist) ||
			webFetchProxyMode !== s.webFetchProxyMode ||
			webFetchProxyUrl !== s.webFetchProxyUrl ||
			updateServerUrl !== (s.updateServerUrl ?? "") ||
			updateChannel !== (s.updateChannel ?? "stable") ||
			updateAutoDownload !== (s.updateAutoDownload ?? false)
		);
	}, [
		initialized,
		port,
		host,
		openBrowser,
		tlsEnabled,
		tlsCertFile,
		tlsKeyFile,
		tlsPassphrase,
		tlsCaFile,
		projectDir,
		defaultModel,
		permissionMode,
		summaryModel,
		maxTurns,
		subagentExploreModel,
		subagentPlanModel,
		subagentAllowedModels,
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
		freshShellEnv,
		translateReasoning,
		defaultRelaxedPlan,
		smartInterruptionCheck,
		maxTransientRetries,
		customRetryRules,
		contextThresholds,
		codexDefaultReasoningEffort,
		globalWhitelistDirs,
		globalBlacklistDirs,
		globalCommandWhitelist,
		globalCommandBlacklist,
		webFetchProxyMode,
		webFetchProxyUrl,
		updateServerUrl,
		updateChannel,
		updateAutoDownload,
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

	// Scroll to target element from URL search params (e.g. ?section=agent&scrollTo=contextThresholds)
	useEffect(() => {
		if (!urlScrollTo || !initialized) return;
		const timer = setTimeout(() => {
			const el = document.getElementById(urlScrollTo);
			el?.scrollIntoView({ behavior: "smooth", block: "center" });
		}, 300);
		return () => clearTimeout(timer);
	}, [urlScrollTo, initialized]);

	// Models from central hook (must be before early returns)
	const { groupedModels } = useAllModels();

	if (isLoading) return <Loader />;

	const handleSave = () => {
		updateSettings.mutate(
			{
				server: {
					port,
					host,
					openBrowser,
					tls: {
						enabled: tlsEnabled,
						certFile: tlsCertFile,
						keyFile: tlsKeyFile,
						...(tlsPassphrase && { passphrase: tlsPassphrase }),
						...(tlsCaFile && { caFile: tlsCaFile }),
					},
				},
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
					subagentAllowedModels,
					legacyEncoding,
					freshShellEnv,
					translateReasoning,
					defaultRelaxedPlan,
					smartInterruptionCheck,
					maxTransientRetries,
					retryBackoffCeilMs,
					customRetryRules,
					contextThresholds,
					whitelistDirs: globalWhitelistDirs,
					blacklistDirs: globalBlacklistDirs,
					commandWhitelist: globalCommandWhitelist,
					commandBlacklist: globalCommandBlacklist,
					webFetchPolicy: {
						proxy: {
							mode: webFetchProxyMode as "direct" | "system" | "custom",
							...(webFetchProxyMode === "custom" && webFetchProxyUrl
								? { url: webFetchProxyUrl }
								: {}),
						},
					},
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
						(codexDefaultReasoningEffort as "none" | "low" | "medium" | "high" | "xhigh") || null,
				},
				update: {
					serverUrl: updateServerUrl || undefined,
					channel: updateChannel,
					autoDownload: updateAutoDownload,
				},
			},
			{
				onSuccess: (data) => {
					serverSnapshot.current = {
						port,
						host,
						openBrowser,
						tlsEnabled,
						tlsCertFile,
						tlsKeyFile,
						tlsPassphrase,
						tlsCaFile,
						projectDir,
						defaultModel,
						permissionMode,
						summaryModel,
						maxTurns,
						subagentExploreModel,
						subagentPlanModel,
						subagentAllowedModels,
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
						freshShellEnv,
						translateReasoning,
						defaultRelaxedPlan,
						smartInterruptionCheck,
						maxTransientRetries,
						retryBackoffCeilMs,
						customRetryRules,
						contextThresholds,
						codexDefaultReasoningEffort,
						globalWhitelistDirs,
						globalBlacklistDirs,
						globalCommandWhitelist,
						globalCommandBlacklist,
						webFetchProxyMode,
						webFetchProxyUrl,
						updateServerUrl,
						updateChannel,
						updateAutoDownload,
					};
					// Server is restarting at a new address — redirect after a short delay
					const resp = data as { serverRestarting?: boolean; newUrl?: string };
					if (resp.serverRestarting && resp.newUrl) {
						setTimeout(() => {
							window.location.href = resp.newUrl as string;
						}, 1000);
					}
				},
			},
		);
	};

	return (
		<Stack pb={80}>
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
							subagentAllowedModels={subagentAllowedModels}
							setSubagentAllowedModels={setSubagentAllowedModels}
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
							freshShellEnv={freshShellEnv}
							setFreshShellEnv={setFreshShellEnv}
							translateReasoning={translateReasoning}
							setTranslateReasoning={setTranslateReasoning}
							expandReasoning={expandReasoning}
							setExpandReasoning={setExpandReasoning}
							defaultRelaxedPlan={defaultRelaxedPlan}
							setDefaultRelaxedPlan={setDefaultRelaxedPlan}
							smartInterruptionCheck={smartInterruptionCheck}
							setSmartInterruptionCheck={setSmartInterruptionCheck}
							maxTransientRetries={maxTransientRetries}
							setMaxTransientRetries={setMaxTransientRetries}
							retryBackoffCeilMs={retryBackoffCeilMs}
							setRetryBackoffCeilMs={setRetryBackoffCeilMs}
							customRetryRules={customRetryRules}
							setCustomRetryRules={setCustomRetryRules}
							contextThresholds={contextThresholds}
							setContextThresholds={setContextThresholds}
							globalWhitelistDirs={globalWhitelistDirs}
							setGlobalWhitelistDirs={setGlobalWhitelistDirs}
							globalBlacklistDirs={globalBlacklistDirs}
							setGlobalBlacklistDirs={setGlobalBlacklistDirs}
							globalCommandWhitelist={globalCommandWhitelist}
							setGlobalCommandWhitelist={setGlobalCommandWhitelist}
							globalCommandBlacklist={globalCommandBlacklist}
							setGlobalCommandBlacklist={setGlobalCommandBlacklist}
							webFetchProxyMode={webFetchProxyMode}
							setWebFetchProxyMode={setWebFetchProxyMode}
							webFetchProxyUrl={webFetchProxyUrl}
							setWebFetchProxyUrl={setWebFetchProxyUrl}
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
							wakeLock={wakeLock}
							setWakeLock={setWakeLock}
							advancedAnim={advancedAnim}
							setAdvancedAnim={setAdvancedAnim}
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
							openBrowser={openBrowser}
							setOpenBrowser={setOpenBrowser}
							pwaUpdating={pwaUpdating}
							handlePwaUpdate={handlePwaUpdate}
							tlsEnabled={tlsEnabled}
							setTlsEnabled={setTlsEnabled}
							tlsCertFile={tlsCertFile}
							setTlsCertFile={setTlsCertFile}
							tlsKeyFile={tlsKeyFile}
							setTlsKeyFile={setTlsKeyFile}
							tlsPassphrase={tlsPassphrase}
							setTlsPassphrase={setTlsPassphrase}
							tlsCaFile={tlsCaFile}
							setTlsCaFile={setTlsCaFile}
							updateServerUrl={updateServerUrl}
							setUpdateServerUrl={setUpdateServerUrl}
							updateChannel={updateChannel}
							setUpdateChannel={setUpdateChannel}
							updateAutoDownload={updateAutoDownload}
							setUpdateAutoDownload={setUpdateAutoDownload}
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
