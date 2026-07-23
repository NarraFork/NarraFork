import "@frontend/lib/hmr-guard";
import "@frontend/lib/dom-mutation-guard";
import {
	Center,
	createTheme,
	Loader,
	MantineProvider,
	v8CssVariablesResolver,
} from "@mantine/core";
import "@mantine/core/styles.css";
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
	PluginUiRuntimeProvider,
	requestPluginUiBackend,
	resolvePluginUiContribution,
	syncPluginUiContributions,
} from "@frontend/components/plugins";
import { usePluginContributions } from "@frontend/hooks/usePluginContributions";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import "@frontend/styles/oled.css";
import "@frontend/styles/blur-anim.css";
import "@frontend/styles/nav-collapsed.css";
import "@frontend/styles/safe-area.css";

import { QueryClientProvider } from "@tanstack/react-query";
import {
	createBrowserHistory,
	createRouter,
	type RouterHistory,
	RouterProvider,
} from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { cleanupStaleNarratorDockLayouts } from "./components/narrator/dock/narrator-dock-layout";
import { recoverOrphanHistorySentinels } from "./lib/history-state";
import i18n, { getInitialNamespaces, initI18n } from "./lib/i18n";
import { queryClient } from "./lib/query-client";
import { routeTree } from "./routeTree.gen";

const theme = createTheme({
	primaryColor: "indigo",
	defaultRadius: "sm",
	components: {
		NavLink: {
			styles: {
				root: {
					borderTopLeftRadius: "var(--mantine-radius-sm)",
					borderTopRightRadius: "var(--mantine-radius-sm)",
					borderBottomLeftRadius: "var(--mantine-radius-sm)",
					borderBottomRightRadius: "var(--mantine-radius-sm)",
				},
			},
		},
	},
});

function createAppRouter(history: RouterHistory) {
	return createRouter({
		history,
		routeTree,
		context: { queryClient },
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
					kind:
						sessionContext.surface === "focus"
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

async function bootstrap() {
	const history = createBrowserHistory();
	await recoverOrphanHistorySentinels(history);
	const router = createAppRouter(history);

	// Sweep focus-dock layouts unopened for >30 days (best-effort, never throws).
	cleanupStaleNarratorDockLayouts();

	await initI18n(getInitialNamespaces(window.location.pathname));
	void syncPluginUiContributions().catch(() => {});

	// biome-ignore lint/style/noNonNullAssertion: root element always exists
	ReactDOM.createRoot(document.getElementById("root")!).render(
		<React.StrictMode>
			<MantineProvider
				theme={theme}
				defaultColorScheme="auto"
				cssVariablesResolver={v8CssVariablesResolver}
			>
				<ConfirmDialogProvider>
					<ImageViewerProvider>
						<AppNotifications />
						<QueryClientProvider client={queryClient}>
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
			</MantineProvider>
		</React.StrictMode>,
	);
}

void bootstrap();
