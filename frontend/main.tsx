import "@frontend/lib/hmr-guard";
import { Center, createTheme, Loader, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { Notifications } from "@mantine/notifications";
import "@mantine/notifications/styles.css";
import { ConfirmDialogProvider } from "@frontend/components/common/ConfirmDialogProvider";
import "@frontend/styles/oled.css";
import "@frontend/styles/blur-anim.css";
import "@frontend/styles/nav-collapsed.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { getInitialNamespaces, initI18n } from "./lib/i18n";
import { queryClient } from "./lib/query-client";
import { routeTree } from "./routeTree.gen";

const theme = createTheme({
	primaryColor: "indigo",
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
	await initI18n(getInitialNamespaces(window.location.pathname));

	// biome-ignore lint/style/noNonNullAssertion: root element always exists
	ReactDOM.createRoot(document.getElementById("root")!).render(
		<React.StrictMode>
			<MantineProvider theme={theme} defaultColorScheme="auto">
				<ConfirmDialogProvider>
					<Notifications position="top-right" />
					<QueryClientProvider client={queryClient}>
						<React.Suspense
							fallback={
								<Center h="100vh">
									<Loader />
								</Center>
							}
						>
							<RouterProvider router={router} />
						</React.Suspense>
					</QueryClientProvider>
				</ConfirmDialogProvider>
			</MantineProvider>
		</React.StrictMode>,
	);
}

void bootstrap();
