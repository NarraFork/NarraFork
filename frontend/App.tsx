/**
 * The app's React tree, deliberately kept OUT of `main.tsx`.
 *
 * WHY THIS FILE EXISTS (it is not organisational taste)
 * ----------------------------------------------------
 * `@vitejs/plugin-react` makes a module a Fast Refresh boundary when it defines
 * components, and injects `import.meta.hot.accept` there. A boundary is only VALID
 * when every one of the module's exports is a component; otherwise the runtime calls
 * `hot.invalidate()`, which walks up to the next accepting importer — and for the
 * entry module there is none, so Vite falls back to a full page reload.
 *
 * `main.tsx` is the entry: it has to run bootstrap side effects (polyfills, i18n,
 * `createRoot`) at module scope, so it can never be a valid boundary. While the
 * provider tree lived there, `main.tsx` was both a boundary (it defined
 * `PluginRuntimeShell`) and permanently invalid as one, and it statically imported the
 * app's highest fan-in modules (`lib/query-client`, `lib/i18n`, `hooks/useBranding`,
 * `components/plugins`). Editing any of them propagated up to `main.tsx` and reloaded
 * the whole page:
 *
 *     hmr invalidate /main.tsx  Could not Fast Refresh ("true" export is incompatible)
 *     page reload main.tsx
 *
 * Measured before/after on the dev server: touching `hooks/useBranding.ts` went from a
 * full reload to `hot updated: /App.tsx`.
 *
 * ⚠️ KEEP THIS MODULE'S EXPORTS COMPONENT-ONLY. Adding a non-component export (a
 * helper, a constant, a hook) re-breaks the boundary and restores the full-reload
 * behaviour — with no error message, because the app still works. `app-hmr-boundary.test.ts`
 * asserts both halves of this invariant.
 */
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
import { createAppPluginHostLocal } from "@frontend/components/plugins/app-host-local";
import {
	handlePluginUiNotification,
	invalidatePluginModelQueries,
} from "@frontend/components/plugins/notifications";
import { useBranding } from "@frontend/hooks/useBranding";
import { usePluginContributions } from "@frontend/hooks/usePluginContributions";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import {
	Center,
	Loader,
	MantineProvider,
	useComputedColorScheme,
	v8CssVariablesResolver,
} from "@mantine/core";
import { DatesProvider } from "@mantine/dates";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, type RouterHistory, RouterProvider } from "@tanstack/react-router";
import React from "react";
import {
	RouteChunkErrorBoundary,
	RoutePendingIndicator,
} from "./components/common/RouteChunkErrorBoundary";
import { isPublicNarratorSharePath } from "./lib/app-path-classify";
import { getRouterBasepath } from "./lib/base-path";
import i18n from "./lib/i18n";
import { mantineTheme } from "./lib/mantine-theme";
import { queryClient } from "./lib/query-client";
import { routeTree } from "./routeTree.gen";

function createAppRouter(history: RouterHistory) {
	return createRouter({
		history,
		routeTree,
		/*
		 * The mount prefix, so routing works when the app is not at the origin root
		 * (a reverse-proxy subpath, or code-server's `/proxy/<port>/`).
		 *
		 * TanStack strips this from `location.pathname` before matching and adds it back
		 * when building hrefs. Omitting it makes the first navigation appear to work —
		 * the initial HTML came from the server — and then every `<Link>` writes a URL
		 * outside the prefix, landing on the proxy's root.
		 */
		basepath: getRouterBasepath(),
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

/**
 * Router type registration.
 *
 * Declared here rather than exported, because `Register` must be augmented exactly
 * once and this module owns `createAppRouter`. A `export type AppRouter` would also be
 * harmless for Fast Refresh (types are erased), but keeping the augmentation adjacent
 * to its source avoids a second file having to stay in sync.
 */
declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>;
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

	// Instance branding (tab title, favicon, PWA icon URLs). Mounted here rather
	// than in a route because it must apply on EVERY page including login — the
	// pre-login surfaces are where telling two instances apart matters most. The
	// endpoint is public, so this needs no session.
	useBranding();

	// WS reconnect → resync the contribution snapshot (the event stream is only
	// an invalidation signal; the HTTP response remains the payload of truth).
	React.useEffect(
		() =>
			narratorWSManager.onConnectionChange((connected, isReconnect) => {
				if (!connected) return;
				// Includes the first connection: startup discovery may finish between the initial
				// settings request and WS subscription, not only while reconnecting.
				invalidatePluginModelQueries(queryClient);
				if (isReconnect) void syncPluginUiContributions().catch(() => {});
			}),
		[],
	);

	// Lifecycle mutations in another tab are delivered as an invalidation marker;
	// refetch the bounded HTTP snapshot so every open panel converges quickly.
	React.useEffect(() => {
		const listener = narratorWSManager.addListener(
			{ types: ["plugin_contributions_changed", "plugin_provider_models_changed"] },
			(message) => {
				invalidatePluginModelQueries(queryClient);
				if (message.type === "plugin_contributions_changed") {
					invalidatePluginUiContributions();
					void queryClient.invalidateQueries({ queryKey: ["plugins", "ui-contributions"] });
				}
			},
		);
		return () => narratorWSManager.removeListener(listener);
	}, []);

	/*
	 * The scheme the app is ACTUALLY rendering in, not the one the OS prefers.
	 *
	 * This read used to be `matchMedia("(prefers-color-scheme: light)")`, which ignores the
	 * user's own choice: `MantineProvider` runs with `defaultColorScheme="auto"` and
	 * `ThemeSwitcher` lets them pin light or dark. Someone on a light OS who picks dark was
	 * therefore told `colorScheme: "light"` — the opposite of what they were looking at.
	 *
	 * `useComputedColorScheme` resolves `"auto"` to the value in effect, so the two always
	 * agree. No plugin consumed the field yet, which is exactly why the error had no symptom.
	 */
	const colorScheme = useComputedColorScheme("dark");

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

	// Host-local provider services (modelsChanged / models.test). Stable identity:
	// the object closes over the module-level queryClient and never changes.
	const appPluginHostLocal = React.useMemo(() => createAppPluginHostLocal({ queryClient }), []);

	return (
		<PluginUiRuntimeProvider
			resolveContribution={resolvePluginUiContribution}
			getContext={getContext}
			onBackendRequest={requestPluginUiBackend}
			hostLocal={appPluginHostLocal}
			onNotification={(_params, notification) =>
				handlePluginUiNotification(notification, queryClient)
			}
		>
			{children}
		</PluginUiRuntimeProvider>
	);
}

/**
 * The whole provider tree plus the router.
 *
 * The router is created in lazy `useState` state rather than at module scope so a Fast
 * Refresh of THIS module reuses the existing router (and therefore the current route,
 * scroll position and query cache) instead of constructing a second one. `history` is
 * owned by `main.tsx`, which does not re-run on HMR.
 */
export function App({ history }: { history: RouterHistory }) {
	const [router] = React.useState(() => createAppRouter(history));
	// History lives outside RouterProvider. Subscribe here so both cold opens and
	// client-side navigation unmount the authenticated plugin hosts before a share renders.
	const subscribe = React.useCallback((notify: () => void) => history.subscribe(notify), [history]);
	const isPublicShare = React.useSyncExternalStore(
		subscribe,
		() => isPublicNarratorSharePath(history.location.pathname, getRouterBasepath()),
		() => false,
	);
	const routeContent = (
		<React.Suspense
			fallback={
				<Center h="100vh">
					<Loader />
				</Center>
			}
		>
			<RouterProvider router={router} />
		</React.Suspense>
	);

	return (
		<MantineProvider
			theme={mantineTheme}
			defaultColorScheme="auto"
			cssVariablesResolver={v8CssVariablesResolver}
		>
			<DatesProvider settings={{ firstDayOfWeek: 1 }}>
				<ConfirmDialogProvider>
					<ImageViewerProvider>
						{!isPublicShare && <AppNotifications />}
						<QueryClientProvider client={queryClient}>
							{isPublicShare ? (
								routeContent
							) : (
								<>
									<PluginThemeInjector />
									<PluginRuntimeShell>{routeContent}</PluginRuntimeShell>
								</>
							)}
						</QueryClientProvider>
					</ImageViewerProvider>
				</ConfirmDialogProvider>
			</DatesProvider>
		</MantineProvider>
	);
}
