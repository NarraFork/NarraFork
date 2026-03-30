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
	IconClearAll,
	IconDashboard,
	IconFolders,
	IconLogout,
	IconMessageChatbot,
	IconMessageReport,
	IconPlus,
	IconSearch,
	IconSettings,
	IconShieldCog,
	IconWand,
	IconX,
} from "@tabler/icons-react";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	type ErrorComponentProps,
	Link,
	Navigate,
	Outlet,
	useNavigate,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitMissingAlert } from "../components/GitMissingAlert";
import { OverseerNavItem } from "../components/nav/OverseerNavItem";
import { isTabActive, RecentTabList, RecentTabsWSProvider } from "../components/nav/RecentTabs";
import { SetupWizard } from "../components/settings/SetupWizard";
import { SummaryModelPickerModal } from "../components/settings/SummaryModelPickerModal";
import { UpdateBadge } from "../components/UpdateBadge";
import { VersionUpdateBanner } from "../components/VersionUpdateBanner";
import { WSConnectionAlert } from "../components/WSConnectionAlert";
import { useCurrentUser, useLogout } from "../hooks/useAuth";
import { useLocalPref } from "../hooks/useLocalPref";
import { useOutputStats } from "../hooks/useOutputStats";
import { useGlobalOverseer } from "../hooks/useOverseers";
import { useRecentTabs } from "../hooks/useRecentTabs";
import { useUserPreferences } from "../hooks/useUserPreferences";
import { useWakeLock } from "../hooks/useWakeLock";
import { type ApiError, clearToken, getToken } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";

interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	component: RootLayout,
	errorComponent: RootErrorBoundary,
});

function RootErrorBoundary({ error, reset }: ErrorComponentProps) {
	const router = useRouter();
	const { t } = useTranslation("common");
	const isDev = import.meta.env.DEV;

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
							background: "var(--mantine-color-dark-7)",
							borderRadius: "var(--mantine-radius-sm)",
							overflow: "auto",
							maxHeight: 400,
						}}
					>
						<Text size="xs" ff="monospace" style={{ whiteSpace: "pre-wrap" }}>
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

function RootLayout() {
	const location = useRouterState({ select: (s) => s.location });
	const isLoginPage = location.pathname === "/login";
	const isPublicPage = location.pathname === "/licenses" || location.pathname === "/changelog";

	return (
		<>
			<GitMissingAlert />
			{isLoginPage ? (
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
	const { tabs, clearTabs } = useRecentTabs();
	const [oledMode] = useLocalPref("narrafork_oled");
	const [advancedAnim] = useLocalPref("narrafork_advanced_anim");
	const [wakeLockEnabled] = useLocalPref("narrafork_wakelock");
	useWakeLock(wakeLockEnabled);
	const computedScheme = useComputedColorScheme("dark");
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const {
		width: navWidth,
		collapsed: navCollapsed,
		onDragStart: onNavDragStart,
		toggleCollapsed: toggleNavCollapsed,
	} = useResizableNav();
	const outputStats = useOutputStats(prefs?.showOutputStats ?? false);
	const { data: globalOverseer } = useGlobalOverseer();
	const isOverseerPage =
		!!globalOverseer?.narratorId && pathname === `/narrators/${globalOverseer.narratorId}`;

	// --- Global narrator WebSocket connection ---
	useEffect(() => {
		narratorWSManager.connect();
		return () => narratorWSManager.disconnect();
	}, []);

	// --- Setup wizard ---
	const [wizardOpen, setWizardOpen] = useState(false);
	const [wizardMinimized, setWizardMinimized] = useState(false);
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
	useEffect(() => {
		if (prefs?.language && prefs.language !== i18n.language) {
			i18n.changeLanguage(prefs.language);
		}
	}, [prefs?.language, i18n]);

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

	const hasToken = !!getToken();

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

	// Check if the first tab in each group is active — used for connected border-radius
	const projectTabs = tabs.filter((t) => t.type === "project");
	const narratorTabs = tabs.filter((t) => t.type !== "project");
	const firstProjectTabActive = projectTabs.length > 0 && isTabActive(projectTabs[0], pathname);
	const firstNarratorTabActive =
		narratorTabs.length > 0 &&
		isTabActive(narratorTabs[0], pathname) &&
		narratorTabs[0].id !== globalOverseer?.narratorId;

	const handleSearchKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") handleSearch();
		if (e.key === "Escape") setSearchOpen(false);
	};

	return (
		<AppShell
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
					<OverseerNavItem onNavigate={closeNavForLink} collapsed={navCollapsed} />
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
				</Box>
				{!navCollapsed && (
					<Box style={{ overflow: "auto", minHeight: 0 }}>
						<RecentTabList filter="project" onNavigate={closeNavForLink} firstTabConnected />
					</Box>
				)}
				<Box>
					<Tooltip label={t("narrators")} position="right" disabled={!navCollapsed}>
						<NavLink
							label={navCollapsed ? undefined : t("narrators")}
							active={!isOverseerPage && pathname.startsWith("/narrators")}
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
													navigate({ to: "/narrators", search: { create: true } });
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
												!["thinking", "waiting", "done"].includes(t.status ?? ""),
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
						<RecentTabList
							filter="narrator"
							onNavigate={closeNavForLink}
							firstTabConnected
							excludeActiveNarratorId={globalOverseer?.narratorId}
						/>
					</Box>
				)}
				<Box>
					{user?.role === "admin" && (
						<Tooltip label={t("admin")} position="right" disabled={!navCollapsed}>
							<NavLink
								component={Link}
								to="/admin"
								label={navCollapsed ? undefined : t("admin")}
								leftSection={<IconShieldCog size={16} />}
								onClick={closeNavForLink}
							/>
						</Tooltip>
					)}
					<Tooltip label={t("routines")} position="right" disabled={!navCollapsed}>
						<NavLink
							component={Link}
							to="/routines"
							label={navCollapsed ? undefined : t("routines")}
							leftSection={<IconWand size={16} />}
							onClick={closeNavForLink}
						/>
					</Tooltip>
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
				<Tooltip label={t("logout")} position="right" disabled={!navCollapsed}>
					<NavLink
						label={navCollapsed ? undefined : t("logout")}
						leftSection={<IconLogout size={16} />}
						onClick={openLogout}
						color="red"
						variant="subtle"
					/>
				</Tooltip>
				{!navCollapsed && (
					<Text size="xs" c="dimmed" ta="center" mt={4}>
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

			<SummaryModelPickerModal />
		</AppShell>
	);
}
