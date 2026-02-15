import "@frontend/lib/i18n";
import { createTheme, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { Notifications } from "@mantine/notifications";
import "@mantine/notifications/styles.css";
import { registerSW } from "virtual:pwa-register";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { routeTree } from "./routeTree.gen";

const theme = createTheme({
	primaryColor: "indigo",
});

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 5_000,
			retry: 1,
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

const updateSW = registerSW({
	onNeedRefresh() {
		if (confirm("New version available. Reload to update?")) {
			updateSW(true);
		}
	},
	onOfflineReady() {
		console.log("App ready to work offline");
	},
});

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<MantineProvider theme={theme} defaultColorScheme="auto">
			<Notifications position="top-right" />
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</MantineProvider>
	</React.StrictMode>,
);
