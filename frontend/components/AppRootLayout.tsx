import { useResizableNav } from "@frontend/hooks/useResizableNav";
import {
	ActionIcon,
	Anchor,
	AppShell,
	Box,
	Burger,
	Button,
	Center,
	Container,
	Group,
	Loader,
	Modal,
	NavLink,
	Text,
	TextInput,
	Title,
	Tooltip,
	useComputedColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconAlertTriangle,
	IconClearAll,
	IconDashboard,
	IconFolders,
	IconMessageChatbot,
	IconMessageReport,
	IconPlus,
	IconSearch,
	IconSettings,
	IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
	type ErrorComponentProps,
	Link,
	Navigate,
	Outlet,
	useNavigate,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser, useLogout } from "../hooks/useAuth";
import { useLocalPref } from "../hooks/useLocalPref";
import { useNavLayout } from "../hooks/useNavLayout";
import { useOutputStats } from "../hooks/useOutputStats";
import { useRecentTabKeyboardNav } from "../hooks/useRecentTabKeyboardNav";
import { addRecentTab, useRecentTabs } from "../hooks/useRecentTabs";
import { useSetupWizardGuard } from "../hooks/useSetupWizardGuard";
import { useUpdateUserPreferences, useUserPreferences } from "../hooks/useUserPreferences";
import { useWakeLock } from "../hooks/useWakeLock";
import { type ApiError, api, clearToken, getToken } from "../lib/api";
import { changeAppLanguage, getNamespacesForPath, normalizeLanguage } from "../lib/i18n";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { GitMissingAlert } from "./GitMissingAlert";
import type { CreateNarratorResult } from "./narrator/CreateNarratorModal";
import { NavOverflowMenu } from "./nav/NavOverflowMenu";
import { NavUserMenu } from "./nav/NavUserMenu";
import { CUSTOMIZABLE_NAV_ITEMS } from "./nav/nav-items";
import { isTabActive, RecentTabList, RecentTabsWSProvider } from "./nav/RecentTabs";
import { ProviderBaseUrlFixHost } from "./settings/ProviderBaseUrlFixHost";
import { SummaryModelPickerHost } from "./settings/SummaryModelPickerHost";
import { UpdateBadge } from "./UpdateBadge";
import { VersionUpdateBanner } from "./VersionUpdateBanner";
import { WSConnectionAlert } from "./WSConnectionAlert";

const CreateNarratorModal = lazy(() =>
	import("./narrator/CreateNarratorModal").then((m) => ({
		default: m.CreateNarratorModal,
	})),
);

const SetupWizard = lazy(() =>
	import("./settings/SetupWizard").then((m) => ({
		default: m.SetupWizard,
	})),
);

export function RootErrorBoundary({ error, reset }: ErrorComponentProps) {
	const router = useRouter();
	const { t } = useTranslation("common");
	const isDev = import.meta.env.DEV;
	const computedScheme = useComputedColorScheme("dark");
	const isDark = computedScheme === "dark";

	return (
		<Center h="100vh">
			<Container size="sm" ta="center">
				<Title order={2} mb="md">
					{t("somethingWentWrong")}
				</Title>
				<Text c="dimmed" mb="xl">
					{error.message || t("unexpectedError")}
				</Text>
				{isDev && error.stack && (
					<Box
						mb="xl"
						p="sm"
						ta="left"
						style={{
							background: isDark ? "var(--mantine-color-dark-7)" : "var(--mantine-color-gray-0)",
							border: `1px solid ${
								isDark ? "var(--mantine-color-dark-4)" : "var(--mantine-color-gray-3)"
							}`,
							borderRadius: "var(--mantine-radius-sm)",
							overflow: "auto",
							maxHeight: 400,
						}}
					>
						<Text
							size="xs"
							ff="monospace"
							style={{
								color: isDark ? "var(--mantine-color-gray-2)" : "var(--mantine-color-dark-8)",
								whiteSpace: "pre-wrap",
							}}
						>
							{error.stack}
						</Text>
					</Box>
				)}
				<Group justify="center">
					<Button
						variant="default"
						onClick={() => {
							reset();
							router.invalidate();
						}}
					>
						{t("retry")}
					</Button>
					<Button component={Link} to="/">
						{t("backToHome")}
					</Button>
				</Group>
			</Container>
		</Center>
	);
}

export function RootLayout() {
	const location = useRouterState({ select: (s) => s.location });
	const isLoginPage = location.pathname === "/login";
	const isOAuthConsentPage = location.pathname === "/oauth/authorize";
	const isPublicPage = location.pathname === "/licenses" || location.pathname === "/changelog";

	return (
		<>
			<GitMissingAlert />
			{isLoginPage || isOAuthConsentPage ? (
				<Outlet />
			) : isPublicPage && !getToken() ? (
				<Outlet />
			) : (
				<AuthenticatedLayout />
			)}
		</>
	);
}

/** Format chars/sec as a human-readable rate string. */
function formatRate(cps: number): string {
	if (cps >= 1000) return `${(cps / 1000).toFixed(1)}k`;
	return String(cps);
}

/** Format total chars with K/M suffix. */
function formatChars(total: number): string {
	if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
	if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`;
	return String(total);
}

function AuthenticatedLayout() {
	const [opened, { toggle, close: closeNav }] = useDisclosure();
	const [logoutOpened, { open: openLogout, close: closeLogout }] = useDisclosure(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const navigate = useNavigate();
	const { t, i18n } = useTranslation("nav");
	const { data: user, isLoading, isError, error, fetchStatus } = useCurrentUser();
	const { logout } = useLogout();
	const { data: prefs } = useUserPreferences();
	const updatePrefs = useUpdateUserPreferences();
	const { tabs, clearTabs } = useRecentTabs();
	const [oledMode] = useLocalPref("narrafork_oled");
	const [advancedAnim] = useLocalPref("narrafork_advanced_anim");
	const [wakeLockEnabled] = useLocalPref("narrafork_wakelock");
	useWakeLock(wakeLockEnabled);
	useRecentTabKeyboardNav();
	const hasToken = !!getToken();
	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		enabled: hasToken,
	});
	const requestDumpEnabled = settings?.agent?.requestDumpEnabled === true;
	const requestDumpErrorsOnly = settings?.agent?.requestDumpErrorsOnly === true;
	const computedScheme = useComputedColorScheme("dark");
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const {
		width: navWidth,
		collapsed: navCollapsed,
		onDragStart: onNavDragStart,
		toggleCollapsed: toggleNavCollapsed,
	} = useResizableNav();
	const outputStats = useOutputStats(prefs?.showOutputStats ?? false);
	const {
		entries: navEntries,
		visibleItems: navVisibleItems,
		saveLayout: saveNavLayout,
	} = useNavLayout();
	const legacyFastModeDefaultMigrationRef = useRef(false);

	useEffect(() => {
		if (legacyFastModeDefaultMigrationRef.current || !prefs) return;

		let legacyValue: string | null = null;
		try {
			legacyValue = localStorage.getItem("narrafork_fast_mode_default");
		} catch {
			legacyFastModeDefaultMigrationRef.current = true;
			return;
		}

		if (legacyValue == null) {
			legacyFastModeDefaultMigrationRef.current = true;
			return;
		}

		const removeLegacyValue = () => {
			try {
				localStorage.removeItem("narrafork_fast_mode_default");
			} catch {
				// Ignore localStorage access failures.
			}
		};

		legacyFastModeDefaultMigrationRef.current = true;
		if (legacyValue === "true" && !prefs.fastModeDefault) {
			updatePrefs.mutate({ fastModeDefault: true }, { onSuccess: removeLegacyValue });
			return;
		}

		removeLegacyValue();
	}, [prefs, updatePrefs]);

	// --- Global narrator WebSocket connection ---
	useEffect(() => {
		narratorWSManager.connect();
		return () => narratorWSManager.disconnect();
	}, []);

	// --- Setup wizard ---
	const [wizardOpen, setWizardOpen] = useState(false);
	const [wizardMinimized, setWizardMinimized] = useState(false);

	// --- Create narrator modal (triggered from nav) ---
	const [createNarratorOpened, setCreateNarratorOpened] = useState(false);
	const requireSetup = useSetupWizardGuard();
	const openCreateNarrator = useCallback(() => {
		if (!requireSetup()) return;
		setCreateNarratorOpened(true);
	}, [requireSetup]);
	const handleNarratorCreated = useCallback(
		(data: CreateNarratorResult) => {
			addRecentTab({
				type: "narrator",
				id: data.id,
				title: data.title,
				subtitle: data.cwd,
				status: data.status,
			});
			navigate({ to: "/narrators/$narratorId", params: { narratorId: data.id } });
		},
		[navigate],
	);
	useEffect(() => {
		if (user?.role === "admin" && prefs && prefs.setupWizardCompleted === false) {
			setWizardOpen(true);
		}
	}, [user?.role, prefs]);

	// Listen for open-wizard events from other pages
	const [wizardInitialStep, setWizardInitialStep] = useState<number | undefined>();
	useEffect(() => {
		const handler = (e: Event) => {
			const step = (e as CustomEvent).detail?.step as number | undefined;
			setWizardInitialStep(step);
			setWizardMinimized(false);
			setWizardOpen(true);
		};
		window.addEventListener("narrafork:open-wizard", handler);
		return () => window.removeEventListener("narrafork:open-wizard", handler);
	}, []);

	// --- Mobile navbar back-button interception ---
	// Push a sentinel history entry when the navbar opens so that the browser
	// back button closes the navbar instead of navigating away.
	// Uses a ref to track whether the sentinel was consumed by popstate (back
	// button) vs still on the stack (closed by tap / NavLink navigation).
	const sentinelOnStack = useRef(false);

	useEffect(() => {
		if (!opened) return;
		sentinelOnStack.current = true;
		history.pushState({ mobileNav: true }, "");

		const onPop = () => {
			sentinelOnStack.current = false;
			closeNav();
		};
		window.addEventListener("popstate", onPop);
		return () => {
			window.removeEventListener("popstate", onPop);
			// Navbar closed by means other than back button — pop sentinel
			if (sentinelOnStack.current) {
				sentinelOnStack.current = false;
				history.back();
			}
		};
	}, [opened, closeNav]);

	// Close navbar for navigation: consume the sentinel flag so the cleanup
	// won't history.back() and clobber the Link's navigation. The sentinel
	// entry stays buried in the stack (harmless, same URL).
	const closeNavForLink = useCallback(() => {
		sentinelOnStack.current = false;
		closeNav();
	}, [closeNav]);

	// Sync language from backend preference on login / app init
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally do not react to i18n.language changes, otherwise manual language switches can be rolled back by stale backend prefs
	useEffect(() => {
		if (!prefs?.language) return;

		const preferredLanguage = normalizeLanguage(prefs.language);
		const currentLanguage = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
		if (preferredLanguage !== currentLanguage) {
			void changeAppLanguage(prefs.language, getNamespacesForPath(window.location.pathname));
		}
	}, [prefs?.language]);

	// Sync OLED mode data attribute on <html>
	useEffect(() => {
		const html = document.documentElement;
		if (oledMode) {
			html.setAttribute("data-oled", "true");
		} else {
			html.removeAttribute("data-oled");
		}
	}, [oledMode]);

	// Sync advanced animation data attribute on <html>
	useEffect(() => {
		const html = document.documentElement;
		if (advancedAnim) {
			html.setAttribute("data-advanced-anim", "true");
		} else {
			html.removeAttribute("data-advanced-anim");
		}
	}, [advancedAnim]);

	// Sync theme-color meta tag with actual background color
	useEffect(() => {
		const color = computedScheme === "dark" ? (oledMode ? "#000000" : "#1a1b1e") : "#ffffff";
		for (const el of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
			el.setAttribute("content", color);
		}
	}, [computedScheme, oledMode]);

	// Fullscreen mode preference (local-only)
	useEffect(() => {
		const fullscreen = localStorage.getItem("narrafork_fullscreen") === "true";
		if (fullscreen) {
			document.documentElement.requestFullscreen?.().catch(() => {});
		}
	}, []);

	// Find the active tab key so clearTabs can preserve it
	const activeTabKey = useMemo(() => {
		const active = tabs.find((tab) => isTabActive(tab, pathname));
		return active ? `${active.type}:${active.id}` : undefined;
	}, [tabs, pathname]);

	// No token → redirect to login (useCurrentUser is disabled, won't fire)
	if (!hasToken) {
		return <Navigate to="/login" />;
	}

	// Token exists but auth failed (expired/invalid/user gone) → clear token and redirect
	// Don't clear on transient server errors (502, network issues, etc.)
	if (isError && (error as ApiError)?.status === 401) {
		clearToken();
		return <Navigate to="/login" />;
	}

	// Token exists, query in flight → show loader
	if (isLoading || (!user && fetchStatus === "fetching")) {
		return (
			<Center h="100vh">
				<Loader />
			</Center>
		);
	}

	const handleSearch = () => {
		if (searchQuery.trim()) {
			navigate({ to: "/search", search: { q: searchQuery.trim() } });
			setSearchOpen(false);
		}
	};

	const openRequestDumpSetting = () => {
		navigate({ to: "/settings/agent", hash: "request-dump-enabled" });
	};

	// Check if the first tab in each group is active — used for connected border-radius
	const projectTabs = tabs.filter((t) => t.type === "project");
	const narratorTabs = tabs.filter((t) => t.type !== "project");
	const firstProjectTabActive = projectTabs.length > 0 && isTabActive(projectTabs[0], pathname);
	const firstNarratorTabActive = narratorTabs.length > 0 && isTabActive(narratorTabs[0], pathname);

	// Whether the projects section is visible (can be tucked into the overflow menu)
	const projectsVisible = navVisibleItems.some((item) => item.id === "projects");
	const secondaryNavDefs = new Map(CUSTOMIZABLE_NAV_ITEMS.map((def) => [def.id, def]));

	const handleSearchKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") handleSearch();
		if (e.key === "Escape") setSearchOpen(false);
	};

	return (
		<AppShell
			layout="alt"
			header={{ height: 60 }}
			navbar={{ width: navWidth, breakpoint: "sm", collapsed: { mobile: !opened } }}
			padding="md"
		>
			<WSConnectionAlert />
			<VersionUpdateBanner />
			<AppShell.Header>
				<Group h="100%" px="md" justify="space-between" wrap="nowrap">
					<Group wrap="nowrap">
						<Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
						<Tooltip
							label={t(navCollapsed ? "expandSidebar" : "collapseSidebar")}
							position="bottom"
							openDelay={400}
						>
							<Title
								order={3}
								visibleFrom="sm"
								onClick={toggleNavCollapsed}
								style={{ cursor: "pointer", userSelect: "none" }}
							>
								{t("appName")}
							</Title>
						</Tooltip>
						<UpdateBadge />
						{requestDumpEnabled && (
							<Tooltip
								label={t(
									requestDumpErrorsOnly
										? "requestDumpErrorsOnlyTooltip"
										: "requestDumpEnabledTooltip",
								)}
								position="bottom"
								withArrow
							>
								<Button
									variant="light"
									color="orange"
									size="xs"
									leftSection={<IconAlertTriangle size={14} />}
									onClick={openRequestDumpSetting}
									style={{ flexShrink: 0 }}
								>
									{t("requestDumpEnabledBadge")}
								</Button>
							</Tooltip>
						)}
						{!searchOpen && (
							<Title order={3} hiddenFrom="sm">
								{t("appName")}
							</Title>
						)}
					</Group>
					<Group wrap="nowrap">
						{prefs?.showOutputStats && outputStats.charsPerSec > 0 && (
							<Tooltip
								label={`${t("totalOutputChars")}: ${formatChars(outputStats.totalChars)}`}
								position="bottom"
								withArrow
							>
								<Text
									size="sm"
									c="dimmed"
									style={{ cursor: "default", fontVariantNumeric: "tabular-nums" }}
								>
									{formatRate(outputStats.charsPerSec)}
								</Text>
							</Tooltip>
						)}
						<Tooltip label={t("feedback")} position="bottom" withArrow>
							<ActionIcon
								variant="subtle"
								color="gray"
								component="a"
								href="https://github.com/Narrafork/narrafork-issue/issues"
								target="_blank"
								rel="noopener noreferrer"
							>
								<IconMessageReport size={20} />
							</ActionIcon>
						</Tooltip>
						{/* Desktop: always show search input */}
						<TextInput
							placeholder={t("searchPlaceholder")}
							size="sm"
							style={{ width: 300 }}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.currentTarget.value)}
							onKeyDown={handleSearchKeyDown}
							rightSection={
								<ActionIcon size="sm" variant="subtle" onClick={handleSearch}>
									<IconSearch size={16} />
								</ActionIcon>
							}
							visibleFrom="sm"
						/>
						{/* Mobile: toggle search input via icon */}
						{searchOpen ? (
							<Group wrap="nowrap" gap="xs" hiddenFrom="sm" style={{ flex: 1, minWidth: 0 }}>
								<TextInput
									placeholder={t("searchPlaceholder")}
									size="sm"
									style={{ flex: 1, minWidth: 0 }}
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.currentTarget.value)}
									onKeyDown={handleSearchKeyDown}
									rightSection={
										<ActionIcon size="sm" variant="subtle" onClick={handleSearch}>
											<IconSearch size={16} />
										</ActionIcon>
									}
									autoFocus
								/>
								<ActionIcon variant="subtle" color="gray" onClick={() => setSearchOpen(false)}>
									<IconX size={18} />
								</ActionIcon>
							</Group>
						) : (
							<ActionIcon
								variant="subtle"
								color="gray"
								onClick={() => setSearchOpen(true)}
								title={t("searchPlaceholder")}
								hiddenFrom="sm"
							>
								<IconSearch size={18} />
							</ActionIcon>
						)}
					</Group>
				</Group>
			</AppShell.Header>

			<AppShell.Navbar
				p={navCollapsed ? 4 : "md"}
				data-collapsed={navCollapsed || undefined}
				style={{
					display: "flex",
					flexDirection: "column",
					isolation: "isolate",
					transition: "padding 150ms ease",
				}}
			>
				<RecentTabsWSProvider />
				{/* Drag handle for resizing navbar */}
				<Box
					visibleFrom="sm"
					onMouseDown={onNavDragStart}
					style={{
						position: "absolute",
						top: 0,
						right: -3,
						width: 6,
						height: "100%",
						cursor: "col-resize",
						zIndex: 100,
					}}
				/>
				<Box>
					<Tooltip label={t("dashboard")} position="right" disabled={!navCollapsed}>
						<NavLink
							component={Link}
							to="/"
							label={navCollapsed ? undefined : t("dashboard")}
							leftSection={<IconDashboard size={16} />}
							onClick={closeNavForLink}
						/>
					</Tooltip>
					{projectsVisible && (
						<Tooltip label={t("projects")} position="right" disabled={!navCollapsed}>
							<NavLink
								component={Link}
								to="/projects"
								label={navCollapsed ? undefined : t("projects")}
								leftSection={<IconFolders size={16} />}
								onClick={closeNavForLink}
								styles={
									firstProjectTabActive
										? {
												root: {
													borderBottomLeftRadius: 0,
													borderBottomRightRadius: 0,
												},
											}
										: undefined
								}
								rightSection={
									navCollapsed ? undefined : tabs.some((t) => t.type === "project") ? (
										<Tooltip label={t("clearProjects")} position="right" withArrow>
											<ActionIcon
												size={28}
												variant="subtle"
												color="gray"
												onClick={(e: React.MouseEvent) => {
													e.preventDefault();
													e.stopPropagation();
													clearTabs("projects", activeTabKey);
												}}
												aria-label={t("clearProjects")}
											>
												<IconClearAll size={16} />
											</ActionIcon>
										</Tooltip>
									) : undefined
								}
							/>
						</Tooltip>
					)}
				</Box>
				{projectsVisible && !navCollapsed && (
					<Box style={{ overflow: "auto", minHeight: 0 }}>
						<RecentTabList filter="project" onNavigate={closeNavForLink} firstTabConnected />
					</Box>
				)}
				<Box>
					<Tooltip label={t("narrators")} position="right" disabled={!navCollapsed}>
						<NavLink
							label={navCollapsed ? undefined : t("narrators")}
							active={pathname.startsWith("/narrators")}
							leftSection={<IconMessageChatbot size={16} />}
							onClick={() => {
								navigate({ to: "/narrators" });
								closeNavForLink();
							}}
							styles={
								firstNarratorTabActive
									? {
											root: {
												borderBottomLeftRadius: 0,
												borderBottomRightRadius: 0,
											},
										}
									: undefined
							}
							rightSection={
								navCollapsed ? undefined : (
									<Group gap={8} wrap="nowrap">
										<Tooltip label={t("newNarrator")} position="right" withArrow>
											<ActionIcon
												size={28}
												variant="subtle"
												color="gray"
												onClick={(e: React.MouseEvent) => {
													e.preventDefault();
													e.stopPropagation();
													openCreateNarrator();
													closeNavForLink();
												}}
												aria-label={t("newNarrator")}
											>
												<IconPlus size={16} />
											</ActionIcon>
										</Tooltip>
										{tabs.some(
											(t) =>
												t.type !== "project" &&
												!["working", "waiting"].includes(t.status ?? "") &&
												!t.substatus?.includes("unread"),
										) && (
											<Tooltip label={t("clearNarrators")} position="right" withArrow>
												<ActionIcon
													size={28}
													variant="subtle"
													color="gray"
													onClick={(e: React.MouseEvent) => {
														e.preventDefault();
														e.stopPropagation();
														clearTabs("inactive_narrators", activeTabKey);
													}}
													aria-label={t("clearNarrators")}
												>
													<IconClearAll size={16} />
												</ActionIcon>
											</Tooltip>
										)}
									</Group>
								)
							}
						/>
					</Tooltip>
				</Box>
				{!navCollapsed && (
					<Box style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
						<RecentTabList filter="narrator" onNavigate={closeNavForLink} firstTabConnected />
					</Box>
				)}
				<Box>
					{navVisibleItems.map((item) => {
						// "projects" is rendered in the top section above; settings is mandatory
						// and rendered after this list. Skip them here.
						if (item.id === "projects") return null;
						const def = secondaryNavDefs.get(item.id);
						if (!def) return null;
						const Icon = def.icon;
						return (
							<Tooltip
								key={item.id}
								label={t(def.labelKey)}
								position="right"
								disabled={!navCollapsed}
							>
								<NavLink
									component={Link}
									to={def.to}
									label={navCollapsed ? undefined : t(def.labelKey)}
									active={def.activePrefix ? pathname.startsWith(def.activePrefix) : undefined}
									leftSection={<Icon size={16} />}
									onClick={closeNavForLink}
								/>
							</Tooltip>
						);
					})}
					<Tooltip label={t("settings")} position="right" disabled={!navCollapsed}>
						<NavLink
							component={Link}
							to="/settings"
							label={navCollapsed ? undefined : t("settings")}
							leftSection={<IconSettings size={16} />}
							onClick={closeNavForLink}
						/>
					</Tooltip>
				</Box>
				{navCollapsed ? (
					<Group justify="center" mt={4} gap={4}>
						<NavOverflowMenu
							entries={navEntries}
							onSaveLayout={saveNavLayout}
							navCollapsed={navCollapsed}
						/>
						<NavUserMenu onLogout={openLogout} navCollapsed={navCollapsed} />
					</Group>
				) : (
					<Group gap={4} mt={4} wrap="nowrap" align="center" px={8} justify="space-between">
						<NavUserMenu onLogout={openLogout} navCollapsed={navCollapsed} />
						<Text size="xs" c="dimmed" ta="center" style={{ flex: 1, minWidth: 0 }}>
							v{__APP_VERSION__}
							<Anchor
								component={Link}
								to="/licenses"
								size="xs"
								c="dimmed"
								td="underline"
								ml={8}
								onClick={closeNavForLink}
							>
								{t("licenses")}
							</Anchor>
						</Text>
						<NavOverflowMenu
							entries={navEntries}
							onSaveLayout={saveNavLayout}
							navCollapsed={navCollapsed}
						/>
					</Group>
				)}
			</AppShell.Navbar>

			<AppShell.Main>
				<Outlet />
			</AppShell.Main>

			<Modal
				opened={logoutOpened}
				onClose={closeLogout}
				title={t("logoutConfirmTitle")}
				centered
				size="sm"
			>
				<Text mb="lg">{t("logoutConfirmMessage")}</Text>
				<Group justify="flex-end">
					<Button variant="default" onClick={closeLogout}>
						{t("cancel")}
					</Button>
					<Button color="red" onClick={logout}>
						{t("confirm")}
					</Button>
				</Group>
			</Modal>

			{(wizardOpen || wizardMinimized) && (
				<Suspense fallback={null}>
					<SetupWizard
						opened={wizardOpen}
						minimized={wizardMinimized}
						initialStep={wizardInitialStep}
						onClose={() => {
							setWizardOpen(false);
							setWizardMinimized(false);
							setWizardInitialStep(undefined);
						}}
						onMinimize={() => {
							setWizardOpen(false);
							setWizardMinimized(true);
							setWizardInitialStep(undefined);
						}}
						onRestore={() => {
							setWizardMinimized(false);
							setWizardOpen(true);
						}}
					/>
				</Suspense>
			)}

			<SummaryModelPickerHost />
			<ProviderBaseUrlFixHost />

			{createNarratorOpened && (
				<Suspense fallback={null}>
					<CreateNarratorModal
						opened={createNarratorOpened}
						onClose={() => setCreateNarratorOpened(false)}
						onCreated={handleNarratorCreated}
					/>
				</Suspense>
			)}
		</AppShell>
	);
}
