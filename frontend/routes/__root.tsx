import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext } from "@tanstack/react-router";
import { RootErrorBoundary, RootLayout } from "../components/AppRootLayout";
import { ensureI18nNamespaces, getNamespacesForPath } from "../lib/i18n";

interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	beforeLoad: async ({ location }) => {
		await ensureI18nNamespaces(getNamespacesForPath(location.pathname));
	},
	component: RootLayout,
	errorComponent: RootErrorBoundary,
});
