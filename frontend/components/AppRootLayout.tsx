import { useResizableNav } from "@frontend/hooks/useResizableNav";
import {
	ActionIcon,
	Anchor,
	AppShell,
	Badge,
	Box,
	Burger,
	Button,
	Center,
	Container,
	Group,
	Indicator,
	Loader,
	Modal,
	NavLink,
	Switch,
	Text,
	TextInput,
	Title,
	Tooltip,
	useComputedColorScheme,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { isSessionInvalidResponse } from "@shared/session-auth";
import {
	IconAlertTriangle,
	IconArrowLeft,
	IconClearAll,
	IconDashboard,
	IconFolders,
	IconLayoutList,
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
import { useKnowledgeNotifications, useReviewInboxCount } from "../hooks/useKnowledge";
import { useLocalPref } from "../hooks/useLocalPref";
import { useNavLayout } from "../hooks/useNavLayout";
import { useOutputStats } from "../hooks/useOutputStats";
import { useRecentTabKeyboardNav } from "../hooks/useRecentTabKeyboardNav";
import { addRecentTab, useRecentTabs } from "../hooks/useRecentTabs";
import { useSetupWizardGuard } from "../hooks/useSetupWizardGuard";
import { useUpdateUserPreferences, useUserPreferences } from "../hooks/useUserPreferences";
import { useWakeLock } from "../hooks/useWakeLock";
import { type ApiError, api, clearToken, getToken } from "../lib/api";
import {
	useAppShellHistoryEntryKey,
	useAppShellMainScrollRestoration,
	useBrowserLayoutEffect,
} from "../lib/app-shell-scroll";
import { APP_HISTORY_SENTINEL, pushHistorySentinel } from "../lib/history-state";
import { changeAppLanguage, getNamespacesForPath, normalizeLanguage } from "../lib/i18n";
import { NARRATOR_VIRTUAL_LIST_INTERACTIVE } from "../lib/narrator-virtual-list";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "../lib/responsive";
import {
	APP_SHELL_CLASSNAME,
	APP_SHELL_DESKTOP_NAVBAR_HEIGHT,
	APP_SHELL_HEADER_HEIGHT,
	APP_SHELL_HEADER_OFFSET,
	APP_SHELL_MAIN_CLASSNAME,
	APP_SHELL_MAIN_ID,
	APP_SHELL_MAIN_PADDING_BOTTOM,
	APP_SHELL_MOBILE_NAVBAR_HEIGHT,
	APP_SHELL_SAFE_HEADER_STYLE,
	APP_VIEWPORT_BOTTOM,
	appShellNavbarBottomGutter,
	installAppViewportTracking,
	installAuthenticatedAppShellRootLock,
	SAFE_AREA_INSET_TOP,
} from "../lib/safe-area";
import { LazyOverlayBoundary } from "./common/LazyOverlayBoundary";
import { GitMissingAlert } from "./GitMissingAlert";
import type { CreateNarratorResult } from "./narrator/CreateNarratorModal";
import { HeaderPullToRefresh } from "./nav/HeaderPullToRefresh";
import { NavOverflowMenu } from "./nav/NavOverflowMenu";
import { NavUserMenu } from "./nav/NavUserMenu";
import { CUSTOMIZABLE_NAV_ITEMS } from "./nav/nav-items";
import { isTabActive, RecentTabList, RecentTabsWSProvider } from "./nav/RecentTabs";
import { BrokenModelMigrationHost } from "./settings/BrokenModelMigrationHost";
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
	const isPublicPage =
		location.pathname === "/licenses" ||
		location.pathname === "/changelog" ||
		(import.meta.env.DEV && location.pathname === "/dev-vlist-harness");

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

/**
 * The header's AI output-rate badge.
 *
 * The stats stream ticks every second while any narrator produces output. Owning
 * that subscription here — rather than in AuthenticatedLayout — keeps each tick
 * from re-rendering the whole AppShell (navbar NavLinks, tab strip, tooltips),
 * which cost ~140ms of main-thread work per second and dropped frames while
 * scrolling a narrator.
 */
function OutputStatsBadge({ enabled }: { enabled: boolean }) {
	const { t } = useTranslation("nav");
	const stats = useOutputStats(enabled);
	if (!enabled || stats.charsPerSec <= 0) return null;
	return (
		<Tooltip
			label={`${t("totalOutputChars")}: ${formatChars(stats.totalChars)}`}
			position="bottom"
			withArrow
		>
			<Text size="sm" c="dimmed" style={{ cursor: "default", fontVariantNumeric: "tabular-nums" }}>
				{formatRate(stats.charsPerSec)}
			</Text>
		</Tooltip>
	);
}

function AuthenticatedLayout() {
	const [opened, { toggle, open: openNav, close: closeNav }] = useDisclosure();
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY, undefined, {
		getInitialValueInEffect: false,
	});
	// Touch/pen input only: a mouse drag across the header must keep collapsing
	// the sidebar rather than arming a reload gesture.
	const isTouchPointer = useMediaQuery("(pointer: coarse)", false, {
		getInitialValueInEffect: false,
	});
	const headerRef = useRef<HTMLElement>(null);
	const [logoutOpened, { open: openLogout, close: closeLogout }] = useDisclosure(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const navigate = useNavigate();
	const router = useRouter();
	const { t, i18n } = useTranslation("nav");
	const { t: ts } = useTranslation("settings");
	const { data: user, isLoading, isError, error, fetchStatus } = useCurrentUser();
	const { logout } = useLogout();
	const { data: prefs } = useUserPreferences();
	const updatePrefs = useUpdateUserPreferences();
	const { tabs, clearTabs } = useRecentTabs();
	const [oledMode] = useLocalPref("narrafork_oled");
	const [advancedAnim] = useLocalPref("narrafork_advanced_anim");
	const [narratorVirtualList, setNarratorVirtualList] = useLocalPref(
		"narrafork_narrator_virtual_list",
	);
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
	const appShellScrollKey = useAppShellHistoryEntryKey();
	// `/auth/me` is session-only, so a 401 here means this session is unusable —
	// but only when the error code actually says so.
	const meError = error as ApiError | null;
	const sessionLost =
		isError && meError?.status === 401 && isSessionInvalidResponse(meError.data ?? null);
	const appShellReady =
		hasToken && !sessionLost && !(isLoading || (!user && fetchStatus === "fetching"));
	useAppShellMainScrollRestoration(appShellScrollKey, appShellReady);
	const {
		width: navWidth,
		collapsed: navCollapsed,
		onDragStart: onNavDragStart,
		toggleCollapsed: toggleNavCollapsed,
	} = useResizableNav();
	const {
		entries: navEntries,
		visibleItems: navVisibleItems,
		saveLayout: saveNavLayout,
	} = useNavLayout();
	// Knowledge review inbox badge. Mounted here (not in the knowledge route) so the
	// count stays live on every page; kept fresh by the WS listener below rather than
	// by polling.
	useKnowledgeNotifications();
	const knowledgeInbox = useReviewInboxCount();
	const knowledgeInboxCount = knowledgeInbox.data?.count ?? 0;
	const knowledgeInboxLabel = knowledgeInbox.data?.capped
		? `${knowledgeInboxCount}+`
		: String(knowledgeInboxCount);
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

	// Install/remove the authenticated root contract before paint so public ↔ app
	// navigation never exposes a one-frame change in the vertical scroll owner.
	useBrowserLayoutEffect(() => {
		const removeRootLock = installAuthenticatedAppShellRootLock();
		const stopViewportTracking = installAppViewportTracking();
		return () => {
			stopViewportTracking();
			removeRootLock();
		};
	}, []);

	// --- Global narrator WebSocket connection ---
	useEffect(() => {
		narratorWSManager.connect();
		return () => narratorWSManager.disconnect();
	}, []);

	// --- Setup wizard ---
	const [wizardOpen, setWizardOpen] = useState(false);
	const wizardAutoOpenedRef = useRef(false);

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
		if (prefs?.setupWizardCompleted !== false) {
			wizardAutoOpenedRef.current = false;
			return;
		}
		if (user?.role === "admin" && !wizardAutoOpenedRef.current) {
			wizardAutoOpenedRef.current = true;
			setWizardOpen(true);
		}
	}, [user?.role, prefs?.setupWizardCompleted]);

	// Listen for open-wizard events from other pages. The wizard configures
	// instance-wide settings, so it stays admin-only no matter who dispatches it.
	const [wizardInitialStep, setWizardInitialStep] = useState<number | undefined>();
	const isAdmin = user?.role === "admin";
	useEffect(() => {
		const handler = (e: Event) => {
			if (!isAdmin) return;
			const step = (e as CustomEvent).detail?.step as number | undefined;
			setWizardInitialStep(step);
			setWizardOpen(true);
		};
		window.addEventListener("narrafork:open-wizard", handler);
		return () => window.removeEventListener("narrafork:open-wizard", handler);
	}, [isAdmin]);

	useEffect(() => {
		if (wizardOpen && isMobile) openNav();
	}, [wizardOpen, isMobile, openNav]);

	// --- Mobile navbar back-button interception ---
	// The shared controller creates a valid TanStack entry and, when navigation starts while
	// it is open, consumes that entry before replaying the route change. This keeps Back at one hop.
	//
	// Gated on `isMobile` because `opened` only *controls* the navbar below the sm breakpoint
	// (`collapsed: { mobile: !opened }`); at the desktop breakpoint the navbar is a permanent
	// column and `opened` is inert. It is also sticky: opening the burger and then widening the
	// window (or rotating a tablet) leaves `opened === true` on desktop, which pushed a sentinel
	// that intercepted Back with no overlay on screen to close.
	useEffect(() => {
		if (!opened || !isMobile) return;
		return pushHistorySentinel(router.history, APP_HISTORY_SENTINEL.mobileNav, closeNav).dispose;
	}, [opened, isMobile, closeNav, router.history]);

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

	// Token exists but auth failed (expired/invalid/user gone) → clear token and redirect.
	// Don't clear on transient server errors (502, network issues, etc.), and don't
	// clear on a 401 that reports something other than session loss — the API client
	// already dropped the token when it was genuinely dead.
	if (sessionLost) {
		clearToken();
		return <Navigate to="/login" />;
	}

	// Token exists, query in flight → show loader
	if (isLoading || (!user && fetchStatus === "fetching")) {
		return (
			<Center h={APP_VIEWPORT_BOTTOM}>
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
	const effectiveNavWidth = wizardOpen ? "min(420px, 100vw)" : navWidth;
	// The Navbar's gutter for the three sides that are not the bottom edge. The bottom
	// edge is owned by the `data-safe-area` spacer, which folds this same value into a
	// `max()` against the inset instead of adding to it.
	const navbarPadding = wizardOpen ? 0 : navCollapsed ? 4 : "md";
	const navbarBottomGutter = appShellNavbarBottomGutter(
		wizardOpen ? "0px" : navCollapsed ? "4px" : "var(--mantine-spacing-md)",
	);

	const handleSearchKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") handleSearch();
		if (e.key === "Escape") setSearchOpen(false);
	};

	return (
		<AppShell
			className={APP_SHELL_CLASSNAME}
			layout="alt"
			header={{ height: APP_SHELL_HEADER_HEIGHT }}
			navbar={{
				width: effectiveNavWidth,
				breakpoint: "sm",
				collapsed: { mobile: !opened },
			}}
			padding="md"
		>
			<WSConnectionAlert />
			<VersionUpdateBanner />
			<AppShell.Header ref={headerRef} style={APP_SHELL_SAFE_HEADER_STYLE}>
				<HeaderPullToRefresh targetRef={headerRef} enabled={isTouchPointer && !wizardOpen} />
				{wizardOpen && !opened && (
					<Button
						hiddenFrom="sm"
						fullWidth
						h="100%"
						radius={0}
						variant="light"
						leftSection={<IconArrowLeft size={18} />}
						onClick={openNav}
					>
						{ts("wizardReturn")}
					</Button>
				)}
				<Group
					h="100%"
					px="md"
					justify="space-between"
					wrap="nowrap"
					visibleFrom={wizardOpen && !opened ? "sm" : undefined}
				>
					<Group wrap="nowrap">
						<Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
						<Tooltip
							label={t(navCollapsed ? "expandSidebar" : "collapseSidebar")}
							position="bottom"
							openDelay={400}
							disabled={wizardOpen}
						>
							<Title
								order={3}
								visibleFrom="sm"
								onClick={wizardOpen ? undefined : toggleNavCollapsed}
								style={{ cursor: wizardOpen ? "default" : "pointer", userSelect: "none" }}
							>
								{t("appName")}
							</Title>
						</Tooltip>
						{NARRATOR_VIRTUAL_LIST_INTERACTIVE && (
							<Tooltip
								label={t("narratorVirtualListToggle")}
								position="bottom"
								withArrow
								openDelay={400}
							>
								<Switch
									size="sm"
									checked={narratorVirtualList}
									onChange={(e) => setNarratorVirtualList(e.currentTarget.checked)}
									thumbIcon={
										narratorVirtualList ? (
											<IconLayoutList size={12} color="var(--mantine-color-indigo-6)" />
										) : undefined
									}
									aria-label={t("narratorVirtualListToggle")}
									style={{ flexShrink: 0 }}
								/>
							</Tooltip>
						)}

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
						<OutputStatsBadge enabled={prefs?.showOutputStats ?? false} />
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
				top={{ base: APP_SHELL_HEADER_OFFSET, sm: SAFE_AREA_INSET_TOP }}
				h={{
					base: APP_SHELL_MOBILE_NAVBAR_HEIGHT,
					sm: APP_SHELL_DESKTOP_NAVBAR_HEIGHT,
				}}
				// `px`/`pt` rather than `p`: the bottom gutter is the `data-safe-area` spacer
				// below, and a symmetric `p` here would stack under it — the same
				// inset-plus-spacing double reservation APP_SHELL_MAIN_PADDING_BOTTOM removed
				// from Main (measured 50px where 34px was intended). Splitting the sides out
				// keeps one owner per edge instead of relying on `p`/`pb` precedence.
				px={navbarPadding}
				pt={navbarPadding}
				data-collapsed={!wizardOpen && navCollapsed ? true : undefined}
				style={{
					display: "flex",
					flexDirection: "column",
					isolation: "isolate",
					transition: "padding 150ms ease",
				}}
			>
				<RecentTabsWSProvider />
				{wizardOpen ? (
					// The wizard replaces the navbar contents, so a failed chunk here used to
					// take down the shell that hosts it and leave no way to navigate.
					<LazyOverlayBoundary resetKey={wizardOpen} label={ts("wizardTitle")}>
						<Suspense fallback={null}>
							<SetupWizard
								initialStep={wizardInitialStep}
								onClose={() => {
									setWizardOpen(false);
									setWizardInitialStep(undefined);
									closeNav();
								}}
							/>
						</Suspense>
					</LazyOverlayBoundary>
				) : (
					<>
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
								/>
							</Tooltip>
							{projectsVisible && (
								<Tooltip label={t("projects")} position="right" disabled={!navCollapsed}>
									<NavLink
										component={Link}
										to="/projects"
										label={navCollapsed ? undefined : t("projects")}
										leftSection={<IconFolders size={16} />}
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
								<RecentTabList filter="project" firstTabConnected />
							</Box>
						)}
						<Box>
							<Tooltip label={t("narrators")} position="right" disabled={!navCollapsed}>
								<NavLink
									label={navCollapsed ? undefined : t("narrators")}
									active={pathname.startsWith("/narrators")}
									leftSection={<IconMessageChatbot size={16} />}
									onClick={() => navigate({ to: "/narrators" })}
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
															closeNav();
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
								<RecentTabList filter="narrator" firstTabConnected />
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
								const badgeCount = def.badge === "knowledgeReviewInbox" ? knowledgeInboxCount : 0;
								const badgeLabel = def.badge === "knowledgeReviewInbox" ? knowledgeInboxLabel : "";
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
											leftSection={
												badgeCount > 0 && navCollapsed ? (
													// Collapsed rail has no room for a right section — dot the icon instead.
													<Indicator size={7} color="indigo" offset={2} withBorder>
														<Icon size={16} />
													</Indicator>
												) : (
													<Icon size={16} />
												)
											}
											rightSection={
												badgeCount > 0 && !navCollapsed ? (
													<Badge size="sm" circle variant="filled" color="indigo">
														{badgeLabel}
													</Badge>
												) : undefined
											}
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
					</>
				)}
				{/*
				 * The Navbar's sole bottom gutter: home-indicator clearance where there is an
				 * inset, the state's ordinary padding where there is not. `max()`, not a sum,
				 * for the reason APP_SHELL_MAIN_PADDING_BOTTOM documents — this box used to be
				 * the inset alone and sat on top of the Navbar's symmetric `p`, reserving the
				 * strip twice (measured 50px of gutter for a 34px indicator).
				 */}
				<Box
					aria-hidden
					data-safe-area="bottom"
					h={navbarBottomGutter}
					mih={navbarBottomGutter}
					style={{ flexShrink: 0, backgroundColor: "var(--mantine-color-body)" }}
				/>
			</AppShell.Navbar>

			<AppShell.Main
				id={APP_SHELL_MAIN_ID}
				className={APP_SHELL_MAIN_CLASSNAME}
				style={{ paddingBottom: APP_SHELL_MAIN_PADDING_BOTTOM }}
			>
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

			<SummaryModelPickerHost />
			<ProviderBaseUrlFixHost />
			<BrokenModelMigrationHost />

			{createNarratorOpened && (
				<LazyOverlayBoundary resetKey={createNarratorOpened} label={t("newNarrator")}>
					<Suspense fallback={null}>
						<CreateNarratorModal
							opened={createNarratorOpened}
							onClose={() => setCreateNarratorOpened(false)}
							onCreated={handleNarratorCreated}
						/>
					</Suspense>
				</LazyOverlayBoundary>
			)}
		</AppShell>
	);
}
