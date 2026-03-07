import { useResizableNav } from "@frontend/hooks/useResizableNav";
import {
	ActionIcon,
	AppShell,
	Box,
	Burger,
	Button,
	Center,
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
	Link,
	Navigate,
	Outlet,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTabActive, RecentTabList, RecentTabsWSProvider } from "../components/nav/RecentTabs";
import { WSConnectionAlert } from "../components/WSConnectionAlert";
import { useCurrentUser, useLogout } from "../hooks/useAuth";
import { useLocalPref } from "../hooks/useLocalPref";
import { useOutputStats } from "../hooks/useOutputStats";
import { useRecentTabs } from "../hooks/useRecentTabs";
import { useUserPreferences } from "../hooks/useUserPreferences";
import { type ApiError, clearToken, getToken } from "../lib/api";

interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	component: RootLayout,
});

function RootLayout() {
	const location = useRouterState({ select: (s) => s.location });
	const isLoginPage = location.pathname === "/login";

	if (isLoginPage) return <Outlet />;

	return <AuthenticatedLayout />;
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
	const computedScheme = useComputedColorScheme("dark");
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const { width: navWidth, onDragStart: onNavDragStart } = useResizableNav();
	const outputStats = useOutputStats(prefs?.showOutputStats ?? false);

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
	const firstNarratorTabActive = narratorTabs.length > 0 && isTabActive(narratorTabs[0], pathname);

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
			<AppShell.Header>
				<Group h="100%" px="md" justify="space-between" wrap="nowrap">
					<Group wrap="nowrap">
						<Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
						<Title order={3} visibleFrom="sm">
							{t("appName")}
						</Title>
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

			<AppShell.Navbar p="md" style={{ display: "flex", flexDirection: "column" }}>
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
					<NavLink
						component={Link}
						to="/"
						label={t("dashboard")}
						leftSection={<IconDashboard size={16} />}
						onClick={closeNavForLink}
					/>
					<NavLink
						component={Link}
						to="/projects"
						label={t("projects")}
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
							tabs.some((t) => t.type === "project") ? (
								<Tooltip label={t("clearProjects")} position="right" withArrow>
									<ActionIcon
										size={28}
										variant="subtle"
										color="gray"
										onClick={(e: React.MouseEvent) => {
											e.preventDefault();
											e.stopPropagation();
											clearTabs("projects");
										}}
										aria-label={t("clearProjects")}
									>
										<IconClearAll size={16} />
									</ActionIcon>
								</Tooltip>
							) : undefined
						}
					/>
				</Box>
				<Box style={{ overflow: "auto", minHeight: 0 }}>
					<RecentTabList filter="project" onNavigate={closeNavForLink} firstTabConnected />
				</Box>
				<Box>
					<NavLink
						component={Link}
						to="/narrators"
						label={t("narrators")}
						leftSection={<IconMessageChatbot size={16} />}
						onClick={closeNavForLink}
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
												clearTabs("inactive_narrators");
											}}
											aria-label={t("clearNarrators")}
										>
											<IconClearAll size={16} />
										</ActionIcon>
									</Tooltip>
								)}
							</Group>
						}
					/>
				</Box>
				<Box style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
					<RecentTabList filter="narrator" onNavigate={closeNavForLink} firstTabConnected />
				</Box>
				<Box>
					{user?.role === "admin" && (
						<NavLink
							component={Link}
							to="/admin"
							label={t("admin")}
							leftSection={<IconShieldCog size={16} />}
							onClick={closeNavForLink}
						/>
					)}
					<NavLink
						component={Link}
						to="/routines"
						label={t("routines")}
						leftSection={<IconWand size={16} />}
						onClick={closeNavForLink}
					/>
					<NavLink
						component={Link}
						to="/settings"
						label={t("settings")}
						leftSection={<IconSettings size={16} />}
						onClick={closeNavForLink}
					/>
				</Box>
				<NavLink
					label={t("logout")}
					leftSection={<IconLogout size={16} />}
					onClick={openLogout}
					color="red"
					variant="subtle"
				/>
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
		</AppShell>
	);
}
