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
import { Notifications } from "@mantine/notifications";
import "@mantine/notifications/styles.css";
import "@mantine/tiptap/styles.css";
import { ConfirmDialogProvider } from "@frontend/components/common/ConfirmDialogProvider";
import { ImageViewerProvider } from "@frontend/components/common/ImageViewerProvider";
import {
	PluginUiRuntimeProvider,
	requestPluginUiBackend,
	resolvePluginUiContribution,
	syncPluginUiContributions,
} from "@frontend/components/plugins";
import "@frontend/styles/oled.css";
import "@frontend/styles/blur-anim.css";
import "@frontend/styles/nav-collapsed.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { cleanupStaleNarratorDockLayouts } from "./components/narrator/dock/narrator-dock-layout";
import { getInitialNamespaces, initI18n } from "./lib/i18n";
import { queryClient } from "./lib/query-client";
import { Z } from "./lib/z-index";
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

const router = createRouter({
	routeTree,
	context: { queryClient },
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

async function bootstrap() {
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
						<Notifications position="top-right" zIndex={Z.toast} pauseResetOnHover="notification" />
						<QueryClientProvider client={queryClient}>
							<PluginUiRuntimeProvider
								resolveContribution={resolvePluginUiContribution}
								onBackendRequest={requestPluginUiBackend}
							>
								<React.Suspense
									fallback={
										<Center h="100vh">
											<Loader />
										</Center>
									}
								>
									<RouterProvider router={router} />
								</React.Suspense>
							</PluginUiRuntimeProvider>
						</QueryClientProvider>
					</ImageViewerProvider>
				</ConfirmDialogProvider>
			</MantineProvider>
		</React.StrictMode>,
	);
}

void bootstrap();
