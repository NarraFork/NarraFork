import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/tiptap/styles.css";
import "@frontend/styles/mantine-slider-marks.css";
import "@frontend/styles/oled.css";
import "@frontend/styles/blur-anim.css";
import "@frontend/styles/scrollbars.css";
import "@frontend/styles/safe-area.css";
import "@frontend/styles/toast.css";
import "@frontend/styles/card-shimmer.css";
import "@frontend/styles/trace-shimmer.css";
import "@frontend/styles/vlist-touch-scroll-top.css";
import { CoreProviders } from "@frontend/components/CoreProviders";
import { initI18n } from "@frontend/lib/i18n";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { queryClient } from "@frontend/lib/query-client";
import { Loader } from "@mantine/core";
import { createBrowserHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { remoteRouteTree } from "./route-tree";

export async function mountApplication(element: HTMLElement): Promise<() => void> {
	await initI18n([
		"common",
		"errors",
		"remote",
		"projects",
		"narrator",
		"narrators",
		"settings",
		"nav",
		"terminal",
		"chat",
		"outline",
	]);
	const history = createBrowserHistory();
	const router = createRouter({
		routeTree: remoteRouteTree,
		history,
		basepath: "/",
		defaultPreload: false,
	});
	const root = createRoot(element);
	root.render(
		<CoreProviders>
			<Suspense fallback={<Loader />}>
				<RouterProvider router={router} />
			</Suspense>
		</CoreProviders>,
	);
	return () => {
		root.unmount();
		narratorWSManager.disconnect();
		void queryClient.cancelQueries();
		queryClient.clear();
		history.destroy();
	};
}
