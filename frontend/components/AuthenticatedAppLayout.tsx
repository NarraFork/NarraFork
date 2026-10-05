import {
	startNavResize,
	toggleNavCollapsed,
	useNavCollapsed,
	useNavWidth,
} from "@frontend/hooks/useResizableNav";
import type { AppShellProps } from "@mantine/core";
import {
	ActionIcon,
	Anchor,
	AppShell,
	Badge,
	Box,
	Burger,
	Button,
	Center,
	Group,
	Indicator,
	Loader,
	Menu,
	Modal,
	NavLink,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
	IconAdjustmentsHorizontal,
	IconAlertTriangle,
	IconArrowLeft,
	IconCheck,
	IconClearAll,
	IconDashboard,
	IconFolders,
	IconList,
	IconMessageChatbot,
	IconMessageReport,
	IconPlus,
	IconSettings,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
	Link,
	Navigate,
	Outlet,
	useNavigate,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLogout } from "../hooks/useAuth";
import { useAuthenticatedAppearance } from "../hooks/useAuthenticatedAppearance";
import { useAuthenticatedSession } from "../hooks/useAuthenticatedSession";
import { useChatUnreadLive } from "../hooks/useChat";
import { useKnowledgeNotifications } from "../hooks/useKnowledge";
import { useLocalPref } from "../hooks/useLocalPref";
import { useMobileViewport } from "../hooks/useMobileViewport";
import { useNavLayout } from "../hooks/useNavLayout";
import { useOutputStats } from "../hooks/useOutputStats";
import { useRecentTabKeyboardNav } from "../hooks/useRecentTabKeyboardNav";
import { addRecentTab, useRecentTabs } from "../hooks/useRecentTabs";
import { useSetupWizardGuard } from "../hooks/useSetupWizardGuard";
import { useUpdateUserPreferences, useUserPreferences } from "../hooks/useUserPreferences";
import { useWakeLock } from "../hooks/useWakeLock";
import { api, clearToken } from "../lib/api";
import {
	useAppShellHistoryEntryKey,
	useAppShellMainScrollRestoration,
	useBrowserLayoutEffect,
} from "../lib/app-shell-scroll";
import { APP_HISTORY_SENTINEL, pushHistorySentinel } from "../lib/history-state";
import { narratorWSManager } from "../lib/narrator-ws-manager";
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
import { BrandTitle } from "./common/BrandTitle";
import { LazyOverlayBoundary } from "./common/LazyOverlayBoundary";
import { GitMissingAlert } from "./GitMissingAlert";
import type { CreateNarratorResult } from "./narrator/CreateNarratorModal";
import { HeaderPullToRefresh } from "./nav/HeaderPullToRefresh";
import { HeaderSearchBox } from "./nav/HeaderSearchBox";
import { NavOverflowMenu } from "./nav/NavOverflowMenu";
import { NavUserMenu } from "./nav/NavUserMenu";
import { CUSTOMIZABLE_NAV_ITEMS } from "./nav/nav-items";
import { RecentTabList, RecentTabsWSProvider } from "./nav/RecentTabs";
// `isTabActive` comes from the logic module, not `RecentTabs.tsx`: a non-component export
// there breaks its Fast Refresh boundary and turns tab-list edits into page reloads.
import { isTabActive } from "./nav/recent-tabs-logic";
import { useNavBadges } from "./nav/use-nav-badges";
import { NotificationBell } from "./notifications/NotificationBell";
import { PluginPermissionRequestHost } from "./plugins-admin/PluginPermissionRequestHost";
import { StartupRecoveryAlert } from "./StartupRecoveryAlert";
import { SystemMaintenanceBadge } from "./SystemMaintenanceBadge";
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

/**
 * The mobile breakpoint only affects these two side effects, not shell JSX.
 * Keep its subscription here so resizing does not reconcile the entire navbar.
 */
export function MobileNavbarEffects({
	wizardOpen,
	opened,
	openNav,
	closeNav,
}: {
	wizardOpen: boolean;
	opened: boolean;
	openNav: () => void;
	closeNav: () => void;
}) {
	const router = useRouter();
	const isMobile = useMobileViewport();
	useEffect(() => {
		if (wizardOpen && isMobile) openNav();
	}, [wizardOpen, isMobile, openNav]);

	// The shared controller consumes the same-URL entry before replaying route
	// navigation, keeping Back at one hop. `opened` is sticky across widening,
	// but only controls an overlay on mobile: desktop must never intercept Back.
	useEffect(() => {
		if (!opened || !isMobile) return;
		return pushHistorySentinel(router.history, APP_HISTORY_SENTINEL.mobileNav, closeNav).dispose;
	}, [opened, isMobile, closeNav, router.history]);
	return null;
}

/**
 * Only this thin wrapper subscribes to the settled nav width. Drag frames update
 * DOM layout properties without notifying React; releases and collapse-threshold
 * crossings let Mantine take over. Keeping `children` as a stable element isolates
 * the navbar's RecentTabLists, NavLinks and Tooltips from width-only commits.
 *
 * Do not move the width subscription into AuthenticatedLayout or navbar content
 * into this wrapper: either change restores the expensive shell-wide re-render.
 */
function AppShellWithNavWidth({
	navbar,
	wizardWidth,
	children,
	...props
}: Omit<AppShellProps, "navbar"> & {
	navbar: Omit<NonNullable<AppShellProps["navbar"]>, "width"> &
		Pick<NonNullable<AppShellProps["navbar"]>, "breakpoint">;
	/** Fixed width while the setup wizard owns the sidebar (overrides the drag). */
	wizardWidth?: string;
}) {
	const navWidth = useNavWidth();
	return (
		<AppShell {...props} navbar={{ ...navbar, width: wizardWidth ?? navWidth }}>
			{children}
		</AppShell>
	);
}

export function AuthenticatedLayout() {
	const [opened, { toggle, open: openNav, close: closeNav }] = useDisclosure();
	// Touch/pen input only: a mouse drag across the header must keep collapsing
	// the sidebar rather than arming a reload gesture.
	const isTouchPointer = useMediaQuery("(pointer: coarse)", false, {
		getInitialValueInEffect: false,
	});
	const headerRef = useRef<HTMLElement>(null);
	const [logoutOpened, { open: openLogout, close: closeLogout }] = useDisclosure(false);
	// The search QUERY state lives in HeaderSearchBox (per-keystroke re-renders
	// must not touch the AppShell). Only the mobile open/closed toggle stays
	// here because the title below is gated on it.
	const [searchOpen, setSearchOpen] = useState(false);
	const navigate = useNavigate();
	const { t } = useTranslation("nav");
	const { t: ts } = useTranslation("settings");
	const { data: user, isLoading, fetchStatus, hasToken, sessionLost } = useAuthenticatedSession();
	const { logout } = useLogout();
	const { data: prefs } = useUserPreferences();
	const updatePrefs = useUpdateUserPreferences();
	const tabGroupMode = prefs?.recentTabsGroupMode ?? "flat";
	const { tabs, clearTabs } = useRecentTabs();
	useAuthenticatedAppearance(prefs);
	const [wakeLockEnabled] = useLocalPref("narrafork_wakelock");
	useWakeLock(wakeLockEnabled);
	useRecentTabKeyboardNav();

	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		enabled: hasToken,
	});
	const requestDumpEnabled = settings?.agent?.requestDumpEnabled === true;
	const requestDumpErrorsOnly = settings?.agent?.requestDumpErrorsOnly === true;

	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const previewLoginRedirect = useRouterState({
		select: ({ location }) =>
			location.pathname.startsWith("/git/narrators/") ||
			location.pathname.startsWith("/git/chapters/")
				? location.href
				: undefined,
	});
	const appShellScrollKey = useAppShellHistoryEntryKey();
	const appShellReady =
		hasToken && !sessionLost && !(isLoading || (!user && fetchStatus === "fetching"));
	useAppShellMainScrollRestoration(appShellScrollKey, appShellReady);
	// COLLAPSED ONLY — deliberately not the width. The navbar content below needs the
	// boolean (labels, tooltips, padding), which flips at most once per drag, whereas
	// the width changes every frame. Subscribing to the width here is what made a
	// resize re-render this entire component; it now lives in AppShellWithNavWidth.
	const navCollapsed = useNavCollapsed();
	const {
		entries: navEntries,
		visibleItems: navVisibleItems,
		saveLayout: saveNavLayout,
	} = useNavLayout();
	// Knowledge review inbox badge. Mounted here (not in the knowledge route) so the
	// count stays live on every page; kept fresh by the WS listener below rather than
	// by polling.
	useKnowledgeNotifications();
	// Keeps the chat badge live: the per-user `chat:unread_changed` push reaches this
	// client even for rooms it has not subscribed to, so the count is correct without
	// polling and without opening the conversation.
	useChatUnreadLive();
	// Every nav badge is resolved by one shared hook so a new badge key cannot be
	// silently ignored by one of the two surfaces that paint the nav.
	const resolveNavBadge = useNavBadges();
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
		return <Navigate to="/login" search={{ redirect: previewLoginRedirect }} replace />;
	}

	// Token exists but auth failed (expired/invalid/user gone) → clear token and redirect.
	// Don't clear on transient server errors (502, network issues, etc.), and don't
	// clear on a 401 that reports something other than session loss — the API client
	// already dropped the token when it was genuinely dead.
	if (sessionLost) {
		clearToken();
		return <Navigate to="/login" search={{ redirect: previewLoginRedirect }} replace />;
	}

	// Token exists, query in flight → show loader
	if (isLoading || (!user && fetchStatus === "fetching")) {
		return (
			<Center h={APP_VIEWPORT_BOTTOM}>
				<Loader />
			</Center>
		);
	}

	const openRequestDumpSetting = () => {
		navigate({ to: "/settings/agent", hash: "request-dump-enabled" });
	};

	// Only session tabs are projected; persisted project visits are left untouched.
	const narratorTabs = tabs.filter((t) => t.type !== "project");
	const firstNarratorTabActive = narratorTabs.length > 0 && isTabActive(narratorTabs[0], pathname);

	const secondaryNavDefs = new Map(CUSTOMIZABLE_NAV_ITEMS.map((def) => [def.id, def]));
	// The Navbar's gutter for the three sides that are not the bottom edge. The bottom
	// edge is owned by the `data-safe-area` spacer, which folds this same value into a
	// `max()` against the inset instead of adding to it.
	const navbarPadding = wizardOpen ? 0 : navCollapsed ? 4 : "md";
	const navbarBottomGutter = appShellNavbarBottomGutter(
		wizardOpen ? "0px" : navCollapsed ? "4px" : "var(--mantine-spacing-md)",
	);

	return (
		<AppShellWithNavWidth
			className={APP_SHELL_CLASSNAME}
			layout="alt"
			header={{ height: APP_SHELL_HEADER_HEIGHT }}
			// Only the wrapper subscribes to settled width and threshold crossings;
			// ordinary drag frames bypass React (see AppShellWithNavWidth).
			navbar={{
				breakpoint: "sm",
				collapsed: { mobile: !opened },
			}}
			wizardWidth={wizardOpen ? "min(420px, 100vw)" : undefined}
			padding="md"
		>
			<MobileNavbarEffects
				wizardOpen={wizardOpen}
				opened={opened}
				openNav={openNav}
				closeNav={closeNav}
			/>
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
							<BrandTitle
								order={3}
								visibleFrom="sm"
								onClick={wizardOpen ? undefined : toggleNavCollapsed}
								style={{ cursor: wizardOpen ? "default" : "pointer", userSelect: "none" }}
							/>
						</Tooltip>

						<SystemMaintenanceBadge />
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
						{!searchOpen && <BrandTitle order={3} hiddenFrom="sm" />}
					</Group>
					<Group wrap="nowrap">
						<OutputStatsBadge enabled={prefs?.showOutputStats ?? false} />
						<NotificationBell />
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
						<HeaderSearchBox searchOpen={searchOpen} onSearchOpenChange={setSearchOpen} />
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
						{/* Drag handle for resizing navbar. Pointer events so touch drags work;
						    `touch-action: none` keeps the browser from claiming the gesture as a
						    scroll (preventDefault on pointerdown cannot do that). */}
						<Box
							visibleFrom="sm"
							onPointerDown={startNavResize}
							style={{
								position: "absolute",
								top: 0,
								right: -3,
								width: 6,
								height: "100%",
								cursor: "col-resize",
								touchAction: "none",
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
						</Box>
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
												{/* Display-mode switch for the tab list below. Wrapped in a Box that
												    swallows the click: this lives INSIDE the NavLink, whose own
												    onClick navigates to /narrators, and both sibling ActionIcons
												    below stop propagation for the same reason. */}
												<Box
													onClick={(e: React.MouseEvent) => {
														e.preventDefault();
														e.stopPropagation();
													}}
													onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
													style={{ display: "flex" }}
												>
													<Menu position="right-start" withinPortal shadow="md" width={210}>
														<Menu.Target>
															<Tooltip label={t("recentTabsGrouping")} position="right" withArrow>
																<ActionIcon
																	size={28}
																	variant="subtle"
																	color="gray"
																	aria-label={t("recentTabsGrouping")}
																>
																	<IconAdjustmentsHorizontal size={16} />
																</ActionIcon>
															</Tooltip>
														</Menu.Target>
														<Menu.Dropdown>
															<Menu.Label>{t("recentTabsGrouping")}</Menu.Label>
															<Menu.Item
																leftSection={<IconList size={14} />}
																rightSection={
																	tabGroupMode === "flat" ? <IconCheck size={14} /> : undefined
																}
																onClick={() => updatePrefs.mutate({ recentTabsGroupMode: "flat" })}
															>
																{t("groupModeFlat")}
															</Menu.Item>
															<Menu.Item
																leftSection={<IconFolders size={14} />}
																rightSection={
																	tabGroupMode === "directory" ? <IconCheck size={14} /> : undefined
																}
																onClick={() =>
																	updatePrefs.mutate({ recentTabsGroupMode: "directory" })
																}
															>
																{t("groupModeDirectory")}
															</Menu.Item>
														</Menu.Dropdown>
													</Menu>
												</Box>
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
								const { count: badgeCount, label: badgeLabel } = resolveNavBadge(def.badge);
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
				{/*
				 * No data-directory permission probe here: it ran on every login and turned an
				 * inconclusive check (slow filesystem, timeout) into a permission warning.
				 * The check lives in Settings > Storage, where an operator asks for it.
				 */}
				<GitMissingAlert />
				<StartupRecoveryAlert />
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
			<PluginPermissionRequestHost />

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
		</AppShellWithNavWidth>
	);
}
