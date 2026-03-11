import "@frontend/lib/hmr-guard";
import "@frontend/lib/i18n";
import { createTheme, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { Notifications } from "@mantine/notifications";
import "@mantine/notifications/styles.css";
import "@frontend/styles/oled.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
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

// biome-ignore lint/style/noNonNullAssertion: root element always exists
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
