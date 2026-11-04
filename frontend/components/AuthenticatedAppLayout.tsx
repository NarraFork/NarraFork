import {
	startNavResize,
	toggleNavCollapsed,
	useNavCollapsed,
	useNavWidth,
} from "@frontend/hooks/useResizableNav";
import type { AppShellProps } from "@mantine/core";
import {
	AppShell,
	Box,
	Burger,
	Button,
	Center,
	Group,
	Loader,
	Modal,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { IconAlertTriangle, IconArrowLeft } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
import { useUpdateUserPreferences, useUserPreferences } from "../hooks/useUserPreferences";
import { useWakeLock } from "../hooks/useWakeLock";
import { api, clearToken } from "../lib/api";
import {
	useAppShellHistoryEntryKey,
	useAppShellMainScrollRestoration,
	useBrowserLayoutEffect,
} from "../lib/app-shell-scroll";
import { APP_HISTORY_SENTINEL, pushHistorySentinel } from "../lib/history-state";
import { getNamespacesForPath } from "../lib/i18n";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import {
	APP_SHELL_CLASSNAME,
	APP_SHELL_DESKTOP_NAVBAR_HEIGHT,
	APP_SHELL_HEADER_HEIGHTS,
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
import { installThemeColorSync } from "../lib/theme-color-sync";
import { installWcoTracking } from "../lib/wco";
import { BrandTitle } from "./common/BrandTitle";
import { I18nNamespaceGate } from "./common/I18nNamespaceGate";
import { LazyOverlayBoundary } from "./common/LazyOverlayBoundary";
import { RoutePendingIndicator } from "./common/RouteChunkErrorBoundary";
import { GitMissingAlert } from "./GitMissingAlert";
import { HeaderPullToRefresh } from "./nav/HeaderPullToRefresh";
import { NavBottomBar } from "./nav/NavBottomBar";
import { NavTopSection } from "./nav/NavTopSection";
import { RecentTabList, RecentTabsWSProvider } from "./nav/RecentTabs";
import { NotificationBell } from "./notifications/NotificationBell";
import { PluginPermissionRequestHost } from "./plugins-admin/PluginPermissionRequestHost";
import { StartupRecoveryAlert } from "./StartupRecoveryAlert";
import { SystemMaintenanceBadge } from "./SystemMaintenanceBadge";
import { BrokenModelMigrationHost } from "./settings/BrokenModelMigrationHost";
import { ProviderBaseUrlFixHost } from "./settings/ProviderBaseUrlFixHost";
import { SummaryModelPickerHost } from "./settings/SummaryModelPickerHost";
import { TokenDanceRecoveryHost } from "./settings/TokenDanceRecoveryHost";
import { UpdateBadge } from "./UpdateBadge";
import { VersionUpdateBanner } from "./VersionUpdateBanner";
import { WSConnectionAlert } from "./WSConnectionAlert";

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
	const navigate = useNavigate();
	const { t } = useTranslation("nav");
	const { t: ts } = useTranslation("settings");
	const { data: user, isLoading, fetchStatus, hasToken, sessionLost } = useAuthenticatedSession();
	const { logout } = useLogout();
	const { data: prefs } = useUserPreferences();
	const updatePrefs = useUpdateUserPreferences();
	useAuthenticatedAppearance(prefs);
	const [wakeLockEnabled] = useLocalPref("narrafork_wakelock");
	useWakeLock(wakeLockEnabled);
	useRecentTabKeyboardNav();

	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		enabled: hasToken,
	});
	const requestEvidenceAutoPin = settings?.requestEvidence?.autoPin;
	const requestEvidencePinning =
		requestEvidenceAutoPin === "all" || requestEvidenceAutoPin === "errors";

	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const previewLoginRedirect = useRouterState({
		select: ({ location }) =>
			location.pathname.startsWith("/git/narrators/") ? location.href : undefined,
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
		// PWA Window Controls Overlay: publishes html[data-nf-wco]; all adaptation
		// is CSS (styles/wco.css), so this is the only JS hookup the shell needs.
		const stopWcoTracking = installWcoTracking();
		// The WCO buttons paint theme-color as their background (not transparent),
		// so it must follow the shell's real background across theme changes.
		const stopThemeColorSync = installThemeColorSync();
		return () => {
			stopThemeColorSync();
			stopWcoTracking();
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

	const openRequestEvidenceSetting = () => {
		navigate({ to: "/settings/agent", hash: "request-evidence" });
	};

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
			header={{ height: APP_SHELL_HEADER_HEIGHTS }}
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
				{/* Phones only: on desktop everything in this row lives in the sidebar. While the
				    wizard holds the drawer closed, its return button replaces the row. */}
				{!(wizardOpen && !opened) && (
					<Group
						h="100%"
						px="md"
						justify="space-between"
						wrap="nowrap"
						className="nf-header-row"
						hiddenFrom="sm"
					>
						<Group wrap="nowrap" className="nf-header-side">
							<Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
							<BrandTitle order={3} hiddenFrom="sm" />
						</Group>
						{/* Phones keep the bell here: the sidebar is a drawer they have to open. */}
						<Group wrap="nowrap" className="nf-header-side">
							<NotificationBell />
						</Group>
					</Group>
				)}
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
				{/* WCO (buttons left, e.g. macOS): pushes nav content below the traffic
				    lights and doubles as drag surface. display:none everywhere else —
				    see styles/wco.css. */}
				<Box className="nf-wco-nav-spacer" aria-hidden />
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
						<NavTopSection
							collapsed={navCollapsed}
							onToggleCollapsed={toggleNavCollapsed}
							onNavigate={closeNav}
							statusBadges={
								<>
									<SystemMaintenanceBadge />
									<UpdateBadge />
									{requestEvidencePinning && (
										<Tooltip
											label={t(
												requestEvidenceAutoPin === "errors"
													? "requestEvidenceErrorsTooltip"
													: "requestEvidenceAllTooltip",
											)}
											position="right"
											withArrow
										>
											<Button
												variant="light"
												color="orange"
												size="compact-xs"
												leftSection={<IconAlertTriangle size={12} />}
												onClick={openRequestEvidenceSetting}
												style={{ flexShrink: 0 }}
											>
												{t("requestEvidencePinningBadge")}
											</Button>
										</Tooltip>
									)}
									<OutputStatsBadge enabled={prefs?.showOutputStats ?? false} />
								</>
							}
						/>
						{!navCollapsed && (
							<Box style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
								<RecentTabList filter="narrator" />
							</Box>
						)}
						<NavBottomBar
							collapsed={navCollapsed}
							entries={navEntries}
							visibleItems={navVisibleItems}
							onSaveLayout={saveNavLayout}
							onLogout={openLogout}
						/>
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
				{/* WCO on desktop: the title-bar strip over the page, and its drag surface
				    (there is no header row). display:none everywhere else, see wco.css. */}
				<Box className="nf-wco-main-strip" aria-hidden />
				{/*
				 * No data-directory permission probe here: it ran on every login and turned an
				 * inconclusive check (slow filesystem, timeout) into a permission warning.
				 * The check lives in Settings > Storage, where an operator asks for it.
				 */}
				<GitMissingAlert />
				<StartupRecoveryAlert />
				<Suspense fallback={<RoutePendingIndicator />}>
					<I18nNamespaceGate namespaces={getNamespacesForPath(pathname)}>
						<Outlet />
					</I18nNamespaceGate>
				</Suspense>
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
			<TokenDanceRecoveryHost />
			<BrokenModelMigrationHost />
			<PluginPermissionRequestHost />

			{/*
			 * The two fixed top banners are rendered LAST on purpose.
			 *
			 * Under WCO the whole title-bar strip is ours and the header row is the
			 * drag surface (`styles/wco.css`), so the banners paint over a draggable
			 * rect. `-webkit-app-region` hit-testing is purely geometric, and the
			 * browser folds the rects the page reported into one region *in list
			 * order, later rects winning where they overlap* — the list being the
			 * layout-tree order. A banner emitted before the header row therefore
			 * loses its clicks to window dragging: only its own `no-drag` rect, seen
			 * after the row's `drag` rect, can cancel it. The header clusters work
			 * because they are children of the row and so are collected after it;
			 * these banners are siblings, so their place in the tree is what decides.
			 * Emitted after every drag surface (the phone header row, the navbar's WCO
			 * spacer and brand row, the strip above Main), they are collected last and
			 * stay clickable.
			 */}
			<WSConnectionAlert />
			<VersionUpdateBanner />
		</AppShellWithNavWidth>
	);
}
