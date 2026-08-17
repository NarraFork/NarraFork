// MUST stay the first import: it installs runtime built-ins that older Safari/WebKit
// lacks (Array.prototype.at, findLast/findLastIndex, Object.hasOwn, structuredClone).
// Vite's `safari14` target down-levels syntax only, so a shim installed after another
// module's top-level code has already run would be too late. See that file's header
// for the Safari 14 virtual-list flicker this prevents.
import "@frontend/lib/legacy-browser-polyfills";
import { reportReactRenderError } from "@frontend/lib/hmr-guard";
import "@frontend/lib/dom-mutation-guard";
import { Center, Loader, MantineProvider, v8CssVariablesResolver } from "@mantine/core";
import { DatesProvider } from "@mantine/dates";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/tiptap/styles.css";
import { AppNotifications } from "@frontend/components/AppNotifications";
import { ConfirmDialogProvider } from "@frontend/components/common/ConfirmDialogProvider";
import { ImageViewerProvider } from "@frontend/components/common/ImageViewerProvider";
import type {
	PluginDockPanelParams,
	PluginUiContext,
	PluginUiContribution,
	PluginUiSessionContext,
} from "@frontend/components/plugins";
import {
	invalidatePluginUiContributions,
	PluginThemeInjector,
	PluginUiRuntimeProvider,
	requestPluginUiBackend,
	resolvePluginUiContribution,
	syncPluginUiContributions,
} from "@frontend/components/plugins";
import { usePluginContributions } from "@frontend/hooks/usePluginContributions";
import { readActivePluginThemeKey } from "@frontend/hooks/usePluginThemes";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { installPinchZoomGuard } from "@frontend/lib/pinch-zoom-guard";
import "@frontend/styles/oled.css";
import "@frontend/styles/blur-anim.css";
import "@frontend/styles/nav-collapsed.css";
import "@frontend/styles/safe-area.css";
import "@frontend/styles/toast.css";
// Tool-call shimmer classes (card face + compact row text). Global because BOTH
// narrator render paths paint these and vlist may not import the chunk path — see
// each stylesheet's header.
import "@frontend/styles/card-shimmer.css";
import "@frontend/styles/trace-shimmer.css";

import { QueryClientProvider } from "@tanstack/react-query";
import {
	createBrowserHistory,
	createRouter,
	type RouterHistory,
	RouterProvider,
} from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import {
	RouteChunkErrorBoundary,
	RoutePendingIndicator,
} from "./components/common/RouteChunkErrorBoundary";
import { cleanupStaleNarratorDockLayouts } from "./components/narrator/dock/narrator-dock-layout";
import i18n, { getInitialNamespaces, initI18n } from "./lib/i18n";
import { mantineTheme } from "./lib/mantine-theme";
import { queryClient } from "./lib/query-client";
import { routeTree } from "./routeTree.gen";

const theme = mantineTheme;

function createAppRouter(history: RouterHistory) {
	return createRouter({
		history,
		routeTree,
		context: { queryClient },
		/*
		 * Give EVERY route its own error boundary.
		 *
		 * TanStack wraps each match in a CatchBoundary only when that match resolves an
		 * `errorComponent`; otherwise the error travels up to the nearest ancestor that
		 * has one. Previously only the root route did, so any failure in a leaf route
		 * unmounted the whole app shell and took the navigation with it — the user was
		 * left on a bare error screen with no links, recoverable only by a page load.
		 *
		 * This matters most for code-split route chunks, which the single-threaded
		 * backend serves alongside the API. While it is blocked by a long synchronous
		 * job (a storage scan on a large database is the known case) a chunk request can
		 * fail, and `lazyRouteComponent` caches that rejection for the lifetime of the
		 * document. Catching at the deepest match keeps every ancestor — sidebar, tab
		 * strip, header — mounted and usable.
		 *
		 * The root route keeps its own `errorComponent`, so failures during app
		 * bootstrap (i18n, shell layout) still get the full-page treatment.
		 */
		defaultErrorComponent: RouteChunkErrorBoundary,
		/*
		 * Show a spinner once a navigation has been pending long enough to notice.
		 * Without it, clicking a link while the backend is busy looks like a dead
		 * button: the router is waiting on the route chunk, but nothing on screen says
		 * so, which is exactly how the storage-scan stall was first reported.
		 */
		defaultPendingComponent: RoutePendingIndicator,
		defaultPendingMs: 400,
		defaultPendingMinMs: 300,
	});
}

type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
	interface Register {
		router: AppRouter;
	}
}

/**
 * App-shell plugin runtime wiring.
 *
 * Responsibilities:
 * - keep the host-owned contribution store in sync (login → token appears,
 *   WS reconnect → invalidate + refetch);
 * - build the handshake/context.get context from the live app shell.
 *
 * Host-local `panel.open` is intentionally NOT wired here: opening a Dockview
 * panel requires a surface-scoped api (focus dock vs. workspace), and the
 * router correctly reports NOT_SUPPORTED until a surface-level bridge lands.
 */
function PluginRuntimeShell({ children }: { children: React.ReactNode }) {
	// React Query-backed sync: enabled by getToken(), so it fires right after
	// login; mutations invalidate the same query key.
	usePluginContributions();

	// WS reconnect → resync the contribution snapshot (the event stream is only
	// an invalidation signal; the HTTP response remains the payload of truth).
	React.useEffect(
		() =>
			narratorWSManager.onConnectionChange((connected, isReconnect) => {
				if (connected && isReconnect) void syncPluginUiContributions().catch(() => {});
			}),
		[],
	);

	// Lifecycle mutations in another tab are delivered as an invalidation marker;
	// refetch the bounded HTTP snapshot so every open panel converges quickly.
	React.useEffect(() => {
		const listener = narratorWSManager.addListener(
			{ types: ["plugin_contributions_changed"] },
			() => {
				invalidatePluginUiContributions();
				void queryClient.invalidateQueries({ queryKey: ["plugins", "ui-contributions"] });
			},
		);
		return () => narratorWSManager.removeListener(listener);
	}, []);

	const colorScheme =
		typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches
			? ("light" as const)
			: ("dark" as const);

	const getContext = React.useCallback(
		(
			params: PluginDockPanelParams,
			sessionContext: PluginUiSessionContext,
			contribution: PluginUiContribution,
		): PluginUiContext => {
			return {
				contextVersion: 1,
				host: {
					appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown",
					locale: i18n.language || "en",
					colorScheme,
					platform: navigator.platform.toLowerCase().includes("win")
						? ("windows" as const)
						: navigator.platform.toLowerCase().includes("mac")
							? ("macos" as const)
							: ("linux" as const),
				},
				plugin: {
					id: params.pluginId,
					version: contribution.version || params.fallback?.pluginVersion || "unknown",
					contributionId: params.contributionId,
					panelInstanceId: params.panelInstanceId,
				},
				surface: {
					// `graph` (a chapter node's embedded dock) reports as `narrator-focus`:
					// both host exactly one narrator, and a new wire value would break
					// already-published plugins. Mirrors PluginUiRuntimeProvider.
					kind:
						sessionContext.surface === "focus" || sessionContext.surface === "graph"
							? ("narrator-focus" as const)
							: sessionContext.surface === "settings"
								? ("settings" as const)
								: sessionContext.surface,
					active: true,
					visible: true,
				},
				...(sessionContext.narratorId
					? {
							narrator: {
								id: sessionContext.narratorId,
								chapterId: sessionContext.chapterId,
								projectId: sessionContext.projectId,
							},
						}
					: {}),
				...(sessionContext.projectId ? { project: { id: sessionContext.projectId } } : {}),
				...(sessionContext.workspaceId
					? {
							workspace: {
								id: sessionContext.workspaceId,
								ownerNarratorId: sessionContext.narratorId,
								presentation: sessionContext.presentation ?? "grid",
							},
						}
					: {}),
				route: { routeId: window.location.pathname || "plugin-ui" },
			};
		},
		[colorScheme],
	);

	return (
		<PluginUiRuntimeProvider
			resolveContribution={resolvePluginUiContribution}
			getContext={getContext}
			onBackendRequest={requestPluginUiBackend}
		>
			{children}
		</PluginUiRuntimeProvider>
	);
}

/**
 * Apply the persisted plugin theme attribute before React mounts so the first
 * paint already reflects the user's choice (no flash of the default theme). The
 * actual CSS rules are injected by <PluginThemeInjector /> once the theme list
 * loads; setting the attribute early is cheap and safe even before the rules
 * exist.
 */
function applyInitialPluginTheme() {
	try {
		const key = readActivePluginThemeKey();
		if (key) document.documentElement.setAttribute("data-plugin-theme", key);
	} catch {
		// Ignore storage/DOM access failures.
	}
}

async function bootstrap() {
	applyInitialPluginTheme();
	// Before React mounts, so the first gesture on the first paint is already
	// covered. Safari in a browser tab ignores index.html's `user-scalable=no`, and
	// a component-level handler is structurally too late (see pinch-zoom-guard.ts).
	installPinchZoomGuard();
	const router = createAppRouter(createBrowserHistory());

	// Sweep focus-dock layouts unopened for >30 days (best-effort, never throws).
	cleanupStaleNarratorDockLayouts();

	await initI18n(getInitialNamespaces(window.location.pathname));
	void syncPluginUiContributions().catch(() => {});

	// biome-ignore lint/style/noNonNullAssertion: root element always exists
	ReactDOM.createRoot(document.getElementById("root")!, {
		/*
		 * Let the dev-only HMR guard see render errors an error boundary handled.
		 *
		 * Every route has a CatchBoundary (see `defaultErrorComponent` above), so a
		 * stale-module-graph failure inside a route becomes an error card and never
		 * reaches `window.onerror` — the guard's one-time reload would never fire.
		 *
		 * Supplying these options REPLACES React's default handlers, which are the
		 * ones that log to the console, so each handler logs explicitly to keep the
		 * error (and its component stack) visible in devtools.
		 */
		onCaughtError: (error, errorInfo) => {
			console.error(error, errorInfo?.componentStack ?? "");
			reportReactRenderError(error);
		},
		onUncaughtError: (error, errorInfo) => {
			console.error(error, errorInfo?.componentStack ?? "");
			reportReactRenderError(error);
		},
	}).render(
		<React.StrictMode>
			<MantineProvider
				theme={theme}
				defaultColorScheme="auto"
				cssVariablesResolver={v8CssVariablesResolver}
			>
				<DatesProvider settings={{ firstDayOfWeek: 1 }}>
					<ConfirmDialogProvider>
						<ImageViewerProvider>
							<AppNotifications />
							<QueryClientProvider client={queryClient}>
								<PluginThemeInjector />
								<PluginRuntimeShell>
									<React.Suspense
										fallback={
											<Center h="100vh">
												<Loader />
											</Center>
										}
									>
										<RouterProvider router={router} />
									</React.Suspense>
								</PluginRuntimeShell>
							</QueryClientProvider>
						</ImageViewerProvider>
					</ConfirmDialogProvider>
				</DatesProvider>
			</MantineProvider>
		</React.StrictMode>,
	);
}

void bootstrap();
